import { bindApprovalProfileV1, listReadableApprovalProfilesV1, loadReadableApprovalProfilesV1,
    executeApprovalProfileArtifactChangeV1, APPROVAL_PROFILE_ARTIFACT_KIND_V1,
    type ApprovalProfileArtifactChangeV1, type ApprovalProfileArtifactChangeResultV1 } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import type { ReadableApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { artifactKindsMayIncludeKindV1 } from '@happier-dev/protocol/changes';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { captureServerCredentialAccountScopeLifetime } from '@/sync/domains/scope/serverCredentialAccountScope';
import { serverAccountScopeKeySuffix, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { subscribeAccountCatalogInvalidation } from './accountCatalogInvalidation';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { homeAccountChangeAffectsArtifactKinds } from '@/sync/runtime/orchestration/changesPlanner';
import { classifyAccountStorageReadFailure } from '@/sync/encryption/accountStorageReadFailure';
import { getArtifactUseTargetV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { retainDeep, retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { fireAndForget } from '@/utils/system/fireAndForget';

type Account = Awaited<ReturnType<typeof captureLazyActionAccountContext>>;
type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope; lifetime: ServerAccountScopeLifetime }>;
export type ApprovalProfileDescriptor = Readonly<Pick<ReadableApprovalProfileV1['profile'], 'id' | 'name'>>;
type Snapshot = Readonly<{ rows: readonly ReadableApprovalProfileV1[] | null;
    descriptors: Readonly<Record<string, ApprovalProfileDescriptor | null>>; stale: boolean; unavailable: boolean }>;
type Entry = { target: Target; snapshot: Snapshot; changedIds: Set<string> | null; listeners: Set<() => void>;
    descriptorIds: Set<string>; fullDemand: boolean; stopObservation?: () => void };
const entries = new Map<string, Entry>();
const emptyRows: readonly ReadableApprovalProfileV1[] = Object.freeze([]);
const kinds = [APPROVAL_PROFILE_ARTIFACT_KIND_V1];

function copyDescriptors(previous?: Snapshot['descriptors']): Record<string, ApprovalProfileDescriptor | null> {
    return Object.assign(Object.create(null) as Record<string, ApprovalProfileDescriptor | null>, previous);
}

function publish(entry: Entry, snapshot: Snapshot) {
    if (!entry.target.lifetime.isCurrent()) return;
    const previous = entry.snapshot;
    const rows = snapshot.rows === null ? null : retainKeyedRows(previous.rows, snapshot.rows, row => row.id);
    const descriptors = retainDeep(previous.descriptors, snapshot.descriptors);
    if (rows === previous.rows && descriptors === previous.descriptors
        && previous.stale === snapshot.stale && previous.unavailable === snapshot.unavailable) return;
    entry.snapshot = { ...snapshot, rows, descriptors };
    for (const listener of [...entry.listeners]) listener();
}

function entryFor(scope: ServerAccountScope, lifetime: ServerAccountScopeLifetime): Entry {
    const key = serverAccountScopeKeySuffix(scope);
    const previous = entries.get(key);
    if (previous?.target.lifetime === lifetime) return previous;
    const entry: Entry = { target: { key: `approval-profiles:${key}`, serverId: scope.serverId, scope, lifetime },
        snapshot: { rows: null, descriptors: copyDescriptors(), stale: true, unavailable: false }, changedIds: null, listeners: new Set(),
        descriptorIds: new Set(), fullDemand: false };
    entries.set(key, entry);
    lifetime.onRetire(() => {
        if (entries.get(key) !== entry) return;
        entries.delete(key);
        entry.stopObservation?.();
        entry.snapshot = { rows: null, descriptors: copyDescriptors(), stale: true, unavailable: true };
        for (const listener of [...entry.listeners]) listener();
        entry.listeners.clear();
    });
    return entry;
}

function entryForAccount(account: Account): Entry {
    const scope = account.accountLifetime.scope;
    return entryFor(scope, captureServerCredentialAccountScopeLifetime({ kind: 'bound', scope,
        credentialKey: resolveAuthCredentialsScopeKey(account.credentials) }));
}

const loader = createScopedSnapshotLoader<Target>({
    subscribeRetainedInvalidation: (target, handlers) => {
        const stop = subscribeAccountCatalogInvalidation(target, handlers);
        const retirement = target.lifetime.onRetire(handlers.retire);
        return () => { stop(); retirement.dispose(); };
    },
    shouldLoadOnObserve: target => {
        const entry = entries.get(serverAccountScopeKeySuffix(target.scope));
        return !entry || entry.snapshot.stale || entry.snapshot.unavailable
            || (entry.fullDemand && entry.snapshot.rows === null)
            || [...entry.descriptorIds].some(id => !Object.hasOwn(entry.snapshot.descriptors, id));
    },
    invalidateServer: serverId => {
        for (const entry of entries.values()) if (entry.target.serverId === serverId) {
            publish(entry, { ...entry.snapshot, stale: true });
        }
    },
    invalidateTarget: target => {
        const entry = entries.get(serverAccountScopeKeySuffix(target.scope));
        if (entry?.target === target) publish(entry, { ...entry.snapshot, stale: true });
    },
    matchesWake: event => homeAccountChangeAffectsArtifactKinds(event, kinds),
    prepareWake: (event, target) => {
        const entry = entries.get(serverAccountScopeKeySuffix(target.scope));
        if (!entry || entry.target !== target) return false;
        const exact = event.source !== 'connected' && event.source !== 'snapshot'
            && event.changeKinds?.length === 1 && event.changeKinds[0] === 'artifact' && event.entityIds?.length
            && !artifactKindsMayIncludeKindV1(event.artifactKinds, []);
        if (exact && !entry.fullDemand && !event.entityIds!.some(id => entry.descriptorIds.has(id))) return false;
        if (exact && entry.snapshot.rows && entry.changedIds !== null) {
            for (const id of event.entityIds!) entry.changedIds.add(id);
        } else if (exact && entry.snapshot.rows && !entry.snapshot.stale) {
            entry.changedIds = new Set(event.entityIds);
        } else entry.changedIds = null;
        return true;
    },
    load: async (target, context) => {
        const entry = entries.get(serverAccountScopeKeySuffix(target.scope));
        if (!entry || entry.target !== target) return;
        const changedIds = entry.changedIds;
        entry.changedIds = new Set();
        let account: Account | undefined;
        try {
            account = await captureLazyActionAccountContext(target.serverId, context.signal);
            account.assertCurrent();
            if (account.accountId !== target.scope.accountId || !target.lifetime.isCurrent()) return;
            if (!entry.fullDemand) {
                const ids = [...entry.descriptorIds];
                const opened = await account.readArtifactHeaders(ids, { signal: context.signal });
                const descriptors = copyDescriptors(entry.snapshot.descriptors);
                for (let index = 0; index < ids.length; index += 1) {
                    const result = opened[index]!;
                    if (result.status === 'rejected') throw result.reason;
                    descriptors[ids[index]!] = readDescriptor(result.value);
                }
                account.assertCurrent();
                if (context.isCurrent()) publish(entry, { ...entry.snapshot, descriptors, stale: false, unavailable: false });
                return;
            }
            let rows: readonly ReadableApprovalProfileV1[];
            if (changedIds?.size && entry.snapshot.rows) {
                const ids = [...changedIds];
                const opened = await account.readArtifactContents(ids, { signal: context.signal });
                const resources = opened.flatMap(result => {
                    if (result.status === 'rejected') throw result.reason;
                    return result.value ? [result.value] : [];
                });
                const replacements = listReadableApprovalProfilesV1(resources);
                const replacementById = new Map(replacements.map(row => [row.id, row]));
                rows = entry.snapshot.rows.flatMap(row => {
                    if (!changedIds.has(row.id)) return [row];
                    const next = replacementById.get(row.id);
                    replacementById.delete(row.id);
                    return next ? [next] : [];
                }).concat([...replacementById.values()]);
            } else rows = await loadReadableApprovalProfilesV1(account.workflowArtifacts.list, context.signal);
            account.assertCurrent();
            const descriptors = copyDescriptors();
            for (const id of entry.descriptorIds) descriptors[id] = null;
            for (const row of rows) descriptors[row.id] = { id: row.id, name: row.profile.name };
            if (context.isCurrent()) publish(entry, { rows, descriptors, stale: false, unavailable: false });
        } catch (error) {
            if (!context.signal.aborted && context.isCurrent()) {
                const offline = classifyAccountStorageReadFailure(error, context.signal) === 'unreachable';
                publish(entry, { ...entry.snapshot, rows: offline ? entry.snapshot.rows : null,
                    descriptors: offline ? entry.snapshot.descriptors : copyDescriptors(),
                    stale: !offline || (entry.fullDemand && entry.snapshot.rows === null), unavailable: true });
            }
            throw error;
        } finally {
            // A later push supersedes this read; its refresh must still cover
            // the changed IDs whose results this read could no longer publish.
            if (!context.isCurrent() && changedIds && entry.changedIds) {
                for (const id of changedIds) entry.changedIds.add(id);
            }
            account?.dispose();
        }
    },
});

function demandCatalog(entry: Entry, full = true): void {
    // The first real reader activates this held Account catalog. Navigation
    // releases its UI listener; the credential owner releases push freshness.
    entry.fullDemand ||= full;
    entry.stopObservation ??= loader.observe(entry.target);
}

function readDescriptor(artifact: Awaited<ReturnType<Account['readArtifactHeader']>>): ApprovalProfileDescriptor | null {
    if (!artifact?.isDecrypted || !artifact.title) return null;
    const target = getArtifactUseTargetV1({ artifactId: artifact.id, header: artifact.rawHeader ?? artifact.header ?? {}, body: null });
    return target.kind === 'approval_profile' ? { id: artifact.id, name: artifact.title } : null;
}

/** A collapsed stored selection asks only for its existing Artifact display header. */
export async function requestApprovalProfileDescriptors(binding: ServerCredentialAccountScopeBinding, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const lifetime = captureServerCredentialAccountScopeLifetime({ kind: 'bound', scope: binding.scope, credentialKey: binding.credentialKey });
    const entry = entryFor(binding.scope, lifetime);
    const state = readRegisteredStorageState();
    const canReuse = areServerAccountScopesEqual(getActiveServerAccountScope(), binding.scope)
        && areServerAccountScopesEqual(state?.settingsScope, binding.scope);
    const descriptors = copyDescriptors(entry.snapshot.descriptors);
    let needsRead = entry.snapshot.unavailable || (entry.snapshot.stale && entry.stopObservation !== undefined);
    for (const id of ids) {
        entry.descriptorIds.add(id);
        if (Object.hasOwn(descriptors, id)) continue;
        const artifact = canReuse ? state?.artifacts[id] : undefined;
        if (artifact?.isDecrypted && artifact.access !== undefined) descriptors[id] = readDescriptor(artifact);
        else needsRead = true;
    }
    publish(entry, { ...entry.snapshot, descriptors, stale: needsRead ? entry.snapshot.stale : false });
    demandCatalog(entry, false);
    if (!needsRead) return;
    await loader.refresh(entry.target);
}

export function getApprovalProfileCatalogRows(scope: ServerAccountScope | null | undefined): readonly ReadableApprovalProfileV1[] {
    return scope ? entries.get(serverAccountScopeKeySuffix(scope))?.snapshot.rows ?? emptyRows : emptyRows;
}

/** A mounted reader shares the Account's held catalog without creating a transport or polling loop. */
export function subscribeApprovalProfileCatalog(binding: ServerCredentialAccountScopeBinding,
    listener: (snapshot: Snapshot) => void, demand = true): () => void {
    const lifetime = captureServerCredentialAccountScopeLifetime({ kind: 'bound', scope: binding.scope, credentialKey: binding.credentialKey });
    const entry = entryFor(binding.scope, lifetime);
    const update = () => listener(entry.snapshot);
    entry.listeners.add(update);
    update();
    if (demand) fireAndForget(requestApprovalProfileCatalog(binding), { tag: 'ApprovalProfile.catalog' });
    return () => { entry.listeners.delete(update); };
}

export async function requestApprovalProfileCatalog(binding: ServerCredentialAccountScopeBinding): Promise<void> {
    const lifetime = captureServerCredentialAccountScopeLifetime({ kind: 'bound', scope: binding.scope, credentialKey: binding.credentialKey });
    const entry = entryFor(binding.scope, lifetime);
    demandCatalog(entry);
    if (entry.snapshot.rows && !entry.snapshot.stale && !entry.snapshot.unavailable) return;
    await loader.refresh(entry.target);
    // A header read already in flight may have satisfied only display demand.
    if (!entry.snapshot.rows) await loader.refresh(entry.target);
}

export async function readApprovalProfileCatalog(account: Account) {
    const entry = entryForAccount(account);
    demandCatalog(entry);
    if (!entry.snapshot.rows || entry.snapshot.stale) {
        try {
            await loader.refresh(entry.target);
            if (!entry.snapshot.rows) await loader.refresh(entry.target);
        }
        catch (error) { if (!entry.snapshot.rows || entry.snapshot.stale) throw error; }
    }
    if (!entry.snapshot.rows) throw new Error('approval_context_unavailable');
    return entry.snapshot.rows;
}

export async function readBoundApprovalProfile(account: Account, id: string) {
    return bindApprovalProfileV1(await readApprovalProfileCatalog(account), id);
}

/** A write updates known display data without claiming an undemanded collection is complete. */
export function acknowledgeApprovalProfileChange(account: Account, receipt: ApprovalProfileArtifactChangeResultV1,
    profile?: ReadableApprovalProfileV1): void {
    const entry = entryForAccount(account);
    const acknowledged = profile ? { ...profile, ...(profile.access === 'owner' ? { ownerAccountId: account.accountId } : {}) } : null;
    let replaced = false;
    const rows = entry.snapshot.rows?.flatMap(row => {
        if (row.id !== receipt.id) return [row];
        replaced = true;
        return acknowledged ? [acknowledged] : [];
    }) ?? null;
    if (rows && acknowledged && !replaced) rows.push(acknowledged);
    const descriptors = copyDescriptors(entry.snapshot.descriptors);
    descriptors[receipt.id] = acknowledged ? { id: acknowledged.id, name: acknowledged.profile.name } : null;
    publish(entry, { ...entry.snapshot, rows, descriptors });
}

/** The host adapts Artifact transport once; content, access and CAS stay with the protocol owner. */
export async function executeUiApprovalProfileChange(account: Account, change: ApprovalProfileArtifactChangeV1, signal?: AbortSignal) {
    const result = await executeApprovalProfileArtifactChangeV1({
        read: account.workflowArtifacts.read,
        create: async input => {
            const { artifactId, revision } = await account.createArtifactDocument(input);
            return { artifactId, revision };
        },
        update: account.workflowArtifacts.update,
        delete: account.workflowArtifacts.delete,
    }, change, signal);
    if (result.ok) acknowledgeApprovalProfileChange(account, result.result.profileChange, result.profile);
    return result;
}
