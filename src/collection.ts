import type { Database as LMDBDatabase, RangeIterable } from "lmdb"
import {
	TypedEventEmitter,
	type CollectionEvents,
	type Document,
	type FindOptions,
	type IdGenerator,
} from "./types.js"
import {
	ConstraintError,
	TransactionError,
	UnknownError,
	ValidationError,
} from "./errors.js"

/**

 *
 * @template T The document type stored in the collection.
 * @extends TypedEventEmitter<CollectionEvents<T>>
 * @event document.inserted Fired when a document is inserted.
 * @event documents.inserted Fired when multiple documents are inserted.
 * @event document.updated Fired when a document is updated.
 * @event documents.updated Fired when multiple documents are updated.
 * @event document.removed Fired when a document is removed.
 * @event documents.removed Fired when multiple documents are removed.
 * @event document.upserted Fired when a document is upserted.
 * @event documents.upserted Fired when multiple documents are upserted.
 * @event collection.closed Fired when the collection is closed.
 */
export class Collection<T extends Document> extends TypedEventEmitter<
	CollectionEvents<T> & { "collection.closed": { name: string } }
> {
	private readonly db: LMDBDatabase<T, string>
	public readonly committed: Promise<boolean>
	public readonly flushed: Promise<boolean>
	private readonly idGenerator: IdGenerator
	private readonly logger?: (msg: string) => void

	private readonly name: string

	get rootDb(): LMDBDatabase<T, string> {
		return this.db
	}
	constructor(
		db: LMDBDatabase<T, string>,
		options: {
			name: string
			idGenerator: IdGenerator
			logger?: (msg: string) => void
		}
	) {
		super()
		this.db = db
		this.name = options.name
		this.idGenerator = options.idGenerator
		this.committed = this.db.committed
		this.flushed = this.db.flushed
		this.logger = options.logger
	}

	/**
	 * Retrieves a single document by ID.
	 *
	 * @param {string} id The ID of the document to retrieve.
	 * @returns {T | null} The retrieved document or `null` if not found.
	 * @throws {UnknownError} If an unexpected error occurs during the operation.
	 */
	get(id: string): T | null {
		try {
			const value = this.db.get(id)
			return value ?? null // Return null if undefined
		} catch (error) {
			const errorMsg = `Get operation failed for document ID ${id}: ${error instanceof Error ? error.message : String(error)}`
			this.logger?.(errorMsg)
			throw new UnknownError(errorMsg, { original: error })
		}
	}

	/**
	 * Checks if a document exists.
	 *
	 * @param {string} id The ID of the document to check.
	 * @param {number} [version] Optional version to check for existence.
	 * @returns {boolean} `true` if the document exists, otherwise `false`.
	 * @throws {UnknownError} If an unexpected error occurs during the operation.
	 */
	doesExist(id: string, version?: number): boolean {
		try {
			return version ? this.db.doesExist(id, version) : this.db.doesExist(id)
		} catch (error) {
			const errorMsg = `Existence check failed for document ID ${id}: ${error instanceof Error ? error.message : String(error)}`
			this.logger?.(errorMsg)
			throw new UnknownError(errorMsg, { original: error })
		}
	}

	/**
	 * Prefetches documents into memory.
	 *
	 * @param {string[]} ids The IDs of the documents to prefetch.
	 * @returns {Promise<void>} Resolves when the prefetch operation is successful.
	 * @throws {UnknownError} If an unexpected error occurs during the operation.
	 */
	async prefetch(ids: string[]): Promise<void> {
		try {
			await this.db.prefetch(ids)
		} catch (error) {
			const errorMsg = `Prefetch operation failed for document IDs ${JSON.stringify(ids)}: ${error instanceof Error ? error.message : String(error)}`
			this.logger?.(errorMsg)
			throw new UnknownError(errorMsg, { original: error })
		}
	}

	/**
	 * Retrieves multiple documents by their IDs.
	 *
	 * @param {string[]} ids The IDs of the documents to retrieve.
	 * @returns {Promise<(T | null)[]>} Resolves to an array of documents or null for missing entries.
	 * @throws {UnknownError} If an unexpected error occurs during the operation.
	 */
	async getMany(ids: string[]): Promise<(T | null)[]> {
		try {
			const values = await this.db.getMany(ids)
			return values.map((value) => value ?? null)
		} catch (error) {
			const errorMsg = `GetMany operation failed for document IDs ${JSON.stringify(ids)}: ${error instanceof Error ? error.message : String(error)}`
			this.logger?.(errorMsg)
			throw new UnknownError(errorMsg, { original: error })
		}
	}

	/**
	 * Finds documents matching the provided conditions.
	 *
	 * @param {FindOptions<T>} options Options for the query, including `where` conditions.
	 * @returns {RangeIterable<T>} A lazy iterable over the matching documents.
	 * @throws {UnknownError} If an error occurs during the find operation.
	 */
	find(options: FindOptions<T> = {}): RangeIterable<T> {
		this.logger?.(
			`Starting find operation with options: ${JSON.stringify(options)}`
		)

		try {
			// Initialize the range query with RangeOptions
			const query = this.db.getRange({
				...options,
				snapshot: options.snapshot ?? true,
			})

			// Apply `where` if provided
			if (options.where) {
				return query
					.map(({ value }) => value)
					.filter((entry) => options.where?.(entry))
			}

			// Transform the query to only return the values
			return query.map(({ value }) => value)
		} catch (error) {
			const errorMsg = `Find operation failed: ${
				error instanceof Error ? error.message : String(error)
			}`
			this.logger?.(errorMsg)
			throw new UnknownError(errorMsg, { original: error })
		}
	}

	/**
	 * Finds a single document matching the given condition.
	 *
	 * @param {Pick<FindOptions<T>, "where">} options Options containing the `where` condition.
	 * @returns {T | null} The matching document, or null if no match is found.
	 * @throws {UnknownError} If an error occurs while searching for a document.
	 */
	findOne(options: Pick<FindOptions<T>, "where">): T | null {
		this.logger?.(
			`Starting findOne operation with options: ${JSON.stringify(options)}`
		)

		try {
			// Use `find` to retrieve documents with the `where` clause
			const range = this.find({ where: options.where })

			// Iterate through the range and return the first match
			for (const value of range) {
				this.logger?.(`Found matching document: ${JSON.stringify(value)}`)
				return value
			}

			this.logger?.("No matching document found")
			return null
		} catch (error) {
			const errorMsg = `FindOne operation failed: ${
				error instanceof Error ? error.message : String(error)
			}`
			this.logger?.(errorMsg)
			throw new UnknownError(errorMsg, { original: error })
		}
	}

	/**
	 * Inserts a new document into the database.
	 *
	 * @param {Omit<T, "_id">} doc The document to insert, excluding the `_id` field.
	 * @returns {Promise<T>} The inserted document with the `_id` field included.
	 * @throws {ValidationError} If the document is invalid or cannot be processed.
	 * @throws {UnknownError} If an unexpected error occurs during the insert operation.
	 * @fires Collection#document.inserted
	 */
	async insert(doc: Omit<T, "_id">): Promise<T> {
		try {
			// Generate a unique ID for the document
			const _id = this.idGenerator()

			// Combine the new ID with the document
			const document = { ...doc, _id } as T

			// Attempt to insert the document into the database
			await this.db.put(_id, document)

			this.logger?.(`Document inserted successfully with ID: ${_id}`)

			// Emit the "document.inserted" event
			this.emit("document.inserted", { document })

			return document
		} catch (error) {
			const errorMsg = `Insert operation failed: ${
				error instanceof Error ? error.message : String(error)
			}`
			this.logger?.(errorMsg)

			if (error instanceof TypeError || error instanceof SyntaxError) {
				// Create a ValidationError without fields since they're irrelevant here
				throw new ValidationError(errorMsg, { original: error })
			}

			throw new UnknownError(errorMsg, { original: error })
		}
	}

	/**
	 * Inserts multiple documents into the database.
	 *
	 * @param {Array<Omit<T, "_id">>} docs The array of documents to insert, excluding the `_id` field.
	 * @returns {Promise<T[]>} The array of inserted documents with `_id` fields included.
	 * @throws {TransactionError} If the transaction fails or verification fails.
	 * @throws {UnknownError} If an unexpected error occurs during the insert operation.
	 * @fires Collection#documents.inserted
	 */
	async insertMany(docs: Array<Omit<T, "_id">>): Promise<T[]> {
		this.logger?.("Starting insertMany operation")

		try {
			return await this.transaction<T[]>(() => {
				const results: T[] = []

				// Insert all documents
				for (const doc of docs) {
					const _id = this.idGenerator()
					const document = { ...doc, _id } as T
					this.db.put(_id, document)
					this.logger?.(`Inserted document: ${JSON.stringify(document)}`)
					results.push(document)
				}

				// Verify inserts
				for (const doc of results) {
					const verify = this.get(doc._id)

					if (!verify) {
						const errorMsg = `Failed to verify insert for document with ID ${doc._id}`
						this.logger?.(errorMsg)
						throw new TransactionError(errorMsg)
					}
				}

				// Emit the "documents.inserted" event
				this.emit("documents.inserted", { documents: results })

				return results
			})
		} catch (error) {
			const errorMsg = `InsertMany operation failed: ${
				error instanceof Error ? error.message : String(error)
			}`
			this.logger?.(errorMsg)

			if (error instanceof TransactionError) {
				throw error
			}

			throw new UnknownError(errorMsg, { original: error })
		}
	}

	/**
	 * Updates an existing document or inserts a new one if it doesn't exist.
	 *
	 * @param {Pick<FindOptions<T>, "where">} options The options to find the existing document.
	 * @param {Omit<T, "_id">} doc The document to insert or update.
	 * @returns {Promise<T>} The inserted or updated document.
	 * @throws {TransactionError} If the transaction fails.
	 * @throws {UnknownError} If an unexpected error occurs during the operation.
	 * @fires Collection#document.upserted
	 */
	async upsert(
		options: Pick<FindOptions<T>, "where">,
		doc: Omit<T, "_id">
	): Promise<T> {
		return await this.transaction(() => {
			// Perform the query to find the existing document
			const range = this.find({ where: options.where })
			const existing = range.asArray[0] // Only need the first matching document

			if (existing) {
				// Update the document
				const updated = { ...existing, ...doc }
				this.db.put(updated._id, updated) // No need to catch; LMDB handles transaction errors

				// Emit the "document.upserted" event with wasInsert = false
				this.emit("document.upserted", {
					document: updated,
					wasInsert: false,
				})

				return updated
			}

			// Insert the document if it doesn't exist
			const _id = this.idGenerator()
			const newDocument = { ...doc, _id } as T
			this.db.put(_id, newDocument) // Insert new document

			// Emit the "document.upserted" event with wasInsert = true
			this.emit("document.upserted", {
				document: newDocument,
				wasInsert: true,
			})

			return newDocument
		})
	}

	/**
	 * Updates multiple documents or inserts them if they don't exist.
	 *
	 * @param {Array<{ where: FindOptions<T>["where"]; doc: Omit<T, "_id"> }>} operations The array of operations to perform.
	 * @returns {Promise<T[]>} The array of inserted or updated documents.
	 * @throws {TransactionError} If the transaction fails.
	 * @throws {UnknownError} If an unexpected error occurs during the operation.
	 * @fires Collection#documents.upserted
	 */
	async upsertMany(
		operations: Array<{ where: FindOptions<T>["where"]; doc: Omit<T, "_id"> }>
	): Promise<T[]> {
		return await this.transaction(() => {
			const results: T[] = []
			let insertCount = 0
			let updateCount = 0

			for (const op of operations) {
				// Perform a find operation to locate the existing document
				const range = this.find({ where: op.where })
				const existing = range.asArray[0] // Only the first match is relevant

				if (existing) {
					// Update the document
					const updated = { ...existing, ...op.doc }
					this.db.put(updated._id, updated)
					results.push(updated)
					updateCount++
				} else {
					// Insert a new document
					const _id = this.idGenerator()
					const newDoc = { ...op.doc, _id } as T
					this.db.put(_id, newDoc)
					results.push(newDoc)
					insertCount++
				}
			}

			// Emit the "documents.upserted" event
			this.emit("documents.upserted", {
				documents: results,
				insertCount,
				updateCount,
			})

			return results
		})
	}

	/**
	 * Updates a single document matching the filter.
	 *
	 * @param {Pick<FindOptions<T>, "where">} options The options to find the document to update.
	 * @param {Partial<Omit<T, "_id">>} update The update payload.
	 * @returns {Promise<T | null>} The updated document, or null if no matching document is found.
	 * @throws {TransactionError} If the transaction fails.
	 * @throws {UnknownError} If an unexpected error occurs.
	 * @fires Collection#document.updated
	 */
	async updateOne(
		options: Pick<FindOptions<T>, "where">,
		update: Partial<Omit<T, "_id">>
	): Promise<T | null> {
		this.logger?.(`Starting updateOne with options: ${JSON.stringify(options)}`)
		this.logger?.(`Update payload: ${JSON.stringify(update)}`)

		return await this.transaction(() => {
			const range = this.find({ where: options.where })
			const existing = range.asArray[0] // Get the first matching document

			if (!existing) {
				this.logger?.("No document found to update")
				return null // Indicate no update occurred
			}

			const updatedDoc = { ...existing, ...update }

			try {
				this.db.put(updatedDoc._id, updatedDoc)
			} catch (error) {
				throw new TransactionError(
					`Failed to update document with ID ${updatedDoc._id}`,
					{ original: error }
				)
			}

			// Emit the "document.updated" event
			this.emit("document.updated", { old: existing, new: updatedDoc })

			this.logger?.(`Successfully updated document with ID ${updatedDoc._id}`)

			return updatedDoc
		})
	}

	/**
	 * Updates all documents that match the filter.
	 *
	 * @param {Pick<FindOptions<T>, "where">} options The options to find the documents to update.
	 * @param {Partial<Omit<T, "_id">>} update The update payload.
	 * @returns {Promise<number>} The number of documents updated.
	 * @throws {TransactionError} If the transaction fails.
	 * @throws {ValidationError} If a document is missing a required `_id` field.
	 * @throws {UnknownError} If an unexpected error occurs.
	 * @fires Collection#documents.updated
	 */
	async updateMany(
		options: Pick<FindOptions<T>, "where">,
		update: Partial<Omit<T, "_id">>
	): Promise<number> {
		this.logger?.(
			`Starting updateMany with options: ${JSON.stringify(options)}`
		)
		this.logger?.(`Update payload: ${JSON.stringify(update)}`)

		return await this.transaction(() => {
			const range = this.find({ where: options.where })
			const documents = range.asArray

			if (documents.length === 0) {
				this.logger?.("No documents found to update")
				return 0 // No updates performed
			}

			let modifiedCount = 0

			for (const doc of documents) {
				if (!doc._id) {
					throw new ValidationError("Updated document must have an _id", {
						field: "_id",
					})
				}

				const updatedDoc = { ...doc, ...update }

				try {
					this.db.put(doc._id, updatedDoc)
					modifiedCount++
				} catch (error) {
					throw new TransactionError(
						`Failed to update document with ID ${doc._id}`,
						{ original: error }
					)
				}
			}

			this.logger?.(`Updated ${modifiedCount} documents`)

			// Emit the "documents.updated" event
			this.emit("documents.updated", { count: modifiedCount })

			return modifiedCount
		})
	}

	/**
	 * Removes a single document that matches the filter.
	 *
	 * @param {Pick<FindOptions<T>, "where">} options The options to find the document to remove.
	 * @returns {Promise<boolean>} True if a document was removed, otherwise false.
	 * @throws {TransactionError} If the transaction fails.
	 * @throws {UnknownError} If an unexpected error occurs.
	 * @fires Collection#document.removed
	 */
	async removeOne(options: Pick<FindOptions<T>, "where">): Promise<boolean> {
		this.logger?.(
			`Starting removeOne operation with options: ${JSON.stringify(options)}`
		)

		return await this.transaction(() => {
			const range = this.find({ where: options.where })
			const [doc] = range.asArray

			if (!doc) {
				this.logger?.("No document found to match the given filter.")
				return false // No document to remove
			}

			this.logger?.(`Found document with ID: ${doc._id}. Preparing to remove.`)

			try {
				this.db.remove(doc._id)
				this.logger?.(`Document with ID ${doc._id} removed from the database.`)
			} catch (error) {
				const errorMsg = `Failed to remove document with ID ${doc._id}.`
				this.logger?.(errorMsg)
				throw new TransactionError(errorMsg, { original: error })
			}

			// Verify removal
			const verify = this.get(doc._id)
			if (verify) {
				const errorMsg = `Failed to verify removal of document with ID ${doc._id}. Document still exists.`
				this.logger?.(errorMsg)
				throw new TransactionError(errorMsg)
			}

			this.logger?.(
				`Successfully removed and verified document with ID: ${doc._id}`
			)

			// Emit the "document.removed" event
			this.emit("document.removed", { document: doc })

			return true
		})
	}

	/**
	 * Removes all documents that match the provided filter.
	 *
	 * @param {Pick<FindOptions<T>, "where">} options The options to find the documents to remove.
	 * @returns {Promise<number>} The number of documents removed.
	 * @throws {TransactionError} If the transaction fails.
	 * @throws {UnknownError} If an unexpected error occurs.
	 * @fires Collection#documents.removed
	 */
	async removeMany(options: Pick<FindOptions<T>, "where">): Promise<number> {
		this.logger?.(
			`Starting removeMany operation with options: ${JSON.stringify(options)}`
		)

		return await this.transaction(() => {
			const range = this.find({ where: options.where })
			const documents = range.asArray

			let removedCount = 0

			for (const doc of documents) {
				if (!doc._id) {
					throw new ValidationError("Document is missing _id field", {
						field: "_id",
					})
				}

				try {
					this.db.remove(doc._id)
					removedCount++
				} catch (error) {
					throw new TransactionError(
						`Failed to remove document with ID ${doc._id}`,
						{ original: error }
					)
				}
			}

			this.logger?.(`Successfully removed ${removedCount} document(s).`)

			// Emit the "documents.removed" event
			this.emit("documents.removed", { count: removedCount })

			return removedCount
		})
	}

	/**
	 * Executes an action only if the document with the given ID does not exist.
	 *
	 * @param {string} id The ID of the document to check.
	 * @param {() => R} action The action to execute if the document does not exist.
	 * @returns {Promise<R>} The result of the action if the document does not exist.
	 * @throws {ConstraintError} If the document already exists.
	 * @throws {TransactionError} If the conditional write fails.
	 * @throws {UnknownError} If an unexpected error occurs.
	 */
	async ifNoExists<R>(id: string, action: () => R): Promise<R> {
		try {
			const success = await this.db.ifNoExists(id, () => {
				try {
					return action()
				} catch (error) {
					this.logger?.(
						`Action execution failed: ${error instanceof Error ? error.message : String(error)}`
					)
					throw error // Re-throw the error to propagate it out of the callback
				}
			})

			if (!success) {
				throw new ConstraintError(
					`Operation aborted - document with ID ${id} already exists`,
					{
						constraint: "unique_key",
					}
				)
			}

			return success as R
		} catch (error) {
			if (error instanceof ConstraintError) {
				throw error // Re-throw if it's a known constraint error
			}

			if (error instanceof Error) {
				this.logger?.(`Transaction failed: ${error.message}`)
				throw new TransactionError(
					`ifNoExists operation failed for document ID ${id}`,
					{
						original: error,
					}
				)
			}

			throw new UnknownError(
				`An unknown error occurred during ifNoExists operation for document ID ${id}`,
				{
					original: error,
				}
			)
		}
	}

	/**
	 * Executes a transaction.
	 *
	 * @param {() => R} action The action to execute within the transaction.
	 * @returns {Promise<R>} The result of the transaction.
	 * @throws {TransactionError} If the transaction fails or is aborted.
	 * @throws {UnknownError} If an unexpected error occurs during the transaction.
	 */
	async transaction<R>(action: () => R): Promise<R> {
		try {
			return await this.db.transaction(async () => {
				const actionResult = action()

				if (!actionResult) {
					throw new TransactionError("Transaction action returned no result.")
				}

				return actionResult
			})
		} catch (error) {
			if (error instanceof TransactionError) {
				this.logger?.(`Transaction failed: ${error.message}`)
				throw error
			}

			const errorMsg = `Transaction failed unexpectedly: ${
				error instanceof Error ? error.message : String(error)
			}`

			this.logger?.(errorMsg)
			throw new UnknownError(errorMsg, { original: error })
		}
	}

	/**
	 * Closes the collection and releases associated resources.
	 *
	 * @returns {Promise<void>} Resolves when the collection has been closed.
	 * @throws {UnknownError} If an unexpected error occurs during the close operation.
	 * @fires Collection#collection.closed
	 */
	async close(): Promise<void> {
		this.logger?.(`Closing collection: ${this.name}`)
		try {
			await this.db.close()
			this.emit("collection.closed", { name: this.name })
			this.logger?.(`Collection "${this.name}" closed successfully.`)
		} catch (error) {
			const errorMsg = `Failed to close collection "${this.name}": ${error instanceof Error ? error.message : String(error)}`
			this.logger?.(errorMsg)
			throw new UnknownError(errorMsg, { original: error })
		}
	}
}
