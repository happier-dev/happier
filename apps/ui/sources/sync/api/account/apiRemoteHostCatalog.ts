import { REMOTE_HOST_ROWS_ROUTE_V1, RemoteHostCatalogRecordV1Schema, RemoteHostCatalogRowReadResponseV1Schema, loadRemoteHostCatalogV1,
    RemoteHostCatalogRowMutationV1Schema, RemoteHostCatalogRowMutationResponseV1Schema, sealRemoteHostCatalogContentV1,
    type RemoteHostCatalogRowReadResponseV1, type RemoteHostCatalogSnapshotV1, type RemoteHostRecordV1,
    type RemoteHostCatalogRowMutationV1, type RemoteHostCatalogRecordV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { RemoteHostSaveActionInputV1Schema, type RemoteHostActionInputByIdV1 } from '@happier-dev/protocol/remoteHosts/remoteHostActionsV1';
import { parseSavedSecretRefV1, formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import type { LegacyRemoteHostRecordV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { readRetainedRemoteHostCatalogV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { loadRemoteHostCatalogProjectionV1, type RemoteHostRetainedSourceV1 } from '@happier-dev/protocol/remoteHosts/remoteHostCatalogV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { ServerFetch } from '@/sync/http/client';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { withProfileAccount, type ProfileAccountContext } from './apiProfileCatalog';
import { classifyAccountStorageReadFailure, resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { captureSavedSecretReferenceRevisionsInContext, readSavedSecretCatalogInContext, readSavedSecretReferenceInContext,
    type SavedSecretReferenceRevisionProof } from './apiSavedSecretCatalog';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import { decryptSecretValueWithKeys, deriveSettingsSecretsKeySet } from '@/sync/encryption/secretSettings';
import { normalizeAccountSettingsHistoryAfterTransfer } from '@/sync/engine/settings/accountSettingsHistoryRestore';
import { randomUUID } from '@/platform/randomUUID';
import { SavedSecretCatalogReferenceCensusV1Schema, type SavedSecretCatalogReferenceCensusV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';

export type RemoteHostAccountContext = Pick<ProfileAccountContext,
    'request' | 'assertCurrent' | 'credentials' | 'resolveAccountMode' | 'resolveAccountEncryption' | 'serverId' | 'accountId' | 'accountLifetime' | 'mutateRawSettings'>;
export type RemoteHostMutationResult = Readonly<{ ok: true; revision: number }>
    | Readonly<{ ok: false; reason: string }>;
export type RemoteHostCredentialChanges = Readonly<{
    password?: Readonly<{ kind: 'new'; value: string }> | Readonly<{ kind: 'clear' }>;
    identityPrivateKey?: Readonly<{ kind: 'new'; value: string }> | Readonly<{ kind: 'clear' }>;
}>;

export class RemoteHostCatalogOperationError extends Error {
    constructor(readonly code: string, readonly cause?: unknown) { super(code); this.name = 'RemoteHostCatalogOperationError'; }
}

/** Conversion borrows its initiating request: this read never transfers or recaptures an Account. */
export async function readRemoteHostCatalogRow(authority: Readonly<{ request: ServerFetch; isCurrent(): boolean }>,
    signal?: AbortSignal): Promise<RemoteHostCatalogRowReadResponseV1> {
    const assertCurrent = () => {
        signal?.throwIfAborted();
        if (!authority.isCurrent()) throw new RemoteHostCatalogOperationError('scope-retired');
    };
    assertCurrent();
    const response = await authority.request(REMOTE_HOST_ROWS_ROUTE_V1, { method: 'GET', signal }, { retry: 'none' });
    assertCurrent();
    if (!response.ok) throw new RemoteHostCatalogOperationError(response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable');
    const result = RemoteHostCatalogRowReadResponseV1Schema.parse(await response.json());
    assertCurrent();
    return result;
}
export function readRemoteHostCatalogRowInContext(context: Pick<ProfileAccountContext, 'request' | 'accountLifetime'>,
    signal?: AbortSignal): Promise<RemoteHostCatalogRowReadResponseV1> {
    return readRemoteHostCatalogRow({ request: context.request, isCurrent: context.accountLifetime.isCurrent }, signal);
}

async function admit<T>(context: RemoteHostAccountContext,
    operation: (mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null) => Promise<T>): Promise<T> {
    const { encryption } = await context.resolveAccountEncryption();
    const storage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    context.assertCurrent();
    return operation(storage.mode, storage.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials));
}
function failure(error: unknown, signal?: AbortSignal): RemoteHostCatalogSnapshotV1 {
    return { status: 'unavailable', reason: classifyAccountStorageReadFailure(error, signal) };
}

/** Complete opened destination census; absence never consults retired Settings. */
async function readAdmittedRemoteHostCatalog(context: RemoteHostAccountContext, mode: 'plain' | 'e2ee',
    material: AccountScopedCryptoMaterial | null, signal?: AbortSignal): Promise<RemoteHostCatalogSnapshotV1> {
    const catalog = await loadRemoteHostCatalogV1({ mode, material, signal,
        readRow: () => readRemoteHostCatalogRow({ request: context.request, isCurrent: () => {
            try { context.assertCurrent(); return true; } catch { return false; }
        } }, signal) });
    const { encryption } = await context.resolveAccountEncryption();
    const current = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    context.assertCurrent();
    return current.mode === mode ? catalog : { status: 'unavailable', reason: 'account-mode-mismatch' };
}
export async function readRemoteHostCatalogInContext(context: RemoteHostAccountContext,
    signal?: AbortSignal): Promise<RemoteHostCatalogSnapshotV1> {
    try { return await admit(context, (mode, material) => readAdmittedRemoteHostCatalog(context, mode, material, signal)); }
    catch (error) { return failure(error, signal); }
}
export async function readRemoteHostCatalog(scope: ServerAccountScope, signal?: AbortSignal): Promise<RemoteHostCatalogSnapshotV1> {
    try { return await withProfileAccount(scope, signal, context => readRemoteHostCatalogInContext(context, signal)); }
    catch (error) { return failure(error, signal); }
}

/** Current-row operations need cutover only when there is no destination yet. */
async function readCapturedRemoteHostCatalogForOperation(context: RemoteHostAccountContext, mode: 'plain' | 'e2ee',
    material: AccountScopedCryptoMaterial | null, signal?: AbortSignal): Promise<RemoteHostCatalogSnapshotV1> {
    const destination = await readAdmittedRemoteHostCatalog(context, mode, material, signal);
    return destination.status === 'ready' && destination.revision === 'absent'
        ? readCapturedRemoteHostCatalogProjection(context, mode, material, signal) : destination;
}
export async function readRemoteHostCatalogForOperationInContext(context: RemoteHostAccountContext,
    signal?: AbortSignal): Promise<RemoteHostCatalogSnapshotV1> {
    try { return await admit(context, (mode, material) => readCapturedRemoteHostCatalogForOperation(context, mode, material, signal)); }
    catch (error) { return failure(error, signal); }
}

/** Normal demand performs the bounded retained-development cutover in this captured Account. */
export async function readRemoteHostCatalogProjection(scope: ServerAccountScope, signal?: AbortSignal,
    publication?: Readonly<{ onReady?(catalog: RemoteHostCatalogSnapshotV1, current: () => boolean): void; hasPendingCleanup?(): boolean }>): Promise<RemoteHostCatalogSnapshotV1> {
    try {
        return await withProfileAccount(scope, signal, (context, mode, material) => readCapturedRemoteHostCatalogProjection(context, mode, material, signal, publication));
    } catch (error) { return failure(error, signal); }
}
export async function readRemoteHostCatalogProjectionInContext(context: RemoteHostAccountContext, signal?: AbortSignal,
    publication?: Readonly<{ onReady?(catalog: RemoteHostCatalogSnapshotV1, current: () => boolean): void; hasPendingCleanup?(): boolean }>): Promise<RemoteHostCatalogSnapshotV1> {
    try { return await admit(context, (mode, material) => readCapturedRemoteHostCatalogProjection(context, mode, material, signal, publication)); }
    catch (error) { return failure(error, signal); }
}
async function readCapturedRemoteHostCatalogProjection(context: RemoteHostAccountContext, mode: 'plain' | 'e2ee',
    material: AccountScopedCryptoMaterial | null, signal?: AbortSignal,
    publication?: Readonly<{ onReady?(catalog: RemoteHostCatalogSnapshotV1, current: () => boolean): void; hasPendingCleanup?(): boolean }>): Promise<RemoteHostCatalogSnapshotV1> {
    const readSource = async (): Promise<RemoteHostRetainedSourceV1> => {
        const { encryption } = await context.resolveAccountEncryption();
        const baseline = await readAccountSettingsBaseline({ request: context.request, credentials: context.credentials, encryption, accountMode: mode });
        context.assertCurrent();
        return { version: baseline.version, raw: baseline.raw ?? {} };
    };
    const result = await loadRemoteHostCatalogProjectionV1({ mode, material, signal, assertCurrent: context.assertCurrent,
        hasPendingCleanup: publication?.hasPendingCleanup,
        readRow: () => readRemoteHostCatalogRowInContext(context, signal), readSource,
        prepareSource: async (_source, hosts) => {
            const resources: NonNullable<RemoteHostActionInputByIdV1['remote_hosts.save']['savedSecretResources']> = [];
            const revisions: { resourceId: string; revision: number }[] = [];
            const disposers: (() => void)[] = [];
            try {
                const projected: RemoteHostRecordV1[] = [];
                for (const host of hosts) {
                    const { passwordEnc, identityPrivateKeyEnc, ...ssh } = host.ssh;
                    const next = { ...host, ssh: { ...ssh, passwordSecretRef: null as string | null, identityPrivateKeySecretRef: null as string | null } };
                    for (const [slot, raw] of [['password', passwordEnc], ['identityPrivateKey', identityPrivateKeyEnc]] as const) {
                        if (!raw) continue;
                        const value = decryptSecretValueWithKeys(raw, material ? deriveSettingsSecretsKeySet(material).readKeys : []);
                        if (value === null) throw new RemoteHostCatalogOperationError('encryption-material-unavailable');
                        const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: context.accountId,
                            source: { kind: 'remote-host-ssh-credential', hostId: host.id, slot } });
                        const prepared = await prepareCredentialResource(context, mode, host.name, slot, value, resourceId);
                        disposers.push(prepared.dispose); resources.push(prepared.input); revisions.push({ resourceId, revision: 1 });
                        if (slot === 'password') next.ssh.passwordSecretRef = formatSharedSavedSecretRefV1(resourceId);
                        else next.ssh.identityPrivateKeySecretRef = formatSharedSavedSecretRefV1(resourceId);
                    }
                    projected.push(next);
                }
                return { record: { v: 1, hosts: projected }, resources, referencedSavedSecretRevisions: revisions,
                    dispose: () => { for (const dispose of disposers) dispose(); } };
            } catch (error) { for (const dispose of disposers) dispose(); throw error; }
        },
        mutateCatalog: async packet => {
            context.assertCurrent();
            const response = await context.request(REMOTE_HOST_ROWS_ROUTE_V1, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(packet), signal }, { retry: 'none' }).catch(error => {
                throw new RemoteHostCatalogOperationError(classifyHttpMutationRequestFailure({ error, issued: true, signal }), error);
            });
            const value: unknown = await response.json();
            return RemoteHostCatalogRowMutationResponseV1Schema.parse(value);
        },
        verifySource: async (source, hosts) => {
            if (!Object.hasOwn(source.raw, 'remoteHostsV1')) return true;
            const retained = readRetainedRemoteHostCatalogV1(source.raw.remoteHostsV1);
            if (retained.status !== 'ready') return false;
            if (retained.hosts.length !== hosts.length) return false;
            for (const old of retained.hosts) {
                const host = hosts.find(host => host.id === old.id);
                if (!host || !await retainedHostMatches(context, material, old, host, signal)) return false;
            }
            return true;
        },
        cleanupSource: async (source, revision) => {
            try {
                if (Object.hasOwn(source.raw, 'remoteHostsV1')) {
                    const cleaned = await context.mutateRawSettings(raw => {
                        if (!sameStrictJsonValue(raw.remoteHostsV1, source.raw.remoteHostsV1)) throw new RemoteHostCatalogOperationError('changed');
                        const { remoteHostsV1: _retired, ...kept } = raw;
                        return kept;
                    }, { expectedSettingsVersion: source.version, rebaseOnConflict: false, observeOutcome: true, signal });
                    if (cleaned.status !== 'applied') return false;
                }
                context.assertCurrent();
                const freshSource = await readSource();
                const catalog = await readSavedSecretCatalogInContext(context, signal);
                context.assertCurrent();
                const resources = catalog.ok ? catalog.resources.flatMap(row => 'resourceId' in row
                    && row.entry.relationship === 'owner' && (row.entry.owner?.accountId ?? row.entry.ownerAccountId) === context.accountId
                    && row.entry.materialStatus === 'ready' && row.entry.revision !== null && row.entry.capabilities.use
                    ? [{ resourceId: row.resourceId, ownerAccountId: context.accountId, revision: row.entry.revision,
                        materialStatus: row.entry.materialStatus }] : []) : [];
                const { encryption } = await context.resolveAccountEncryption();
                const history = await normalizeAccountSettingsHistoryAfterTransfer({ credentials: context.credentials, encryption,
                    settingsScope: context.accountLifetime.scope, destinationAuthority: { activeTransferredRoots: ['remoteHostsV1'],
                        activePrivateCatalogRevisions: { remoteHosts: revision } },
                    savedSecretRecovery: { accountId: context.accountId, source: freshSource, resources,
                        resolveResourceValue: async resourceId => {
                            const captured = resources.find(resource => resource.resourceId === resourceId);
                            if (!captured) return null;
                            const value = await readSavedSecretReferenceInContext(context, formatSharedSavedSecretRefV1(resourceId), signal);
                            context.assertCurrent();
                            return value.ok && value.revision === captured.revision ? value.value : null;
                        } },
                    requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent } });
                return history.status === 'complete';
            } catch { return false; }
        },
        ...(publication?.onReady ? { onReady: catalog => publication.onReady?.(catalog, context.accountLifetime.isCurrent) } : {}),
    });
    context.assertCurrent();
    const { encryption } = await context.resolveAccountEncryption();
    const current = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    return current.mode === mode ? result : { status: 'unavailable', reason: 'account-mode-mismatch' };
}

async function retainedHostMatches(context: RemoteHostAccountContext, material: AccountScopedCryptoMaterial | null,
    old: LegacyRemoteHostRecordV1, host: RemoteHostRecordV1, signal?: AbortSignal): Promise<boolean> {
    const { passwordEnc, identityPrivateKeyEnc, ...oldSsh } = old.ssh;
    const { passwordSecretRef, identityPrivateKeySecretRef, ...ssh } = host.ssh;
    if (!sameStrictJsonValue({ ...old, ssh: oldSsh }, { ...host, ssh })) return false;
    for (const [raw, ref] of [[passwordEnc, passwordSecretRef], [identityPrivateKeyEnc, identityPrivateKeySecretRef]] as const) {
        if (!raw) { if (ref) return false; continue; }
        if (!ref) return false;
        const value = decryptSecretValueWithKeys(raw, material ? deriveSettingsSecretsKeySet(material).readKeys : []);
        const current = await readSavedSecretReferenceInContext(context, ref, signal);
        context.assertCurrent();
        if (value === null || !current.ok || value !== current.value) return false;
    }
    return true;
}

async function prepareCredentialResource(context: RemoteHostAccountContext, mode: 'plain' | 'e2ee', name: string,
    slot: 'password' | 'identityPrivateKey', value: string, resourceId: string) {
    const { prepareSavedSecretResourceCreateInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
    return prepareSavedSecretResourceCreateInContext(context, mode, { resourceId, displayName: `${name} SSH ${slot === 'password' ? 'password' : 'private key'}`,
        kind: slot === 'password' ? 'password' : 'other', value, accountGrants: [], teamGrants: [], groupGrants: [] });
}

/** Raw drafts never enter the durable host or Action observation: only the canonical prepared resource packet does. */
export async function prepareRemoteHostSaveInContext(context: ProfileAccountContext, input: Readonly<{
    host: RemoteHostRecordV1; expectedRevision: number | 'absent'; credentialChanges?: RemoteHostCredentialChanges;
    referenceCensus?: SavedSecretCatalogReferenceCensusV1;
}>, signal?: AbortSignal): Promise<Readonly<{ input: RemoteHostActionInputByIdV1['remote_hosts.save']; dispose(): void }>> {
    return admit(context, async mode => {
        signal?.throwIfAborted(); context.assertCurrent();
        const host = { ...input.host, ssh: { ...input.host.ssh } };
        const resources: NonNullable<RemoteHostActionInputByIdV1['remote_hosts.save']['savedSecretResources']> = [];
        const revisions: { resourceId: string; revision: number }[] = [];
        const disposers: (() => void)[] = [];
        try {
            for (const slot of ['password', 'identityPrivateKey'] as const) {
                const change = input.credentialChanges?.[slot];
                if (!change) continue;
                const field = slot === 'password' ? 'passwordSecretRef' : 'identityPrivateKeySecretRef';
                if (change.kind === 'clear') { host.ssh[field] = null; continue; }
                const resourceId = randomUUID();
                const prepared = await prepareCredentialResource(context, mode, host.name, slot, change.value, resourceId);
                resources.push(prepared.input); disposers.push(prepared.dispose); revisions.push({ resourceId, revision: 1 });
                host.ssh[field] = formatSharedSavedSecretRefV1(resourceId);
            }
            context.assertCurrent();
            return { input: RemoteHostSaveActionInputV1Schema.parse({ host, expectedRevision: input.expectedRevision,
                ...(input.referenceCensus ? { referenceCensus: input.referenceCensus } : {}),
                ...(resources.length ? { savedSecretResources: resources, referencedSavedSecretRevisions: revisions } : {}) }),
                dispose: () => { for (const dispose of disposers) dispose(); } };
        } catch (error) { for (const dispose of disposers) dispose(); throw error; }
    });
}

async function mutateRemoteHostCatalogInContext(context: RemoteHostAccountContext, mutation: RemoteHostCatalogRowMutationV1,
    resources: RemoteHostActionInputByIdV1['remote_hosts.save']['savedSecretResources'], signal?: AbortSignal,
    referenceCensus?: SavedSecretCatalogReferenceCensusV1): Promise<RemoteHostMutationResult> {
    signal?.throwIfAborted();
    context.assertCurrent();
    let issued = false;
    try {
        const body = JSON.stringify({ mutation: RemoteHostCatalogRowMutationV1Schema.parse(mutation),
            ...(resources?.length ? { savedSecretResources: resources,
                ...(referenceCensus ? { referenceCensus: SavedSecretCatalogReferenceCensusV1Schema.parse(referenceCensus) } : {}) } : {}) });
        context.assertCurrent();
        issued = true;
        const response = await context.request(REMOTE_HOST_ROWS_ROUTE_V1,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal }, { retry: 'none' });
        if (!response.ok && response.status !== 409) return { ok: false, reason: response.status === 401 ? 'unauthorized'
            : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unavailable' };
        const result = RemoteHostCatalogRowMutationResponseV1Schema.parse(await response.json());
        // The mutation receipt reports the committed effect even if its captured
        // Account retires while the response is in flight. No private data is disclosed.
        if (result.status === 'updated') return { ok: true, revision: result.revision };
        return { ok: false, reason: result.status === 'conflict' || result.status === 'settings-conflict'
            || result.status === 'references-conflict' ? 'changed' : result.status };
    } catch (error) {
        return { ok: false, reason: classifyHttpMutationRequestFailure({ error, issued, signal }) === 'outcome_unknown'
            ? 'outcome_unknown' : signal?.aborted ? 'cancelled' : 'unavailable' };
    }
}

/** The enclosing S2 transaction owns publication; this only prepares its captured SSH row. */
export async function prepareRemoteHostCatalogMutationInContext(context: RemoteHostAccountContext, input: Readonly<{
    record: RemoteHostCatalogRecordV1;
    expectedRevision: number | 'absent';
    sourceSettingsVersion?: number;
    expectedMode?: 'plain' | 'e2ee';
    savedSecretRevisions?: readonly SavedSecretReferenceRevisionProof[];
    pendingResourceIds?: readonly string[];
}>, signal?: AbortSignal): Promise<RemoteHostCatalogRowMutationV1> {
    return admit(context, async (mode, material) => {
        signal?.throwIfAborted();
        if (input.expectedMode !== undefined && input.expectedMode !== mode) {
            throw new RemoteHostCatalogOperationError('account-mode-mismatch');
        }
        const record = RemoteHostCatalogRecordV1Schema.parse(input.record);
        const proofs = await captureSavedSecretReferenceRevisionsInContext(context, {
            references: listRemoteHostResourceReferences(record.hosts), savedSecretRevisions: input.savedSecretRevisions,
            pendingResourceIds: input.pendingResourceIds, signal,
        });
        signal?.throwIfAborted();
        context.assertCurrent();
        return RemoteHostCatalogRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision,
            ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }),
            referencedSavedSecretRevisions: proofs.savedSecretRevisions.map(proof => ({
                resourceId: proof.resourceId, revision: proof.expectedRevision,
            })),
            content: sealRemoteHostCatalogContentV1({ record, mode, material }),
        });
    });
}

function listRemoteHostResourceReferences(hosts: readonly RemoteHostRecordV1[]): string[] {
    return [...new Set(hosts.flatMap(host => [host.ssh.passwordSecretRef, host.ssh.identityPrivateKeySecretRef])
        .filter((ref): ref is string => typeof ref === 'string'))];
}

/** One captured catalog CAS; no Settings write, optimistic publication or replay. */
export async function saveRemoteHostInContext(context: RemoteHostAccountContext,
    input: RemoteHostActionInputByIdV1['remote_hosts.save'], signal?: AbortSignal): Promise<RemoteHostMutationResult> {
    try {
        const prepared = RemoteHostSaveActionInputV1Schema.parse(input);
        return await admit(context, async (mode, material) => {
            const catalog = await readCapturedRemoteHostCatalogForOperation(context, mode, material, signal);
            if (catalog.status !== 'ready') return { ok: false, reason: 'unavailable' };
            if (catalog.revision !== prepared.expectedRevision) return { ok: false, reason: 'changed' };
            const referenceCensus = prepared.savedSecretResources?.length ? SavedSecretCatalogReferenceCensusV1Schema.parse({
                scope: 'catalogs', accountMode: mode, catalogs: {}, remoteHosts: { revision: catalog.revision,
                    resourceRefs: listRemoteHostResourceReferences(catalog.hosts) },
            }) : undefined;
            if (referenceCensus && prepared.referenceCensus && !sameStrictJsonValue(prepared.referenceCensus, referenceCensus))
                return { ok: false, reason: 'references-conflict' };
            const previous = catalog.hosts.find(host => host.id === prepared.host.id);
            const hosts = previous ? catalog.hosts.map(host => host.id === prepared.host.id ? prepared.host : host)
                : [...catalog.hosts, prepared.host];
            const revisions = await captureRemoteHostResourceRevisions(context, hosts, prepared, signal);
            if (!revisions) return { ok: false, reason: 'references-conflict' };
            const source = catalog.revision === 'absent' ? await readAccountSettingsBaseline({ request: context.request,
                credentials: context.credentials, encryption: (await context.resolveAccountEncryption()).encryption, accountMode: mode }) : null;
            context.assertCurrent();
            return mutateRemoteHostCatalogInContext(context, {
                expectedRevision: prepared.expectedRevision,
                ...(source ? { sourceSettingsVersion: source.version } : {}),
                referencedSavedSecretRevisions: revisions,
                content: sealRemoteHostCatalogContentV1({ mode, material, record: { v: 1, hosts } }),
            }, prepared.savedSecretResources, signal, referenceCensus);
        });
    } catch (error) {
        const result = failure(error, signal);
        return { ok: false, reason: result.status === 'unavailable' ? result.reason : 'unavailable' };
    }
}

async function captureRemoteHostResourceRevisions(context: RemoteHostAccountContext, hosts: readonly RemoteHostRecordV1[],
    input: RemoteHostActionInputByIdV1['remote_hosts.save'], signal?: AbortSignal): Promise<{ resourceId: string; revision: number }[] | null> {
    const refs = new Set(listRemoteHostResourceReferences(hosts));
    if (!refs.size) return input.savedSecretResources?.length ? null : [];
    const created = new Map(input.savedSecretResources?.map(resource => [resource.resourceId, resource]) ?? []);
    const supplied = new Map(input.referencedSavedSecretRevisions?.map(resource => [resource.resourceId, resource.revision]) ?? []);
    const metadata = await readSavedSecretCatalogInContext(context, signal);
    if (!metadata.ok) return null;
    const revisions: { resourceId: string; revision: number }[] = [];
    for (const ref of refs) {
        const parsed = parseSavedSecretRefV1(ref);
        if (parsed.kind !== 'shared_resource') return null;
        const fresh = created.has(parsed.resourceId) ? 1 : metadata.resources.find(resource => 'resourceId' in resource
            && resource.resourceId === parsed.resourceId && resource.entry.materialStatus === 'ready'
            && resource.entry.capabilities.use)?.entry.revision;
        if (fresh == null || (supplied.has(parsed.resourceId) && supplied.get(parsed.resourceId) !== fresh)) return null;
        revisions.push({ resourceId: parsed.resourceId, revision: fresh });
    }
    if ([...created.keys(), ...supplied.keys()].some(id => !revisions.some(resource => resource.resourceId === id))) return null;
    context.assertCurrent();
    return revisions;
}

export async function removeRemoteHost(scope: ServerAccountScope, input: Readonly<{ hostId: string; expectedRevision: number | 'absent' }>,
    signal?: AbortSignal): Promise<RemoteHostMutationResult> {
    try {
        return await withProfileAccount(scope, signal, context => removeRemoteHostInContext(context, input, signal));
    } catch (error) {
        const result = failure(error, signal);
        return { ok: false, reason: result.status === 'unavailable' ? result.reason : 'unavailable' };
    }
}

export async function removeRemoteHostInContext(context: RemoteHostAccountContext,
    input: Readonly<{ hostId: string; expectedRevision: number | 'absent' }>, signal?: AbortSignal): Promise<RemoteHostMutationResult> {
    try {
        return await admit(context, async (mode, material) => {
            const catalog = await readCapturedRemoteHostCatalogForOperation(context, mode, material, signal);
            if (catalog.status !== 'ready') return { ok: false, reason: 'unavailable' };
            if (catalog.revision !== input.expectedRevision || !catalog.hosts.some(host => host.id === input.hostId))
                return { ok: false, reason: 'changed' };
            const hosts = catalog.hosts.filter(host => host.id !== input.hostId);
            const revisions = await captureRemoteHostResourceRevisions(context, hosts, { host: catalog.hosts[0]!, expectedRevision: catalog.revision }, signal);
            if (!revisions) return { ok: false, reason: 'references-conflict' };
            return mutateRemoteHostCatalogInContext(context, { expectedRevision: input.expectedRevision,
                referencedSavedSecretRevisions: revisions, content: sealRemoteHostCatalogContentV1({ mode, material, record: { v: 1, hosts } }) }, undefined, signal);
        });
    } catch (error) {
        const result = failure(error, signal);
        return { ok: false, reason: result.status === 'unavailable' ? result.reason : 'unavailable' };
    }
}
