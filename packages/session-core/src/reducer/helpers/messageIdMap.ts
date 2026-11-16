/**
 * The reducer's `originalId -> internalId` map, with its inverse kept beside it: for each internal
 * message id, the first original id (in insertion order) that maps to it. Route ids are resolved
 * per rendered row and per navigation source, so a scan of every mapping per lookup made those
 * costs grow with the loaded transcript length.
 *
 * Writes stay ordinary `Map` writes at the reducer phases. A new key extends the inverse; an
 * upsert that changes a key's internal id, a delete or a clear drops it, and the next lookup
 * rebuilds it in one pass, so the inverse is always exactly what the scan would return.
 */
export class ReducerMessageIdMap extends Map<string, string> {
    private origins: Map<string, string> | null = null;

    override set(originalId: string, internalId: string): this {
        const had = super.has(originalId);
        const previous = had ? super.get(originalId) : undefined;
        super.set(originalId, internalId);
        if (this.origins) {
            if (had) {
                if (previous !== internalId) this.origins = null;
            } else if (!this.origins.has(internalId)) {
                this.origins.set(internalId, originalId);
            }
        }
        return this;
    }

    override delete(originalId: string): boolean {
        this.origins = null;
        return super.delete(originalId);
    }

    override clear(): void {
        this.origins = null;
        super.clear();
    }

    /** The first original id mapped to this internal id, or null. */
    originOf(internalId: string): string | null {
        if (!this.origins) {
            const origins = new Map<string, string>();
            for (const [originalId, mappedInternalId] of super.entries()) {
                if (!origins.has(mappedInternalId)) origins.set(mappedInternalId, originalId);
            }
            this.origins = origins;
        }
        return this.origins.get(internalId) ?? null;
    }
}
