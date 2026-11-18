import { z } from 'zod/mini';

import { readBrowserRecord, readBrowserRecords, updateBrowserRecords } from '@/sync/domains/state/browserRecordStorage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * The device copy of an Account's daemon projection section bodies (the plugin
 * catalogue: package, Agent, Action, Resource, Settings-field and contribution
 * declarations; never Session content, setting values or secrets), so a page
 * reload reads the Machine's manifest and only the bodies whose digests it
 * does not already hold. Bodies are content-addressed: a digest never names
 * different bytes, so a held body needs no other freshness check.
 *
 * One Account per Home: storing for another Account on the same Home deletes
 * the previous Account's bodies, and signing out deletes them
 * (`forgetDaemonProjectionSectionStore`). Each Home keeps only the bodies its
 * Machines' latest manifests use.
 *
 * Web only: the store is the app's IndexedDB record owner. Native processes
 * have no IndexedDB, and their in-memory section pool already outlives
 * navigation; the measured cost is the web page reload.
 */
function hasDeviceStore(): boolean {
    return typeof indexedDB !== 'undefined';
}

export type DaemonProjectionSectionStore = Readonly<{
    /** The stored bodies for these digests; the reader verifies each digest. */
    read(digests: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>>;
    /** Records the bodies a Machine's admitted manifest used, storing those read from the Machine. */
    retain(params: Readonly<{
        projectionDigest: string;
        used: readonly string[];
        fetched: ReadonlyMap<string, readonly string[]>;
    }>): Promise<void>;
}>;

const PREFIX = 'daemon-projection-sections-v1:';

const IndexSchema = z.object({
    v: z.literal(1),
    accountId: z.string(),
    targets: z.record(z.string(), z.object({ projectionDigest: z.string(), digests: z.array(z.string()) })),
    stored: z.array(z.string()),
});
type SectionStoreIndex = z.infer<typeof IndexSchema>;
const BodySchema = z.array(z.string());

function indexKey(serverId: string): string {
    return `${PREFIX}${encodeURIComponent(serverId)}`;
}

function bodyKey(serverId: string, accountId: string, digest: string): string {
    return `${PREFIX}${encodeURIComponent(serverId)}:${encodeURIComponent(accountId)}:${digest}`;
}

function parseJson<T>(raw: string | undefined, schema: z.ZodMiniType<T>): T | null {
    if (raw === undefined) return null;
    try {
        const parsed = schema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

let failureReported = false;
function reportFailure(operation: 'read' | 'retain' | 'forget'): void {
    if (failureReported) return;
    failureReported = true;
    // One diagnostic per process, without Account ids, digests or storage error prose.
    console.warn('[projection-sections] Device storage failed; reading sections from the Machine.', { operation });
}

// One Home's operations run in order, so a reader after a store sees it.
const queues = new Map<string, Promise<unknown>>();
function enqueue<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    const run = (queues.get(serverId) ?? Promise.resolve()).then(operation, operation);
    const settled = run.then(() => undefined, () => undefined);
    queues.set(serverId, settled);
    void settled.then(() => { if (queues.get(serverId) === settled) queues.delete(serverId); });
    return run;
}

async function readIndex(serverId: string): Promise<SectionStoreIndex | null> {
    return parseJson(await readBrowserRecord(indexKey(serverId)), IndexSchema);
}

export function openDaemonProjectionSectionStore(scope: ServerAccountScope, targetKey: string): DaemonProjectionSectionStore | null {
    if (!hasDeviceStore()) return null;
    const { serverId, accountId } = scope;
    return Object.freeze({
        read: (digests) => enqueue(serverId, async () => {
            const keys = digests.map(digest => bodyKey(serverId, accountId, digest));
            const records = await readBrowserRecords([indexKey(serverId), ...keys]);
            const index = parseJson(records.get(indexKey(serverId)), IndexSchema);
            const bodies = new Map<string, readonly string[]>();
            if (index?.accountId !== accountId) return bodies;
            const stored = new Set(index.stored);
            for (const digest of digests) {
                const body = stored.has(digest) ? parseJson(records.get(bodyKey(serverId, accountId, digest)), BodySchema) : null;
                if (body) bodies.set(digest, body);
            }
            return bodies;
        }).catch(() => { reportFailure('read'); return new Map<string, readonly string[]>(); }),
        retain: ({ projectionDigest, used, fetched }) => enqueue(serverId, async () => {
            const previous = await readIndex(serverId);
            const previousKeys = (previous?.stored ?? []).map(digest => bodyKey(serverId, previous!.accountId, digest));
            const fetchedKeys = [...fetched.keys()].map(digest => bodyKey(serverId, accountId, digest));
            await updateBrowserRecords([indexKey(serverId), ...previousKeys, ...fetchedKeys], current => {
                const included = new Set(current.keys());
                const index = parseJson(current.get(indexKey(serverId)), IndexSchema);
                const sameAccount = index?.accountId === accountId;
                const targets = sameAccount ? { ...index.targets } : {};
                const prior = targets[targetKey];
                targets[targetKey] = { projectionDigest,
                    digests: prior?.projectionDigest === projectionDigest ? [...new Set([...prior.digests, ...used])] : [...used] };
                const referenced = new Set(Object.values(targets).flatMap(target => target.digests));
                const values = new Map<string, string | undefined>();
                const stored = new Set<string>();
                for (const digest of index?.stored ?? []) {
                    const key = bodyKey(serverId, index!.accountId, digest);
                    if (sameAccount && referenced.has(digest)) stored.add(digest);
                    else if (included.has(key)) values.set(key, undefined);
                    // A body another tab stored after this read stays listed until the next store.
                    else if (sameAccount) stored.add(digest);
                }
                for (const [digest, body] of fetched) {
                    if (!referenced.has(digest)) continue;
                    values.set(bodyKey(serverId, accountId, digest), JSON.stringify(body));
                    stored.add(digest);
                }
                values.set(indexKey(serverId), JSON.stringify({ v: 1, accountId, targets, stored: [...stored] } satisfies SectionStoreIndex));
                return { values, result: undefined };
            });
        }).catch(() => reportFailure('retain')),
    });
}

/** Signing out forgets this Account's stored sections on its Home. */
export function forgetDaemonProjectionSectionStore(scope: ServerAccountScope): Promise<void> {
    if (!hasDeviceStore()) return Promise.resolve();
    const { serverId, accountId } = scope;
    return enqueue(serverId, async () => {
        const previous = await readIndex(serverId);
        if (previous?.accountId !== accountId) return;
        const keys = previous.stored.map(digest => bodyKey(serverId, accountId, digest));
        await updateBrowserRecords([indexKey(serverId), ...keys], current => {
            const index = parseJson(current.get(indexKey(serverId)), IndexSchema);
            if (index?.accountId !== accountId) return { values: new Map(), result: undefined };
            return { values: new Map([indexKey(serverId), ...keys].map(key => [key, undefined])), result: undefined };
        });
    }).catch(() => reportFailure('forget'));
}
