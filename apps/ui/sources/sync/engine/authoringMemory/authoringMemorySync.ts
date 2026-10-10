import { assertAuthoringMemoryValueForKeyV1, buildProjectLastOpenedMemoryKeyV1, parseProjectLastOpenedMemoryKeyV1, ProjectLastOpenedMemoryValueV1Schema, AuthoringMemoryEngineSelectionsV1Schema, StoredAuthoringMemoryEngineSelectionsV1Schema, type ProjectLastOpenedMemoryAnchorV1, type AuthoringMemoryContentV1, type AuthoringMemoryValueV1 } from '@happier-dev/protocol/account/authoringMemory';
import { LegacyRecentMachinePathsSchema, LegacyLastUsedProfileSchema, LegacyRememberedEngineSelectionsByScopeV1Schema } from '@happier-dev/protocol/account/settings/legacyAuthoringMemorySettingsV1';
import { importAuthoringMemoryRowAbsent, importLegacyAuthoringMemorySetting } from '@happier-dev/protocol/account/authoringMemoryImport';
import type { AuthoringMemoryCipher } from '@/sync/encryption/authoringMemoryEncryption';
import {
    normalizeRememberedEngineSelectionScopeKey,
    type RememberedEngineSelectionsByScopeV1,
} from '@/sync/domains/session/authoring/rememberedEngineSelections';
import { mergeCurrentRememberedEngineSelectionsIntoRaw } from '@/sync/domains/settings/sessionAuthoringSelectionPersistence';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import type { AuthoringMemory } from '@/sync/store/domains/authoringMemory';

export type AuthoringMemoryRow = Readonly<{ key: string; revision: number; content: AuthoringMemoryContentV1 | null }>;
export type AuthoringMemoryTransport = Readonly<{
    list(): Promise<Readonly<{ rows: readonly AuthoringMemoryRow[] }>>;
    read(key: string): Promise<
        | Readonly<{ status: 'absent' }>
        | Readonly<{ status: 'deleted'; revision: number }>
        | Readonly<{ status: 'present'; revision: number; content: AuthoringMemoryContentV1 }>
    >;
    mutate(key: string, expectedRevision: number | 'absent', content: AuthoringMemoryContentV1 | null): Promise<
        | Readonly<{ status: 'updated'; revision: number; cursor: number }>
        | Readonly<{ status: 'conflict'; revision: number }>
    >;
}>;
type MemoryDelta = Partial<Pick<AuthoringMemory, 'recentMachinePaths' | 'lastUsedProfile' | 'lastEngineSelectionsByScopeV1'>>;
export type AuthoringMemoryDelta = Partial<Pick<AuthoringMemory, 'recentMachinePaths' | 'lastUsedProfile'>> & Readonly<{
    lastUsedProfileReplacement?: Readonly<{ base: string | null; proposed: string | null }>;
    rememberedEngineSelectionReplacement?: Readonly<{
        base: RememberedEngineSelectionsByScopeV1;
        proposed: RememberedEngineSelectionsByScopeV1;
    }>;
}>;

export function createAuthoringMemorySync(options: Readonly<{
    transport: AuthoringMemoryTransport;
    cipher: AuthoringMemoryCipher;
    isCurrent(): boolean;
    apply(delta: MemoryDelta): void;
    /** The same captured source used by bootstrap; replacement intents may arrive after it. */
    legacySettings?: LegacyAuthoringMemorySettingsPort;
    onProjectLastOpenedChanged?(anchor: ProjectLastOpenedMemoryAnchorV1, timestamp: number | undefined): void;
}>) {
    const values = new Map<string, AuthoringMemoryValueV1>();
    const revisions = new Map<string, number>();
    const refreshes = new Map<string, Promise<void>>();
    let bootstrapInFlight: Promise<void> | null = null;
    let bootstrapped = false;
    let writes: Promise<void> = Promise.resolve();
    function assertCurrent() {
        if (!options.isCurrent()) throw new Error('Authoring memory Account/Home scope retired');
    }
    function engineRow(key: string, value: AuthoringMemoryValueV1) {
        const row = StoredAuthoringMemoryEngineSelectionsV1Schema.parse(value);
        const scope = key.slice('engineSelection:'.length);
        for (const rawScope of Object.keys(row.selectionsByScope)) {
            if ((normalizeRememberedEngineSelectionScopeKey(rawScope.trim()) ?? rawScope) !== scope) {
                throw new Error('Authoring memory selection row scope mismatch');
            }
        }
        return row.selectionsByScope;
    }
    function engineProjection() {
        return Object.fromEntries([...values]
            .filter(([key]) => key.startsWith('engineSelection:'))
            .flatMap(([key, value]) => Object.entries(engineRow(key, value))));
    }
    function applyKey(key: string, value: AuthoringMemoryValueV1 | undefined) {
        assertCurrent();
        if (key === 'recentMachinePaths') options.apply({ recentMachinePaths: LegacyRecentMachinePathsSchema.parse(value ?? []) });
        else if (key === 'lastUsedProfile') options.apply({ lastUsedProfile: LegacyLastUsedProfileSchema.parse(value ?? null) });
        else if (key.startsWith('engineSelection:')) {
            options.apply({ lastEngineSelectionsByScopeV1: engineProjection() });
        } else {
            const anchor = parseProjectLastOpenedMemoryKeyV1(key);
            if (anchor) options.onProjectLastOpenedChanged?.(anchor, value === undefined ? undefined : ProjectLastOpenedMemoryValueV1Schema.parse(value));
        }
    }
    function observe(row: AuthoringMemoryRow) {
        assertCurrent();
        if ((revisions.get(row.key) ?? -1) > row.revision) return;
        const value = row.content === null ? undefined : options.cipher.open(row.key, row.content);
        revisions.set(row.key, row.revision);
        if (value === undefined) values.delete(row.key); else values.set(row.key, value);
        applyKey(row.key, value);
    }
    async function refresh(key: string): Promise<void> {
        assertCurrent();
        const existing = refreshes.get(key);
        if (existing) return await existing;
        const task = (async () => {
            const row = await options.transport.read(key);
            assertCurrent();
            if (row.status === 'present') observe({ key, revision: row.revision, content: row.content });
            else if (row.status === 'deleted') observe({ key, revision: row.revision, content: null });
            else { values.delete(key); revisions.delete(key); applyKey(key, undefined); }
        })();
        refreshes.set(key, task);
        try { await task; } finally { if (refreshes.get(key) === task) refreshes.delete(key); }
    }
    async function bootstrap(): Promise<void> {
        assertCurrent();
        if (bootstrapped) return;
        if (!bootstrapInFlight) bootstrapInFlight = (async () => {
            const snapshot = await options.transport.list();
            assertCurrent();
            // Decode all rows before publishing any snapshot, so a locked row
            // cannot turn an unreadable Account into a partial default projection.
            const opened = snapshot.rows.map((row) => {
                const value = row.content === null ? undefined : options.cipher.open(row.key, row.content);
                if (value !== undefined && row.key.startsWith('engineSelection:')) engineRow(row.key, value);
                return { row, value };
            });
            assertCurrent();
            for (const { row, value } of opened) {
                if ((revisions.get(row.key) ?? -1) > row.revision) continue;
                revisions.set(row.key, row.revision);
                if (value === undefined) values.delete(row.key); else values.set(row.key, value);
            }
            options.apply({
                recentMachinePaths: LegacyRecentMachinePathsSchema.parse(values.get('recentMachinePaths') ?? []),
                lastUsedProfile: LegacyLastUsedProfileSchema.parse(values.get('lastUsedProfile') ?? null),
                lastEngineSelectionsByScopeV1: engineProjection(),
            });
            for (const [key, value] of values) {
                if (parseProjectLastOpenedMemoryKeyV1(key)) applyKey(key, value);
            }
            bootstrapped = true;
        })();
        try { await bootstrapInFlight; } finally { bootstrapInFlight = null; }
    }
    async function importAbsent(key: string, value: unknown) {
        const row = await importAuthoringMemoryRowAbsent({
            key, value: assertAuthoringMemoryValueForKeyV1(key, value), assertCurrent,
            read: options.transport.read, mutate: options.transport.mutate, seal: options.cipher.seal,
        });
        if (row.status === 'present') observe({ key, revision: row.revision, content: row.content });
        else if (row.status === 'deleted') observe({ key, revision: row.revision, content: null });
        return row;
    }
    async function write(key: string, select: (winner: AuthoringMemoryValueV1 | undefined) => AuthoringMemoryValueV1 | undefined) {
        while (true) {
            await refresh(key);
            const winner = values.get(key);
            const proposed = select(winner);
            if (areAccountSettingsJsonValuesEqual(winner, proposed)) return;
            const content = proposed === undefined ? null : options.cipher.seal(key, proposed);
            assertCurrent();
            const result = await options.transport.mutate(key, revisions.get(key) ?? 'absent', content);
            assertCurrent();
            if (result.status === 'updated') { observe({ key, revision: result.revision, content }); return; }
            // Reconcile against the next canonical CAS winner, with no second retry budget.
        }
    }
    async function applyDelta(delta: AuthoringMemoryDelta): Promise<void> {
        assertCurrent();
        const task = writes.then(async () => {
            await bootstrap();
            if (delta.recentMachinePaths !== undefined) await write('recentMachinePaths', () => assertAuthoringMemoryValueForKeyV1('recentMachinePaths', delta.recentMachinePaths));
            if (delta.lastUsedProfile !== undefined) await write('lastUsedProfile', () => delta.lastUsedProfile!);
            if (delta.lastUsedProfileReplacement) {
                const intent = delta.lastUsedProfileReplacement;
                if (options.legacySettings) {
                    // A bootstrap that observed absence cannot retire a source
                    // written later. Transfer that source through the existing
                    // absence-only owner before comparing the current winner.
                    await importLegacyAuthoringMemorySetting({ key: 'lastUsedProfile', assertCurrent,
                        read: options.legacySettings.read, remove: options.legacySettings.remove,
                        transfer: async value => { await importAbsent('lastUsedProfile', LegacyLastUsedProfileSchema.parse(value)); },
                    });
                }
                await write('lastUsedProfile', (winner) => (winner ?? null) === intent.base ? intent.proposed : winner);
            }
            const intent = delta.rememberedEngineSelectionReplacement;
            if (!intent) return;
            for (const scope of new Set([...Object.keys(intent.base), ...Object.keys(intent.proposed)])) {
                if (normalizeRememberedEngineSelectionScopeKey(scope) !== scope) continue;
                if (areAccountSettingsJsonValuesEqual(intent.base[scope], intent.proposed[scope])) continue;
                const key = `engineSelection:${scope}`;
                await write(key, (winner) => {
                    const merged = mergeCurrentRememberedEngineSelectionsIntoRaw({
                        rawSelections: winner === undefined ? {} : engineRow(key, winner),
                        currentSelections: intent.base[scope] === undefined ? {} : { [scope]: intent.base[scope] },
                        nextSelections: intent.proposed[scope] === undefined ? {} : { [scope]: intent.proposed[scope] },
                    });
                    return Object.keys(merged).length === 0 ? undefined
                        : AuthoringMemoryEngineSelectionsV1Schema.parse({ v: 1, selectionsByScope: merged });
                });
            }
        });
        writes = task.catch(() => {});
        await task;
    }
    function readProjectLastOpened(anchor: ProjectLastOpenedMemoryAnchorV1): number | undefined {
        assertCurrent();
        const value = values.get(buildProjectLastOpenedMemoryKeyV1(anchor));
        return value === undefined ? undefined : ProjectLastOpenedMemoryValueV1Schema.parse(value);
    }
    async function writeProjectLastOpened(anchor: ProjectLastOpenedMemoryAnchorV1, timestamp: number): Promise<void> {
        const key = buildProjectLastOpenedMemoryKeyV1(anchor);
        const value = ProjectLastOpenedMemoryValueV1Schema.parse(timestamp);
        assertCurrent();
        const task = writes.then(async () => {
            await bootstrap();
            await write(key, () => value);
        });
        writes = task.catch(() => {});
        await task;
    }
    return { bootstrap, refresh, importAbsent, applyDelta, readProjectLastOpened, writeProjectLastOpened, assertCurrent };
}

export type LegacyAuthoringMemorySettingsPort = Readonly<{
    read(): Promise<Readonly<{ raw: Record<string, unknown> | null; version: number }>>;
    remove(key: string, expectedVersion: number): Promise<'applied' | 'conflict' | 'outcomeUnknown'>;
}>;

/** Destination-first transfer. Tombstones count as existing rows and never revive legacy memory. */
export async function importLegacyAuthoringMemory(options: Readonly<{
    owner: ReturnType<typeof createAuthoringMemorySync>;
    settings: LegacyAuthoringMemorySettingsPort;
}>): Promise<void> {
    for (const key of ['recentMachinePaths', 'lastUsedProfile', 'lastEngineSelectionsByScopeV1'] as const) {
        await importLegacyAuthoringMemorySetting({
            key, assertCurrent: options.owner.assertCurrent,
            read: options.settings.read, remove: options.settings.remove,
            transfer: async (legacyValue) => {
                if (key === 'lastEngineSelectionsByScopeV1') {
                    const raw = LegacyRememberedEngineSelectionsByScopeV1Schema.parse(legacyValue);
                    const grouped = new Map<string, Record<string, AuthoringMemoryValueV1>>();
                    for (const [rawScope, value] of Object.entries(raw)) {
                        // Unknown future scopes remain opaque at their original identity;
                        // recognized scopes pass through the incumbent canonicalizer.
                        const scope = normalizeRememberedEngineSelectionScopeKey(rawScope.trim()) ?? rawScope;
                        const entries = grouped.get(scope) ?? {};
                        entries[rawScope] = value;
                        grouped.set(scope, entries);
                    }
                    for (const [scope, selectionsByScope] of grouped) {
                        await options.owner.importAbsent(`engineSelection:${scope}`, { v: 1, selectionsByScope });
                    }
                } else {
                    const value = key === 'recentMachinePaths'
                        ? LegacyRecentMachinePathsSchema.parse(legacyValue)
                        : LegacyLastUsedProfileSchema.parse(legacyValue);
                    await options.owner.importAbsent(key, value);
                }
            },
        });
    }
}

/** Called after a durable Profile removal ACK; retire its legacy selection before conditional clearing. */
export async function clearRemovedProfileAuthoringMemory(options: Readonly<{
    owner: ReturnType<typeof createAuthoringMemorySync>;
    settings: LegacyAuthoringMemorySettingsPort;
    id: string;
}>): Promise<void> {
    await importLegacyAuthoringMemorySetting({
        key: 'lastUsedProfile', assertCurrent: options.owner.assertCurrent,
        read: options.settings.read, remove: options.settings.remove,
        transfer: async value => {
            await options.owner.importAbsent('lastUsedProfile', LegacyLastUsedProfileSchema.parse(value));
        },
    });
    await options.owner.applyDelta({ lastUsedProfileReplacement: { base: options.id, proposed: null } });
}
