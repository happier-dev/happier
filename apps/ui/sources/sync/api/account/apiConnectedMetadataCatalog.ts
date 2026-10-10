import { loadConnectedMetadataCatalogV1, type ConnectedMetadataCatalogV1 } from '@happier-dev/protocol/connect/connectedMetadataCatalogV1';
import {
    CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1,
    ConnectedPresentationRowReadResponseV1Schema, ConnectedAcknowledgementsRowReadResponseV1Schema,
    ConnectedPresentationRowMutationV1Schema, ConnectedAcknowledgementsRowMutationV1Schema,
    ConnectedMetadataRowMutationResponseV1Schema, sealConnectedPresentationContentV1, sealConnectedAcknowledgementsContentV1,
    applyConnectedPresentationMutationV1, applyConnectedAcknowledgementMutationV1, removeConnectedMetadataSubjectV1,
    removeLegacyConnectedMetadataSubjectV1,
    connectedEntitySubjectKeyV1, connectedDisclosureSubjectKeyV1,
    type ConnectedPresentationRecordV1, type ConnectedAcknowledgementsRecordV1,
    type QualifiedConnectedEntityRef, type QualifiedAcknowledgementSubject, type LegacyConnectedMetadataInventoryV1,
    type QualifiedConnectedDisclosureSubject, type ConnectedDisclosureEntryV1,
} from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { CapturedAccountSettingsRequest } from './accountSettingsRequest';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { AccountStorageCurrentnessUnavailableError, resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { normalizeAccountSettingsHistoryAfterTransfer } from '@/sync/engine/settings/accountSettingsHistoryRestore';
import { fetchAndApplyProfile } from '@/sync/engine/account/syncAccount';
import type { Profile } from '@/sync/domains/profiles/profile';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import { AGENT_IDS, BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveConnectedServiceCollapseKey, setConnectedServiceItemCollapsed } from '@/sync/domains/connectedServices/resolveConnectedServiceCollapseKey';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';

export type ConnectedMetadataAccountContext = Awaited<ReturnType<typeof import('@/sync/ops/actions/actionAccountContext').captureLazyActionAccountContext>>;
type CapturedRead = Pick<CapturedAccountSettingsRequest, 'request' | 'isCurrent'>;
type MutationResult = ReturnType<typeof ConnectedMetadataRowMutationResponseV1Schema.parse>;
export class ConnectedMetadataRowOperationError extends Error {
    constructor(readonly code: string, readonly cause?: unknown) { super(code); this.name = 'ConnectedMetadataRowOperationError'; }
}
function assertReadCurrent(captured: CapturedRead): void {
    if (!captured.isCurrent()) throw new ConnectedMetadataRowOperationError('scope-retired');
}
async function rawRead(captured: CapturedRead, route: string, signal?: AbortSignal): Promise<unknown> {
    assertReadCurrent(captured);
    const response = await captured.request(route, { method: 'GET', signal }, { retry: 'none' });
    assertReadCurrent(captured);
    if (!response.ok) throw new ConnectedMetadataRowOperationError(response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable');
    const value: unknown = await response.json();
    assertReadCurrent(captured);
    return value;
}
/** Conversion borrows its initiating Home request; these readers never recapture ambient state. */
export async function apiReadConnectedPresentationRow(captured: CapturedRead, signal?: AbortSignal) {
    return ConnectedPresentationRowReadResponseV1Schema.parse(await rawRead(captured, CONNECTED_PRESENTATION_ROWS_ROUTE_V1, signal));
}
export async function apiReadConnectedAcknowledgementsRow(captured: CapturedRead, signal?: AbortSignal) {
    return ConnectedAcknowledgementsRowReadResponseV1Schema.parse(await rawRead(captured, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, signal));
}
async function admit<T>(context: ConnectedMetadataAccountContext,
    operation: (mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null) => Promise<T>): Promise<T> {
    const { encryption } = await context.resolveAccountEncryption();
    const current = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    context.assertCurrent();
    return operation(current.mode, current.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials));
}
async function assertModeCurrent(context: ConnectedMetadataAccountContext, mode: 'plain' | 'e2ee'): Promise<void> {
    const current = await resolveAccountStorageContext(context.credentials, {
        encryption: (await context.resolveAccountEncryption()).encryption, request: context.request,
    });
    context.assertCurrent();
    if (current.mode !== mode) throw new ConnectedMetadataRowOperationError('account-mode-mismatch');
}
async function withAccount<T>(scope: ServerAccountScope | undefined,
    operation: (context: ConnectedMetadataAccountContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(scope?.serverId ?? getActiveServerSnapshot().serverId, signal);
    try {
        if (scope && context.accountId !== scope.accountId) throw new ConnectedMetadataRowOperationError('scope-retired');
        return await operation(context);
    } finally { context.dispose(); }
}
/** Only a freshly admitted complete Account profile can qualify legacy subjects or a new label. */
export async function readConnectedMetadataProfileInContext(context: ConnectedMetadataAccountContext): Promise<Profile> {
    const capture: { profile: Profile | null } = { profile: null };
    await fetchAndApplyProfile({ credentials: context.credentials, request: context.request,
        shouldContinue: context.accountLifetime.isCurrent, applyProfile: profile => { capture.profile = profile; } });
    context.assertCurrent();
    const profile = capture.profile;
    if (!profile || profile.id !== context.accountId) throw new ConnectedMetadataRowOperationError('inventory-unavailable');
    return profile;
}
async function readInventory(context: ConnectedMetadataAccountContext): Promise<LegacyConnectedMetadataInventoryV1> {
    const profile = await readConnectedMetadataProfileInContext(context);
    return { entities: [
        ...profile.connectedAccountsV4.map(account => ({ kind: 'account' as const, account: account.ref })),
        ...profile.connectedAccountGroupsV4.map(group => ({ kind: 'group' as const, ...group.ref })),
    ], agents: AGENT_IDS.map(legacyAgentId => ({ legacyAgentId,
        agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[legacyAgentId] }) })), disclosureSubjects: [
        ...profile.connectedAccountsV4.map(account => ({ kind: 'account' as const, account: account.ref })),
        ...profile.connectedAccountGroupsV4.flatMap(group => group.members.map(member => ({ kind: 'group-member' as const,
            group: group.ref, accountId: member.connectedAccountId }))),
    ] };
}
type Write<Record> = Readonly<{ record: Record; expectedRevision: number | 'absent'; sourceSettingsVersion?: number }>;
async function writeRow(context: ConnectedMetadataAccountContext, route: string, body: unknown, signal?: AbortSignal): Promise<MutationResult> {
    context.assertCurrent();
    let response: Response;
    try {
        response = await context.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal }, { retry: 'none' });
    } catch (error) {
        throw new ConnectedMetadataRowOperationError(classifyHttpMutationRequestFailure({ error, issued: true, signal }), error);
    }
    const result = ConnectedMetadataRowMutationResponseV1Schema.safeParse(await response.json().catch(() => null));
    if (!result.success) throw new ConnectedMetadataRowOperationError(response.ok || response.status >= 500 ? 'outcome_unknown' : `connected_metadata_http_${response.status}`);
    return result.data;
}
function writePresentation(context: ConnectedMetadataAccountContext, input: Write<ConnectedPresentationRecordV1>, signal?: AbortSignal) {
    return admit(context, (mode, material) => writeRow(context, CONNECTED_PRESENTATION_ROWS_ROUTE_V1,
        ConnectedPresentationRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision,
            content: sealConnectedPresentationContentV1({ mode, material, record: input.record, randomBytes: getRandomBytes }),
            ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }) }), signal));
}
function writeAcknowledgements(context: ConnectedMetadataAccountContext, input: Write<ConnectedAcknowledgementsRecordV1>, signal?: AbortSignal) {
    return admit(context, (mode, material) => writeRow(context, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1,
        ConnectedAcknowledgementsRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision,
            content: sealConnectedAcknowledgementsContentV1({ mode, material, record: input.record, randomBytes: getRandomBytes }),
            ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }) }), signal));
}
type Publication = Readonly<{ onReady?: (projection: ConnectedMetadataCatalogV1, isCurrent: () => boolean) => void; hasPendingCleanup?: () => boolean }>;
function disclosureKey(context: ConnectedMetadataAccountContext, subject: QualifiedConnectedDisclosureSubject): string {
    return resolveConnectedServiceCollapseKey({ scope: { serverId: context.serverId, accountId: context.accountId },
        service: subject.kind === 'account' ? subject.account.service : subject.group.service,
        profileId: subject.kind === 'account' ? subject.account.accountId : subject.accountId,
        ...(subject.kind === 'group-member' ? { groupId: subject.group.groupId } : {}) });
}
async function persistDisclosure(context: ConnectedMetadataAccountContext, entries: readonly ConnectedDisclosureEntryV1[]): Promise<void> {
    const { storage } = await import('@/sync/domains/state/storageStore');
    context.assertCurrent();
    let keys = { ...storage.getState().localSettings.collapsedGroupKeysV1 };
    for (const entry of entries) {
        const key = disclosureKey(context, entry.subject);
        // An existing device choice wins over an Account-source import.
        if (!Object.hasOwn(keys, key)) keys = setConnectedServiceItemCollapsed(keys, key, entry.collapsed, entry.subject.kind === 'group-member');
    }
    // The incumbent owner synchronously persists through MMKV before returning.
    storage.getState().applyLocalSettings({ collapsedGroupKeysV1: keys }, { source: 'ui' });
}
export async function readConnectedMetadataCatalogInContext(context: ConnectedMetadataAccountContext, signal?: AbortSignal,
    publication?: Publication, maintenance = true): Promise<ConnectedMetadataCatalogV1> {
    return admit(context, async (mode, material) => {
        const result = await loadConnectedMetadataCatalogV1({ mode, material, signal,
        readPresentationRow: () => apiReadConnectedPresentationRow({ request: context.request, isCurrent: context.accountLifetime.isCurrent }, signal),
        readAcknowledgementsRow: () => apiReadConnectedAcknowledgementsRow({ request: context.request, isCurrent: context.accountLifetime.isCurrent }, signal),
        hasPendingCleanup: publication?.hasPendingCleanup,
        ...(publication?.onReady ? { onReadyBeforeCleanup: async catalog => { await assertModeCurrent(context, mode); publication.onReady!(catalog, context.accountLifetime.isCurrent); } } : {}),
        ...(maintenance ? { transfer: {
            readSourceSnapshot: async () => {
                const source = await readAccountSettingsBaseline({ credentials: context.credentials, encryption: (await context.resolveAccountEncryption()).encryption,
                    accountMode: mode, request: (path, init) => context.request(path, init, { retry: 'none' }) });
                context.assertCurrent(); return { raw: source.raw ?? {}, version: source.version };
            },
            readInventory: () => readInventory(context),
            persistDisclosure: entries => persistDisclosure(context, entries),
            initializePresentation: input => writePresentation(context, input, signal),
            initializeAcknowledgements: input => writeAcknowledgements(context, input, signal),
            replaceSource: async input => {
                context.assertCurrent();
                const result = await context.mutateRawSettings(() => ({ ...input.raw }), {
                    expectedSettingsVersion: input.expectedVersion, rebaseOnConflict: false, observeOutcome: true,
                });
                context.assertCurrent(); return result;
            },
            normalizeHistory: async authority => normalizeAccountSettingsHistoryAfterTransfer({
                credentials: context.credentials, encryption: (await context.resolveAccountEncryption()).encryption,
                settingsScope: { serverId: context.serverId, accountId: context.accountId }, destinationAuthority: authority,
                requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent },
            }),
        } } : {}),
        });
        await assertModeCurrent(context, mode);
        return result;
    });
}
async function readForMutation(context: ConnectedMetadataAccountContext, domain: 'presentation' | 'acknowledgements', signal?: AbortSignal) {
    const current = await readConnectedMetadataCatalogInContext(context, signal, undefined, false);
    const snapshot = current[domain];
    return snapshot.status === 'unavailable' && snapshot.reason === 'authority-not-confirmed'
        ? readConnectedMetadataCatalogInContext(context, signal) : current;
}
export async function readConnectedMetadataCatalogProjection(scope: ServerAccountScope, signal?: AbortSignal,
    assertCurrent?: () => void, publication?: Publication): Promise<ConnectedMetadataCatalogV1> {
    try {
        assertCurrent?.();
        return await withAccount(scope, context => { assertCurrent?.(); return readConnectedMetadataCatalogInContext(context, signal, publication); }, signal);
    } catch (error) {
        const reason = signal?.aborted ? 'cancelled'
            : error instanceof AccountStorageCurrentnessUnavailableError ? error.reason
                : error instanceof ConnectedMetadataRowOperationError ? error.code : 'unreachable';
        return { presentation: { status: 'unavailable', reason }, acknowledgements: { status: 'unavailable', reason }, disclosure: [] };
    }
}
function requireUpdated(result: MutationResult): void {
    if (result.status !== 'updated') throw new ConnectedMetadataRowOperationError(result.status, result);
}
async function publishReceipt(context: ConnectedMetadataAccountContext): Promise<void> {
    try {
        const { invalidateConnectedMetadataCatalogAfterAcknowledgedMutation } = await import('@/sync/engine/settings/connectedMetadataCatalogEngine');
        await invalidateConnectedMetadataCatalogAfterAcknowledgedMutation({ serverId: context.serverId, accountId: context.accountId }, context.assertAccountCurrent);
    } catch { /* Projection failure does not erase a durable receipt. */ }
}
export async function setConnectedLabelInContext(context: ConnectedMetadataAccountContext,
    input: Readonly<{ subject: QualifiedConnectedEntityRef; label: string | null }>, signal?: AbortSignal): Promise<void> {
    if (input.label !== null) {
        const inventory = await readInventory(context);
        if (!inventory.entities.some(subject => connectedEntitySubjectKeyV1(subject) === connectedEntitySubjectKeyV1(input.subject))) {
            throw new ConnectedMetadataRowOperationError('connected_metadata_subject_not_owned');
        }
    }
    const catalog = await readForMutation(context, 'presentation', signal);
    if (catalog.presentation.status !== 'ready') throw new ConnectedMetadataRowOperationError('incomplete-catalog');
    requireUpdated(await writePresentation(context, { expectedRevision: catalog.presentation.revision,
        record: applyConnectedPresentationMutationV1({ v: 1, entries: [...catalog.presentation.entries] }, input) }, signal));
    await publishReceipt(context);
}
export async function setConnectedAcknowledgementInContext(context: ConnectedMetadataAccountContext,
    input: Readonly<{ subject: QualifiedAcknowledgementSubject; acknowledged: boolean | null }>, signal?: AbortSignal): Promise<void> {
    if (input.acknowledged !== null && input.subject.kind === 'adoption') {
        const inventory = await readInventory(context);
        const subject: QualifiedConnectedEntityRef = { kind: 'group', service: input.subject.service, groupId: input.subject.groupId };
        if (!inventory.entities.some(candidate => connectedEntitySubjectKeyV1(candidate) === connectedEntitySubjectKeyV1(subject))) {
            throw new ConnectedMetadataRowOperationError('connected_metadata_subject_not_owned');
        }
    }
    const catalog = await readForMutation(context, 'acknowledgements', signal);
    if (catalog.acknowledgements.status !== 'ready') throw new ConnectedMetadataRowOperationError('incomplete-catalog');
    requireUpdated(await writeAcknowledgements(context, { expectedRevision: catalog.acknowledgements.revision,
        record: applyConnectedAcknowledgementMutationV1({ v: 1, entries: [...catalog.acknowledgements.entries] }, input) }, signal));
    await publishReceipt(context);
}
/** Invocation-local capture, not a persisted cleanup ledger or a new authority. */
export type PreparedConnectedMetadataCleanup = Readonly<{
    subjectKey: string;
    disclosureKeys: readonly string[];
    source?: Readonly<{ originalRaw: Readonly<Record<string, unknown>>; raw: Readonly<Record<string, unknown>>;
        version: number; mode: 'plain' | 'e2ee'; incomplete: boolean }>;
    failure?: unknown;
}>;
export async function prepareConnectedMetadataCleanupInContext(context: ConnectedMetadataAccountContext,
    subject: QualifiedConnectedEntityRef, signal?: AbortSignal): Promise<PreparedConnectedMetadataCleanup> {
    const subjectKey = connectedEntitySubjectKeyV1(subject);
    let disclosureKeys: readonly string[] = [];
    try {
        const inventory = await readInventory(context);
        disclosureKeys = (inventory.disclosureSubjects ?? []).filter(candidate => subject.kind === 'account'
            ? sameQualifiedConnectedAccountRef(candidate.kind === 'account' ? candidate.account
                : { service: candidate.group.service, accountId: candidate.accountId }, subject.account)
            : candidate.kind === 'group-member' && connectedEntitySubjectKeyV1({ kind: 'group', ...candidate.group }) === subjectKey)
            .map(candidate => disclosureKey(context, candidate));
        // Establish absent row authority while the subject can still be qualified.
        const catalog = await readConnectedMetadataCatalogInContext(context, signal);
        const failure = catalog.cleanup?.status === 'cleanup-pending'
            ? new ConnectedMetadataRowOperationError(catalog.cleanup.reason) : undefined;
        return await admit(context, async mode => {
            const source = await context.readRawSettingsSnapshot();
            context.assertCurrent();
            const next = removeLegacyConnectedMetadataSubjectV1({ raw: source.raw, inventory, subject });
            return { subjectKey, disclosureKeys, source: { originalRaw: source.raw, raw: next.raw,
                version: source.version, mode, incomplete: next.diagnostics.length > 0 },
                ...(failure ? { failure } : {}) };
        });
    } catch (failure) {
        // Local keys qualified before a later source refusal remain usable only
        // in this same captured Account. The primary delete is still independent.
        return { subjectKey, disclosureKeys, failure };
    }
}
export async function cleanupConnectedMetadataInContext(context: ConnectedMetadataAccountContext,
    subject: QualifiedConnectedEntityRef, signal?: AbortSignal, prepared?: PreparedConnectedMetadataCleanup): Promise<void> {
    // Never seed or requalify historical subjects after their identity disappeared.
    const catalog = await readConnectedMetadataCatalogInContext(context, signal, undefined, false);
    const oldPresentation: ConnectedPresentationRecordV1 = { v: 1,
        entries: catalog.presentation.status === 'ready' ? [...catalog.presentation.entries] : [] };
    const oldAcknowledgements: ConnectedAcknowledgementsRecordV1 = { v: 1,
        entries: catalog.acknowledgements.status === 'ready' ? [...catalog.acknowledgements.entries] : [] };
    const next = removeConnectedMetadataSubjectV1({ presentation: oldPresentation, acknowledgements: oldAcknowledgements, subject });
    let failure: unknown = catalog.presentation.status === 'ready' && catalog.acknowledgements.status === 'ready'
        ? null : new ConnectedMetadataRowOperationError('incomplete-catalog');
    if (catalog.presentation.status === 'ready' && JSON.stringify(next.presentation) !== JSON.stringify(oldPresentation)) {
        try { requireUpdated(await writePresentation(context, { record: next.presentation, expectedRevision: catalog.presentation.revision }, signal)); }
        catch (error) { failure = error; }
    }
    if (catalog.acknowledgements.status === 'ready' && JSON.stringify(next.acknowledgements) !== JSON.stringify(oldAcknowledgements)) {
        try { requireUpdated(await writeAcknowledgements(context, { record: next.acknowledgements, expectedRevision: catalog.acknowledgements.revision }, signal)); }
        catch (error) { failure ??= error; }
    }
    try {
        if (!prepared || prepared.subjectKey !== connectedEntitySubjectKeyV1(subject)) {
            throw new ConnectedMetadataRowOperationError('connected_metadata_cleanup_not_prepared');
        }
        const { storage } = await import('@/sync/domains/state/storageStore');
        context.assertCurrent();
        const keys = { ...storage.getState().localSettings.collapsedGroupKeysV1 };
        for (const key of prepared.disclosureKeys) delete keys[key];
        storage.getState().applyLocalSettings({ collapsedGroupKeysV1: keys }, { source: 'ui' });
        if (prepared.source) {
            const source = prepared.source;
            if (JSON.stringify(source.raw) !== JSON.stringify(source.originalRaw)) {
                await assertModeCurrent(context, source.mode);
                const receipt = await context.mutateRawSettings(() => ({ ...source.raw }), {
                    expectedSettingsVersion: source.version, rebaseOnConflict: false, observeOutcome: true,
                });
                if (receipt.status !== 'applied') throw new ConnectedMetadataRowOperationError(receipt.status, receipt);
            }
            if (source.incomplete) throw new ConnectedMetadataRowOperationError('connected_metadata_source_incomplete');
            if (prepared.failure !== undefined) throw prepared.failure;
        } else throw prepared.failure ?? new ConnectedMetadataRowOperationError('connected_metadata_cleanup_not_prepared');
    } catch (error) { failure ??= error; }
    await publishReceipt(context);
    if (failure) throw failure;
}
export function setConnectedLabel(input: Readonly<{ subject: QualifiedConnectedEntityRef; label: string | null }>, scope?: ServerAccountScope): Promise<void> {
    return withAccount(scope, context => setConnectedLabelInContext(context, input));
}
export function setConnectedAcknowledgement(input: Readonly<{ subject: QualifiedAcknowledgementSubject; acknowledged: boolean | null }>, scope?: ServerAccountScope): Promise<void> {
    return withAccount(scope, context => setConnectedAcknowledgementInContext(context, input));
}
export async function setConnectedDisclosureInContext(context: ConnectedMetadataAccountContext,
    input: Readonly<{ subject: QualifiedConnectedDisclosureSubject; collapsed: boolean | null }>): Promise<void> {
    if (input.collapsed !== null) {
        const inventory = await readInventory(context);
        if (!inventory.disclosureSubjects?.some(subject => connectedDisclosureSubjectKeyV1(subject) === connectedDisclosureSubjectKeyV1(input.subject))) {
            throw new ConnectedMetadataRowOperationError('connected_metadata_subject_not_owned');
        }
    }
    const { storage } = await import('@/sync/domains/state/storageStore');
    context.assertCurrent();
    const key = disclosureKey(context, input.subject);
    let keys = { ...storage.getState().localSettings.collapsedGroupKeysV1 };
    if (input.collapsed === null) delete keys[key];
    else keys = setConnectedServiceItemCollapsed(keys, key, input.collapsed, input.subject.kind === 'group-member');
    storage.getState().applyLocalSettings({ collapsedGroupKeysV1: keys }, { source: 'ui' });
}
