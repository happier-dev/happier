import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod/mini';
import { TrashEntryV1Schema, type HappierStorageCategoryIdV1, type StorageReasonV1, type TrashEntryV1 } from '@happier-dev/protocol/storage/storageV1';
import { StrictJsonValueSchema, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { RequesterWorkAttributionV1Schema } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
import type { MachineGuardActivityEntryV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import type { ActivityLog } from '@/daemon/guard/activityLog';
import { logger } from '@/ui/logger';
import { physicalStoragePathWithoutFollowingLeaf, storageAbsolutePath, storagePathContains, storagePathDirname,
    storagePathJoin, storagePathLeaf, storagePathsEqual, storagePathToFs } from '../storagePath';
import { ensureProtectedLocalStateDirectory, readProtectedLocalStateFile, verifyProtectedLocalStatePath, writeProtectedLocalStateFileAtomic } from '@/utils/fs/protectedLocalState';
import { measureNativeDisk } from '../measure/nativeDiskMeasure';
import { assertStoragePathIdentity, readStoragePathIdentity, removeStoragePath, type StoragePathIdentity } from './removeStoragePath';
import { renameStoragePathNoReplace } from './renameStoragePath';

const execute = promisify(execFile);
const component = z.string().check(z.regex(/^[A-Za-z0-9_-]+$/u));
const identitySchema = z.strictObject({ dev: z.string().check(z.minLength(1)), ino: z.string().check(z.minLength(1)), kind: z.enum(['file', 'directory', 'symlink', 'other']) });
const manifestSchema = z.strictObject({ v: z.literal(1), entry: TrashEntryV1Schema, identity: identitySchema,
    phase: z.enum(['prepared', 'moved', 'emptying', 'restoring']), ownerData: z.optional(StrictJsonValueSchema),
    restorePath: z.optional(z.string()), attribution: z.union([RequesterWorkAttributionV1Schema, z.strictObject({ kind: z.literal('unknown') })]),
    emptyAttribution: z.optional(z.union([RequesterWorkAttributionV1Schema, z.strictObject({ kind: z.literal('unknown') })])),
    restoreAttribution: z.optional(z.union([RequesterWorkAttributionV1Schema, z.strictObject({ kind: z.literal('unknown') })])),
    movedReceiptRecorded: z._default(z.boolean(), false), emptiedReceiptRecorded: z._default(z.boolean(), false),
});
const storedManifestSchema = createStoredReadSchema(manifestSchema);
type Attribution = MachineGuardActivityEntryV1['attribution'];
export type TrashSelection = Readonly<{ entryIds?: readonly string[]; batchId?: string; volumeId?: string }>;
export type TrashEntryAuthorityCheck = (entry: TrashEntryV1, ownerData?: JsonValue) => Promise<void>;
export type TrashOwnerAdapter = Readonly<{
    requiresIdle?: boolean;
    retire?(input: Readonly<{ payloadPath: string; beforeEffect?: () => Promise<void> }>): Promise<void>;
    reinstate(input: Readonly<{ payloadPath: string; restorePath: string; beforeEffect?: () => Promise<void> }>): Promise<void>;
    discard(input: Readonly<{ payloadPath: string; beforeEffect?: () => Promise<void> }>): Promise<void>;
}>;
export type TrashStoreDeps = Readonly<{
    happyHomeDir: string; osUserId: string; target: Readonly<{ machineId: string; serverId?: string }>;
    readVolumes(): readonly Readonly<{ id: string; mount: string }>[];
    activityLog: Pick<ActivityLog, 'append' | 'read' | 'markUndone'>;
    attributionFor(accountId: string): Attribution;
    classifyRestorePath(path: string): Promise<StorageReasonV1 | null>;
    readEmptyAfterDays(): number | null;
    resolveOwnerAdapter?(categoryId: HappierStorageCategoryIdV1 | undefined, ownerData: JsonValue): Promise<TrashOwnerAdapter> | TrashOwnerAdapter;
    nowMs?: () => number;
}>;
export type TrashPrepareInput = Readonly<{
    path: string; batchId: string; title: string; categoryId?: HappierStorageCategoryIdV1;
    size: TrashEntryV1['size']; movedBy: TrashEntryV1['movedBy']; identity?: StoragePathIdentity; ownerData?: JsonValue;
    restorable?: boolean;
    assertCurrentAuthority?: () => Promise<void>;
}>;
export type TrashPreparedEntry = Readonly<{
    entry: TrashEntryV1; payloadPath: string;
    commit(retire?: (input: Readonly<{ sourcePath: string; payloadPath: string; beforeEffect?: () => Promise<void> }>) => Promise<void>): Promise<TrashEntryV1>;
}>;
export async function resolveTrashOsUserId(): Promise<string> {
    if (process.platform !== 'win32') return String(process.getuid!());
    const { stdout } = await execute(join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'whoami.exe'),
        ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.match(/\bS-\d(?:-\d+)+\b/u)?.[0];
    if (!sid) throw Object.assign(new Error('Windows user SID unavailable'), { code: 'trash_identity_unavailable' });
    return sid;
}

export function createTrashStore(deps: TrashStoreDeps) {
    component.parse(deps.osUserId);
    const now = deps.nowMs ?? Date.now;
    const listeners = new Set<() => void>();
    const activePreparations = new Set<string>();
    const notify = () => { for (const listener of listeners) listener(); };
    let pending: Promise<unknown> = Promise.resolve();
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = pending.then(operation); pending = result.catch(() => {}); return result;
    };
    const contains = storagePathContains;
    const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
    async function present(path: string) { try { await lstat(storagePathToFs(path)); return true; } catch (error) { if (missing(error)) return false; throw error; } }
    async function roots() {
        const home = await realpath(deps.happyHomeDir);
        const volumes = deps.readVolumes();
        const homeVolume = volumes.filter(volume => contains(volume.mount, home)).sort((a, b) => b.mount.length - a.mount.length)[0];
        return volumes.map(volume => ({ volumeId: volume.id, mountPath: volume.mount,
            path: volume.id === homeVolume?.id ? join(home, 'trash') : process.platform === 'win32'
                ? join(volume.mount, '.happier-trash', deps.osUserId) : join(volume.mount, `.happier-trash-${deps.osUserId}`) }));
    }
    async function ensureRoot(root: Awaited<ReturnType<typeof roots>>[number]) {
        const mount = await readStoragePathIdentity(root.mountPath);
        if (mount.kind !== 'directory') throw Object.assign(new Error('Volume unavailable'), { code: 'trash_volume_unavailable' });
        await ensureProtectedLocalStateDirectory(root.path);
        if ((await readStoragePathIdentity(root.path)).dev !== mount.dev) throw Object.assign(new Error('Trash volume mismatch'), { code: 'trash_volume_mismatch' });
        if (process.platform === 'win32' && !storagePathsEqual(root.path, join(await realpath(deps.happyHomeDir), 'trash'))) {
            await execute(join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'attrib.exe'), ['+H', '+S', root.path], { windowsHide: true });
        }
    }
    async function rootFor(path: string) {
        const physical = await physicalStoragePathWithoutFollowingLeaf(storageAbsolutePath(path));
        const root = (await roots()).filter(value => contains(value.mountPath, physical)).sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
        if (!root) throw Object.assign(new Error('Item volume unavailable'), { code: 'trash_volume_unavailable' });
        await ensureRoot(root); return root;
    }
    async function load(root: Awaited<ReturnType<typeof roots>>[number], entryId: string) {
        component.parse(entryId);
        await verifyProtectedLocalStatePath(root.path, 'directory');
        const directory = join(root.path, entryId);
        await verifyProtectedLocalStatePath(directory, 'directory');
        const manifest = storedManifestSchema.parse(JSON.parse(await readProtectedLocalStateFile(join(directory, 'entry.json'))) as unknown);
        const originalPath = storagePathToFs(manifest.entry.originalPath);
        if (manifest.entry.entryId !== entryId || manifest.entry.volumeId !== root.volumeId || typeof originalPath === 'string' && !isAbsolute(originalPath)) {
            throw Object.assign(new Error('Trash manifest identity mismatch'), { code: 'trash_manifest_invalid' });
        }
        return { root, directory, manifest, payloadPath: join(directory, 'payload') };
    }
    type Record = Awaited<ReturnType<typeof load>>;
    async function records(selection: TrashSelection = {}): Promise<Record[]> {
        const result: Record[] = [];
        for (const root of await roots()) {
            if (selection.volumeId && selection.volumeId !== root.volumeId || !await present(root.path)) continue;
            await verifyProtectedLocalStatePath(root.path, 'directory');
            for (const entryId of await readdir(root.path)) {
                if (activePreparations.has(entryId)) continue;
                if (!component.safeParse(entryId).success || selection.entryIds && !selection.entryIds.includes(entryId)) continue;
                try {
                    const record = await load(root, entryId);
                    if (!selection.batchId || selection.batchId === record.manifest.entry.batchId) result.push(record);
                } catch (error) {
                    // An interrupted prepare can leave a directory without a manifest.
                    // Keep unknown bytes untouched: without the manifest neither owner
                    // authority nor safe recovery can be established for this entry.
                    logger.warnLocalFile('[storage/trash] Retaining unreadable entry', { volumeId: root.volumeId, entryId, error });
                }
            }
        }
        return result;
    }
    async function save(record: Record) {
        await writeProtectedLocalStateFileAtomic(join(record.directory, 'entry.json'), JSON.stringify(manifestSchema.parse(record.manifest)));
    }
    async function cleanup(record: Record, beforeEffect?: () => Promise<void>) {
        await beforeEffect?.(); await unlink(join(record.directory, 'entry.json'));
        await rmdir(record.directory);
    }
    async function measure(record: Record) {
        const measured = await measureNativeDisk({ paths: [record.payloadPath] });
        const value = measured.perPath[0]!;
        record.manifest.entry.size = { allocatedBytes: value.allocatedBytes, freesBytes: value.exclusiveBytes,
            sharedBytes: value.sharedBytes, sharedExtentsUnmeasured: value.sharedExtentsUnmeasured, atLeast: value.atLeast,
            ...(value.freesUpToBytes === undefined ? {} : { freesUpToBytes: value.freesUpToBytes }) };
        return measured.totalExclusiveBytes;
    }
    async function receipt(record: Record, kind: 'trash_moved' | 'trash_emptied', freedBytes: number, beforeEffect?: () => Promise<void>) {
        const flag = kind === 'trash_moved' ? 'movedReceiptRecorded' : 'emptiedReceiptRecorded';
        if (record.manifest[flag]) return;
        const id = `${record.manifest.entry.entryId}-${kind}`;
        if (await deps.activityLog.read(id)) { await beforeEffect?.(); record.manifest[flag] = true; await save(record); return; }
        const entry = record.manifest.entry;
        await beforeEffect?.();
        await deps.activityLog.append({ v: 1, id, at: now(), kind, rule: 'approved_proposal', outcome: 'done',
            subject: { kind: 'trash', items: 1 }, attribution: kind === 'trash_emptied' ? record.manifest.emptyAttribution ?? record.manifest.attribution : record.manifest.attribution,
            freedBytes, inTrashBytes: kind === 'trash_moved' ? entry.size.allocatedBytes : 0,
            ...(kind === 'trash_emptied' ? { ref: `${entry.entryId}-trash_moved` } : {}),
            ...(kind === 'trash_moved' ? { wayBack: [{ label: 'undo' as const, actionId: 'machines.storage.trash.restore' as const,
                input: { ...deps.target, entryIds: [entry.entryId] } }, { label: 'empty_now' as const, actionId: 'machines.storage.trash.empty' as const,
                input: { ...deps.target, entryIds: [entry.entryId] } }] } : {}),
        });
        record.manifest[flag] = true;
        await beforeEffect?.();
        await save(record);
    }
    async function restoredReceipt(record: Record, beforeEffect?: () => Promise<void>) {
        const ref = `${record.manifest.entry.entryId}-trash_moved`;
        if ((await deps.activityLog.read(ref))?.undoneAt !== undefined) return;
        await beforeEffect?.();
        await deps.activityLog.markUndone({ id: `${record.manifest.entry.entryId}-restored`, at: now(), ref,
            attribution: record.manifest.restoreAttribution ?? { kind: 'unknown' } });
    }
    function failure(error: unknown): { status: 'refused' | 'failed'; reason: StorageReasonV1 } {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'destination_occupied' || code === 'unauthorized' || code === 'changed_since_review' || code === 'in_use') return { status: 'refused', reason: { code } };
        if (['owner_unavailable', 'owner_data_invalid', 'restore_unsupported', 'restore_path_unsupported'].includes(code ?? '')) {
            return { status: 'refused', reason: { code: 'unsupported', detail: { cause: code! } } };
        }
        return { status: 'failed', reason: { code: 'operation_failed', ...(code ? { detail: { cause: code } } : {}) } };
    }
    return {
        roots,
        refreshRetention(days: number | null, input: Readonly<{ beforeEffect?: () => Promise<void> }> = {}) {
            return serialize(async () => {
                let changed = false;
                for (const record of await records()) {
                    const entry = record.manifest.entry;
                    const emptiesAt = days === null ? null : entry.movedAt + days * 86_400_000;
                    if (entry.emptiesAt === emptiesAt) continue;
                    await input.beforeEffect?.(); entry.emptiesAt = emptiesAt; await save(record); changed = true;
                }
                if (changed) notify();
            });
        },
        async availability(path: string) {
            try { const root = await rootFor(path); return { volumeId: root.volumeId, trashAvailable: true as const }; }
            catch { return { volumeId: (await roots()).find(root => contains(root.mountPath, path))?.volumeId ?? '',
                trashAvailable: false as const, reason: { code: 'facts_unavailable' as const } }; }
        },
        async prepare(input: TrashPrepareInput): Promise<TrashPreparedEntry> {
            const sourcePath = await physicalStoragePathWithoutFollowingLeaf(storageAbsolutePath(input.path));
            const root = await rootFor(sourcePath);
            const identity = input.identity ?? await readStoragePathIdentity(sourcePath);
            await assertStoragePathIdentity(sourcePath, identity);
            if ((await readStoragePathIdentity(root.path)).dev !== identity.dev || contains(root.path, sourcePath)) {
                throw Object.assign(new Error('Item cannot move into this Trash root'), { code: 'trash_volume_mismatch' });
            }
            const movedAt = now(); const days = deps.readEmptyAfterDays();
            const entry = TrashEntryV1Schema.parse({ entryId: randomUUID(), batchId: input.batchId, volumeId: root.volumeId,
                originalPath: sourcePath, title: input.title, categoryId: input.categoryId, size: input.size, movedAt,
                movedBy: input.movedBy, emptiesAt: days === null ? null : movedAt + days * 86_400_000, restorable: input.restorable ?? true });
            const directory = join(root.path, entry.entryId);
            const record: Record = { root, directory, payloadPath: join(directory, 'payload'), manifest: manifestSchema.parse({ v: 1,
                entry, identity, phase: 'prepared', ...(input.ownerData === undefined ? {} : { ownerData: input.ownerData }),
                attribution: deps.attributionFor(input.movedBy.accountId) }) };
            activePreparations.add(entry.entryId);
            try {
                await mkdir(directory, { mode: 0o700 });
                await ensureProtectedLocalStateDirectory(directory, { authority: 'owned' });
                await save(record);
            } catch (error) { activePreparations.delete(entry.entryId); throw error; }
            return { entry, payloadPath: record.payloadPath, commit: retire => serialize(async () => {
                await verifyProtectedLocalStatePath(root.path, 'directory'); await verifyProtectedLocalStatePath(directory, 'directory');
                await assertStoragePathIdentity(sourcePath, identity);
                if (await present(record.payloadPath)) throw Object.assign(new Error('Trash payload occupied'), { code: 'trash_payload_occupied' });
                const beforeEffect = async () => { await assertStoragePathIdentity(sourcePath, identity); await input.assertCurrentAuthority?.(); };
                if (retire) await retire({ sourcePath, payloadPath: record.payloadPath, beforeEffect });
                else { await beforeEffect(); await renameStoragePathNoReplace(sourcePath, record.payloadPath, undefined, identity); }
                await assertStoragePathIdentity(record.payloadPath, identity);
                await measure(record); record.manifest.phase = 'moved'; await save(record);
                await receipt(record, 'trash_moved', 0); notify(); return record.manifest.entry;
            }).finally(() => { activePreparations.delete(entry.entryId); }) };
        },
        async list(selection: TrashSelection = {}, visible?: (entry: TrashEntryV1, ownerData?: JsonValue) => Promise<boolean>): Promise<TrashEntryV1[]> {
            const entries: TrashEntryV1[] = [];
            for (const { manifest } of await records(selection)) {
                if (manifest.phase !== 'prepared' && (!visible || await visible(manifest.entry, manifest.ownerData))) entries.push(manifest.entry);
            }
            return entries;
        },
        async read(entryId: string): Promise<TrashEntryV1 | null> { return (await records({ entryIds: [entryId] }))[0]?.manifest.entry ?? null; },
        restore(selection: TrashSelection, input: Readonly<{ beside?: boolean; actorAccountId: string; custodianAccountId?: string; assertCurrentAuthority?: () => Promise<void>; assertEntryAuthority?: TrashEntryAuthorityCheck }>) {
            return serialize(async () => {
                const outcomes: { entryId: string; status: 'restored' | 'refused' | 'failed'; path?: string; reason?: StorageReasonV1 }[] = [];
                // Owned children were retired first; their original parents must exist before reinstatement.
                const restoring = (await records(selection)).sort((left, right) => Buffer.byteLength(storagePathToFs(left.manifest.entry.originalPath))
                    - Buffer.byteLength(storagePathToFs(right.manifest.entry.originalPath)));
                for (const record of restoring) {
                    const { entry } = record.manifest;
                    try {
                        if (!entry.restorable) {
                            outcomes.push({ entryId: entry.entryId, status: 'refused', reason: entry.reason ?? { code: 'unsupported' } }); continue;
                        }
                        if (input.assertEntryAuthority) await input.assertEntryAuthority(entry, record.manifest.ownerData);
                        else if (input.actorAccountId !== entry.movedBy.accountId && input.actorAccountId !== input.custodianAccountId) {
                            outcomes.push({ entryId: entry.entryId, status: 'refused', reason: { code: 'unauthorized' } }); continue;
                        }
                        const leaf = storagePathLeaf(entry.originalPath);
                        const besideLeaf = typeof leaf === 'string' ? `${leaf} (restored)` : Buffer.concat([leaf, Buffer.from(' (restored)')]);
                        const target = input.beside ? storagePathJoin(storagePathDirname(entry.originalPath), besideLeaf) : entry.originalPath;
                        if (!await present(storagePathDirname(target))) {
                            outcomes.push({ entryId: entry.entryId, status: 'refused', reason: { code: 'parent_missing' } }); continue;
                        }
                        const physical = await physicalStoragePathWithoutFollowingLeaf(target);
                        const reason = await deps.classifyRestorePath(physical);
                        if (reason || await present(physical)) {
                            outcomes.push({ entryId: entry.entryId, status: 'refused', reason: reason ?? { code: 'destination_occupied' } }); continue;
                        }
                        await assertStoragePathIdentity(record.payloadPath, record.manifest.identity);
                        record.manifest.phase = 'restoring'; record.manifest.restorePath = physical;
                        record.manifest.restoreAttribution = deps.attributionFor(input.actorAccountId); await save(record);
                        const beforeEffect = async () => {
                            await assertStoragePathIdentity(record.payloadPath, record.manifest.identity);
                            if (await present(physical)) throw Object.assign(new Error('Restore destination occupied'), { code: 'destination_occupied' });
                            if (await deps.classifyRestorePath(physical)) throw new Error('Restore destination forbidden');
                            await input.assertCurrentAuthority?.();
                        };
                        if (record.manifest.ownerData !== undefined) {
                            if (!deps.resolveOwnerAdapter) throw Object.assign(new Error('Trash owner adapter unavailable'), { code: 'owner_unavailable' });
                            await (await deps.resolveOwnerAdapter(entry.categoryId, record.manifest.ownerData)).reinstate({ payloadPath: record.payloadPath, restorePath: physical, beforeEffect });
                        } else { await beforeEffect(); await renameStoragePathNoReplace(record.payloadPath, physical, undefined, record.manifest.identity); }
                        await assertStoragePathIdentity(physical, record.manifest.identity);
                        if (await present(record.payloadPath)) throw new Error('Trash reinstate left its payload behind');
                        await restoredReceipt(record);
                        await cleanup(record); outcomes.push({ entryId: entry.entryId, status: 'restored', path: physical });
                    } catch (error) { outcomes.push({ entryId: entry.entryId, ...failure(error) }); }
                }
                notify(); return { outcomes };
            });
        },
        empty(selection: TrashSelection, input: Readonly<{ actorAccountId: string; custodianAccountId: string; scheduled?: boolean; canRunOwnerOperation?: () => boolean | Promise<boolean>; assertCurrentAuthority?: () => Promise<void>; assertEntryAuthority?: TrashEntryAuthorityCheck }>) {
            return serialize(async () => {
                const outcomes: { entryId: string; status: 'deleted' | 'refused' | 'failed'; reason?: StorageReasonV1 }[] = [];
                let freedBytes = 0;
                for (const record of await records(selection)) {
                    const { entry } = record.manifest;
                    if (input.scheduled ? entry.emptiesAt === null || entry.emptiesAt > now()
                        : !input.assertEntryAuthority && input.actorAccountId !== entry.movedBy.accountId && input.actorAccountId !== input.custodianAccountId) {
                        outcomes.push({ entryId: entry.entryId, status: 'refused', reason: { code: 'unauthorized' } }); continue;
                    }
                    try {
                        await input.assertEntryAuthority?.(entry, record.manifest.ownerData);
                        await input.assertCurrentAuthority?.();
                        const adapter = record.manifest.ownerData !== undefined ? await (() => {
                            if (!deps.resolveOwnerAdapter) throw Object.assign(new Error('Trash owner adapter unavailable'), { code: 'owner_unavailable' });
                            return deps.resolveOwnerAdapter(entry.categoryId, record.manifest.ownerData!);
                        })() : undefined;
                        const assertEligible = async () => {
                            if (adapter?.requiresIdle && input.canRunOwnerOperation && !await input.canRunOwnerOperation()) {
                                throw Object.assign(new Error('Trash owner is busy'), { code: 'in_use' });
                            }
                        };
                        await assertEligible();
                        await assertStoragePathIdentity(record.payloadPath, record.manifest.identity);
                        const bytes = await measure(record);
                        record.manifest.phase = 'emptying'; record.manifest.emptyAttribution = deps.attributionFor(input.actorAccountId); await save(record);
                        const beforeEffect = async () => {
                            await assertStoragePathIdentity(record.payloadPath, record.manifest.identity);
                            if (input.scheduled) {
                                const days = deps.readEmptyAfterDays();
                                if (days === null || entry.movedAt + days * 86_400_000 > now()) throw Object.assign(new Error('Trash retention changed'), { code: 'unauthorized' });
                            }
                            await assertEligible();
                            await input.assertCurrentAuthority?.();
                        };
                        if (adapter) await adapter.discard({ payloadPath: record.payloadPath, beforeEffect });
                        else await removeStoragePath(record.payloadPath, { allowedRoot: record.directory, expectedIdentity: record.manifest.identity, beforeEffect });
                        if (await present(record.payloadPath)) throw new Error('Trash discard left its payload behind');
                        await receipt(record, 'trash_emptied', bytes); await cleanup(record);
                        freedBytes += bytes; outcomes.push({ entryId: entry.entryId, status: 'deleted' });
                    } catch (error) { outcomes.push({ entryId: entry.entryId, ...failure(error) }); }
                }
                notify(); return { outcomes, freedBytes };
            });
        },
        reconcile(input: Readonly<{ canRunOwnerOperation?: () => boolean | Promise<boolean>; beforeEffect?: () => Promise<void> }> = {}) {
            return serialize(async () => {
                let changed = false;
                for (const record of await records()) {
                    const recoveryAdapter = record.manifest.phase !== 'moved' && record.manifest.ownerData !== undefined && deps.resolveOwnerAdapter
                        ? await deps.resolveOwnerAdapter(record.manifest.entry.categoryId, record.manifest.ownerData) : undefined;
                    const assertEligible = async () => {
                        if (recoveryAdapter?.requiresIdle && input.canRunOwnerOperation && !await input.canRunOwnerOperation()) {
                            throw Object.assign(new Error('Trash owner is busy'), { code: 'in_use' });
                        }
                        await input.beforeEffect?.();
                    };
                    if (recoveryAdapter?.requiresIdle && input.canRunOwnerOperation && !await input.canRunOwnerOperation()) continue;
                    if (!await present(record.payloadPath)) {
                        if (record.manifest.phase === 'restoring') {
                            if (!record.manifest.restorePath) throw new Error('Missing restore destination');
                            await assertStoragePathIdentity(record.manifest.restorePath, record.manifest.identity);
                            if (record.manifest.ownerData !== undefined) {
                                const { categoryId } = record.manifest.entry;
                                if (!deps.resolveOwnerAdapter) throw Object.assign(new Error('Trash owner adapter unavailable'), { code: 'owner_unavailable' });
                                const restorePath = record.manifest.restorePath;
                                const beforeEffect = async () => {
                                    await assertStoragePathIdentity(restorePath, record.manifest.identity);
                                    if (await present(record.payloadPath)) throw Object.assign(new Error('Trash payload reappeared during restore recovery'), { code: 'changed_since_review' });
                                    await assertEligible();
                                };
                                await (await deps.resolveOwnerAdapter(categoryId, record.manifest.ownerData))
                                    .reinstate({ payloadPath: record.payloadPath, restorePath, beforeEffect });
                                await beforeEffect();
                            }
                            await restoredReceipt(record, input.beforeEffect);
                        } else if (record.manifest.phase === 'emptying') {
                            if (record.manifest.ownerData !== undefined) {
                                const { categoryId } = record.manifest.entry;
                                if (!deps.resolveOwnerAdapter) throw Object.assign(new Error('Trash owner adapter unavailable'), { code: 'owner_unavailable' });
                                const beforeEffect = async () => {
                                    if (await present(record.payloadPath)) throw Object.assign(new Error('Trash payload reappeared during empty recovery'), { code: 'changed_since_review' });
                                    await assertEligible();
                                };
                                await (await deps.resolveOwnerAdapter(categoryId, record.manifest.ownerData))
                                    .discard({ payloadPath: record.payloadPath, beforeEffect });
                                await beforeEffect();
                            }
                            await receipt(record, 'trash_emptied', record.manifest.entry.size.freesBytes, input.beforeEffect);
                        }
                        else if (record.manifest.phase === 'moved') throw new Error('Trash payload unexpectedly missing');
                        await cleanup(record, input.beforeEffect); changed = true; continue;
                    }
                    await assertStoragePathIdentity(record.payloadPath, record.manifest.identity);
                    if (record.manifest.phase === 'prepared') {
                        if (record.manifest.ownerData !== undefined) {
                            const { categoryId, originalPath } = record.manifest.entry;
                            if (!deps.resolveOwnerAdapter) throw Object.assign(new Error('Trash owner adapter unavailable'), { code: 'owner_unavailable' });
                            const adapter = await deps.resolveOwnerAdapter(categoryId, record.manifest.ownerData);
                            if (!adapter.retire) throw Object.assign(new Error('Trash retirement recovery unavailable'), { code: 'owner_unavailable' });
                            const beforeEffect = async () => {
                                await assertStoragePathIdentity(record.payloadPath, record.manifest.identity);
                                if (await present(originalPath)) throw Object.assign(new Error('Original path reappeared during retirement recovery'), { code: 'changed_since_review' });
                                await assertEligible();
                            };
                            await adapter.retire({ payloadPath: record.payloadPath, beforeEffect });
                            await beforeEffect();
                        }
                        await measure(record); await input.beforeEffect?.(); record.manifest.phase = 'moved'; await save(record); changed = true;
                    }
                    const hadMovedReceipt = record.manifest.movedReceiptRecorded;
                    await receipt(record, 'trash_moved', 0, input.beforeEffect);
                    if (!hadMovedReceipt && record.manifest.movedReceiptRecorded) changed = true;
                }
                if (changed) notify();
            });
        },
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
}
export type TrashStore = ReturnType<typeof createTrashStore>;
