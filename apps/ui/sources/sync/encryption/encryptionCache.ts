import { AgentState, Metadata, MachineMetadata } from '../domains/state/storageTypes';
import { DecryptedMessage } from '../domains/state/storageTypes';
import { loadSyncTuning } from '../runtime/syncTuning';

interface CacheEntry<T> {
    data: T;
    accessTime: number;
}

type MessageCacheEntry = CacheEntry<DecryptedMessage> & {
    fingerprint: string;
    sessionId: string | null;
    bytes: number;
};

export type EncryptionCacheOptions = Readonly<{
    maxMessageBytes?: number;
}>;

/**
 * In-memory cache for decrypted session data to avoid expensive re-decryption
 * Uses sessionId + version as keys for agent state and metadata
 * Uses messageId + ciphertext fingerprint for messages (streaming can reuse ids)
 */
export class EncryptionCache {
    private agentStateCache = new Map<string, CacheEntry<AgentState>>();
    private metadataCache = new Map<string, CacheEntry<Metadata>>();
    private messageCache = new Map<string, MessageCacheEntry>();
    private machineMetadataCache = new Map<string, CacheEntry<MachineMetadata>>();
    private daemonStateCache = new Map<string, CacheEntry<any>>();
    private messageBytes = 0;
    /**
     * Recency ticket. `Date.now()` cannot order a batch: hundreds of decrypted messages
     * land inside one millisecond, every entry ties, and "least recently used" collapses
     * into "whatever iterated first" — which is how a warm re-open evicted the very
     * messages it had just cached. A counter is exact, monotonic, and costs nothing.
     */
    private accessTicket = 0;

    // Configuration
    private readonly maxAgentStates = 1000;
    private readonly maxMetadata = 1000;
    /**
     * Messages have NO entry cap. `maxMessageBytes` already bounds the resource that
     * matters, and a 1000-entry cap fired an order of magnitude earlier — so a single
     * ordinary transcript evicted every other session's decrypted content and re-opening
     * any of them paid full decryption again.
     *
     * The other caches keep their caps: they are keyed by `id:version`, so a stuck writer
     * could mint unbounded distinct keys for one subject. Messages are keyed by message id
     * and are naturally bounded by the transcripts actually retained.
     */
    private readonly maxMachineMetadata = 500;
    private readonly maxDaemonStates = 500;
    private readonly maxMessageBytes: number;

    constructor(options: EncryptionCacheOptions = {}) {
        const configuredBudget = options.maxMessageBytes ?? loadSyncTuning().encryptionCacheMessageByteBudget;
        this.maxMessageBytes = Math.max(1, Math.trunc(configuredBudget));
    }

    /**
     * Get cached agent state for a session
     */
    getCachedAgentState(sessionId: string, version: number): AgentState | null {
        const key = `${sessionId}:${version}`;
        const entry = this.agentStateCache.get(key);
        if (entry) {
            this.touch(this.agentStateCache, key, entry);
            return entry.data;
        }
        return null;
    }

    /**
     * Cache agent state for a session
     */
    setCachedAgentState(sessionId: string, version: number, data: AgentState): void {
        const key = `${sessionId}:${version}`;
        this.agentStateCache.set(key, {
            data,
            accessTime: ++this.accessTicket
        });
        
        // Evict if over limit
        this.evictOldest(this.agentStateCache, this.maxAgentStates);
    }

    /**
     * Get cached metadata for a session
     */
    getCachedMetadata(sessionId: string, version: number): Metadata | null {
        const key = `${sessionId}:${version}`;
        const entry = this.metadataCache.get(key);
        if (entry) {
            this.touch(this.metadataCache, key, entry);
            return entry.data;
        }
        return null;
    }

    /**
     * Cache metadata for a session
     */
    setCachedMetadata(sessionId: string, version: number, data: Metadata): void {
        const key = `${sessionId}:${version}`;
        this.metadataCache.set(key, {
            data,
            accessTime: ++this.accessTicket
        });
        
        // Evict if over limit
        this.evictOldest(this.metadataCache, this.maxMetadata);
    }

    /**
     * Get cached decrypted message
     */
    getCachedMessage(messageId: string, fingerprint: string): DecryptedMessage | null {
        const entry = this.messageCache.get(messageId);
        if (entry) {
            if (entry.fingerprint !== fingerprint) {
                return null;
            }
            this.touch(this.messageCache, messageId, entry);
            return entry.data;
        }
        return null;
    }

    /**
     * Cache decrypted message
     */
    setCachedMessage(messageId: string, data: DecryptedMessage, fingerprint: string, sessionId?: string | null): void {
        const previous = this.messageCache.get(messageId);
        if (previous) {
            this.messageBytes -= previous.bytes;
        }
        const bytes = estimateDecryptedMessageBytes(data);
        this.messageCache.delete(messageId);
        this.messageCache.set(messageId, {
            data,
            accessTime: ++this.accessTicket,
            fingerprint,
            sessionId: normalizeSessionCacheId(sessionId),
            bytes,
        });
        this.messageBytes += bytes;
        
        // Bounded by bytes only — see `maxMessageBytes`.
        this.evictOldestMessagesToByteBudget();
    }

    /**
     * Get cached machine metadata
     */
    getCachedMachineMetadata(machineId: string, version: number): MachineMetadata | null {
        const key = `${machineId}:${version}`;
        const entry = this.machineMetadataCache.get(key);
        if (entry) {
            this.touch(this.machineMetadataCache, key, entry);
            return entry.data;
        }
        return null;
    }

    /**
     * Cache machine metadata
     */
    setCachedMachineMetadata(machineId: string, version: number, data: MachineMetadata): void {
        const key = `${machineId}:${version}`;
        this.machineMetadataCache.set(key, {
            data,
            accessTime: ++this.accessTicket
        });
        
        // Evict if over limit
        this.evictOldest(this.machineMetadataCache, this.maxMachineMetadata);
    }

    /**
     * Get cached daemon state
     */
    getCachedDaemonState(machineId: string, version: number): any | undefined {
        const key = `${machineId}:${version}`;
        const entry = this.daemonStateCache.get(key);
        if (entry) {
            this.touch(this.daemonStateCache, key, entry);
            return entry.data;
        }
        return undefined;
    }

    /**
     * Cache daemon state (including null values)
     */
    setCachedDaemonState(machineId: string, version: number, data: any): void {
        const key = `${machineId}:${version}`;
        this.daemonStateCache.set(key, {
            data,
            accessTime: ++this.accessTicket
        });
        
        // Evict if over limit
        this.evictOldest(this.daemonStateCache, this.maxDaemonStates);
    }

    /**
     * Clear all cache entries for a specific machine
     */
    clearMachineCache(machineId: string): void {
        // Clear machine metadata and daemon state for this machine (all versions)
        for (const key of this.machineMetadataCache.keys()) {
            if (key.startsWith(`${machineId}:`)) {
                this.machineMetadataCache.delete(key);
            }
        }
        
        for (const key of this.daemonStateCache.keys()) {
            if (key.startsWith(`${machineId}:`)) {
                this.daemonStateCache.delete(key);
            }
        }
    }

    /**
     * Clear all cache entries for a specific session
     */
    clearSessionCache(sessionId: string): void {
        // Clear agent state and metadata for this session (all versions)
        for (const key of this.agentStateCache.keys()) {
            if (key.startsWith(`${sessionId}:`)) {
                this.agentStateCache.delete(key);
            }
        }
        
        for (const key of this.metadataCache.keys()) {
            if (key.startsWith(`${sessionId}:`)) {
                this.metadataCache.delete(key);
            }
        }
        
        // Decrypted message objects can be large and are tied to the transcript
        // owner that materialized them, so session release must drop them too.
        for (const [key, entry] of this.messageCache.entries()) {
            if (entry.sessionId === sessionId) {
                this.messageCache.delete(key);
                this.messageBytes -= entry.bytes;
            }
        }
        this.messageBytes = Math.max(0, this.messageBytes);
    }

    /**
     * Clear all cached data
     */
    clearAll(): void {
        this.agentStateCache.clear();
        this.metadataCache.clear();
        this.messageCache.clear();
        this.messageBytes = 0;
        this.machineMetadataCache.clear();
        this.daemonStateCache.clear();
    }

    /**
     * Get cache statistics for debugging
     */
    getStats() {
        return {
            agentStates: this.agentStateCache.size,
            metadata: this.metadataCache.size,
            messages: this.messageCache.size,
            messageBytes: this.messageBytes,
            machineMetadata: this.machineMetadataCache.size,
            daemonStates: this.daemonStateCache.size,
            totalEntries: this.agentStateCache.size + this.metadataCache.size + this.messageCache.size + 
                         this.machineMetadataCache.size + this.daemonStateCache.size
        };
    }

    /**
     * Evict oldest entries when cache exceeds limit (LRU eviction)
     */
    private evictOldest<TEntry extends Readonly<{ accessTime: number }>>(
        cache: Map<string, TEntry>,
        maxSize: number,
    ): TEntry | null {
        if (cache.size <= maxSize) {
            return null;
        }

        // Find oldest entry by access time
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        
        for (const [key, entry] of cache.entries()) {
            if (entry.accessTime < oldestTime) {
                oldestTime = entry.accessTime;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            const oldestEntry = cache.get(oldestKey);
            cache.delete(oldestKey);
            return oldestEntry ?? null;
        }
        return null;
    }

    /**
     * Marks an entry as most-recently-used. Re-inserting moves it to the END of the Map,
     * so insertion order and LRU order are the same thing and the least-recently-used
     * entry is always simply the first — no scan to find it.
     */
    private touch<TEntry extends { accessTime: number }>(
        cache: Map<string, TEntry>,
        key: string,
        entry: TEntry,
    ): void {
        entry.accessTime = ++this.accessTicket;
        cache.delete(key);
        cache.set(key, entry);
    }

    /**
     * Sheds to the byte budget in one pass.
     *
     * This used to call `evictOldestMessage(size - 1)` in a loop, and each of those ran a
     * full O(size) scan to find its victim — quadratic in the number of entries displaced,
     * exactly when a large transcript is streaming in. Insertion order is LRU order now,
     * so the victim is the first key and each eviction is O(1).
     */
    private evictOldestMessagesToByteBudget(): void {
        while (this.messageBytes > this.maxMessageBytes && this.messageCache.size > 1) {
            const oldestKey = this.messageCache.keys().next().value;
            if (oldestKey === undefined) return;
            const evicted = this.messageCache.get(oldestKey);
            this.messageCache.delete(oldestKey);
            if (evicted) this.messageBytes = Math.max(0, this.messageBytes - evicted.bytes);
        }
    }
}

function normalizeSessionCacheId(sessionId: string | null | undefined): string | null {
    const normalized = String(sessionId ?? '').trim();
    return normalized || null;
}

function estimateDecryptedMessageBytes(message: DecryptedMessage): number {
    try {
        return JSON.stringify(message).length;
    } catch {
        return 1024;
    }
}
