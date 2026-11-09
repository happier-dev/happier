import { QualifiedConnectedAccountCredentialMetadataV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { QualifiedConnectedAccountCredentialErrorV4Schema, QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema, QualifiedConnectedAccountConfigurationSnapshotV4Schema, type QualifiedConnectedAccountCredentialSnapshotV4, type QualifiedConnectedAccountCredentialHealthPatchV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedConnectedAccountCredentialPayloadV1Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { parseQualifiedConnectedAccountCredentialPlaintextV1, projectQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { sameQualifiedConnectedAccountRef, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { StoredJsonContentEnvelope } from '@happier-dev/protocol';
import type { ConnectedAccountAttemptSettlementRequest } from './authenticationAttemptOwner.js';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { formatSharedSavedSecretRefV1, parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

type AccountMode = 'plain' | 'e2ee';
type SettlementResult = Readonly<{ status: 'connected'; account: QualifiedConnectedAccountRef }>
    | Readonly<{ status: 'conflict' | 'rejected' | 'unavailable'; code: string }>;
type SettledAccount = Readonly<{ account: QualifiedConnectedAccountRef; accountMode: AccountMode;
    credentialRevision: string; configurationRevision: string | null }>;

/** Credential CAS and lost-ack reconciliation, shared by portable and native hosts. */
export function createConnectedAccountCredentialSettlement(params: Readonly<{
    now(): number;
    resolveAccountMode(usage?: 'fresh-authority'): Promise<AccountMode>;
    seal(kind: 'credential' | 'configuration', mode: AccountMode, payload: unknown): StoredJsonContentEnvelope | Promise<StoredJsonContentEnvelope>;
    open(kind: 'credential' | 'configuration', mode: AccountMode, envelope: StoredJsonContentEnvelope): unknown | Promise<unknown>;
    parseConfigurationContent(content: unknown, revision: string): unknown;
    mutateCredential(mutation: ReturnType<typeof QualifiedConnectedAccountCredentialMutationV4Schema.parse>, request: ConnectedAccountAttemptSettlementRequest): Promise<ReturnType<typeof QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse>>;
    mutateCredentialHealth(patch: ReturnType<typeof QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse>): Promise<void>;
    promoteCredentialSecrets?(input: Readonly<{
        accountMode: AccountMode;
        secrets: readonly Readonly<{ resourceId: string; displayName: string; kind: 'apiKey'; value: string }>[];
        credential: ReturnType<typeof QualifiedConnectedAccountCredentialMutationV4Schema.parse>;
    }>): Promise<Readonly<{ status: 'applied'; credential?: ReturnType<typeof QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse> }>
        | Readonly<{ status: 'conflict' | 'unavailable' | 'outcome_unknown' | 'invalid' }>>;
    /** The existing Saved Secret update owner adopts the resource's own mode and current revision. */
    rotateCredentialSecrets?(input: Readonly<{ secrets: readonly Readonly<{ resourceId: string; value: string }>[] }>):
        Promise<'applied' | 'conflict' | 'unavailable' | 'outcome_unknown'>;
    readCredential(account: QualifiedConnectedAccountRef): Promise<QualifiedConnectedAccountCredentialSnapshotV4 | null>;
    readConfiguration(account: QualifiedConnectedAccountRef): Promise<ReturnType<typeof QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse> | null>;
    readHttpStatus(error: unknown): number | null | undefined;
    readFailureCode(error: unknown): string | null;
    readFailureReason?(error: unknown): unknown;
    onSettled?(input: SettledAccount): Promise<void>;
    onPublicationFailure?(): void;
    onUnknown?(input: Readonly<{ account: QualifiedConnectedAccountRef; reconciliation: boolean;
        failedStage: string; recoveryStage: string; error: unknown; recoveryError: unknown }>): void;
}>): Readonly<{
    settle(request: ConnectedAccountAttemptSettlementRequest): Promise<SettlementResult>;
    reconcile(request: ConnectedAccountAttemptSettlementRequest): Promise<SettlementResult>;
}> {
    const publish = async (input: SettledAccount, request: ConnectedAccountAttemptSettlementRequest): Promise<SettlementResult> => {
        if (request.intent === 'reconnect') {
            // Credential CAS retains prior health. Only a verified reconnect
            // settles its new revision as recovered before reporting success.
            await params.mutateCredentialHealth({ ref: input.account, expectedCredentialRevision: input.credentialRevision,
                expectedConfigurationRevision: input.configurationRevision,
                health: { v: 1, status: 'connected', reconnectRequired: false } });
        }
        try { await params.onSettled?.(input); } catch { params.onPublicationFailure?.(); }
        return { status: 'connected', account: input.account };
    };
    const settle = async (request: ConnectedAccountAttemptSettlementRequest, reconciliation: boolean): Promise<SettlementResult> => {
        const account = { service: request.service, accountId: request.accountId };
        const metadata = QualifiedConnectedAccountCredentialMetadataV4Schema.parse({
            ...(request.credentialKind ? { kind: request.credentialKind } : {}),
            ...(request.providerIdentity ? { providerIdentity: request.providerIdentity } : {}),
            ...(request.authenticationProvenance ? { authenticationProvenance: request.authenticationProvenance } : {}),
            displayName: request.displayName, scopes: request.scopes,
        });
        let stagedConfiguration: unknown;
        if (request.stagedAccountConfigurationContent !== undefined) {
            if (request.intent !== 'connect' || request.expectedCredentialRevision !== null
                || request.expectedCredentialConfigurationRevision !== null) {
                return { status: 'unavailable', code: 'connected_account_settlement_configuration_invalid' };
            }
            try { stagedConfiguration = params.parseConfigurationContent(request.stagedAccountConfigurationContent, request.expectedConfigurationRevision); }
            catch { return { status: 'unavailable', code: 'connected_account_settlement_configuration_invalid' }; }
        }
        let failedStage = 'account_mode';
        let resources = Object.entries(request.credentialSecretResources ?? {});
        const selected = Object.entries(request.credentialSecretRefs ?? {}).map(([key, selection]) => {
            const resource = parseSavedSecretRefV1(selection.ref);
            if (resource.kind !== 'shared_resource') throw new Error('connected_account_credential_secret_unavailable');
            return { key, ...selection, resourceId: resource.resourceId };
        });
        const secretKeys = new Set([...resources.map(([key]) => key), ...selected.map(secret => secret.key)]);
        let references = [...resources.map(([key, resource]) => [key, formatSharedSavedSecretRefV1(resource.resourceId)] as const),
            ...selected.map(secret => [secret.key, secret.ref] as const)];
        let expectedPayload = QualifiedConnectedAccountCredentialPayloadV1Schema.parse({ v: 1,
            values: Object.fromEntries(Object.entries(request.stagedCredentials).filter(([key]) => !secretKeys.has(key))),
            ...(references.length ? { secretRefs: Object.fromEntries(references) } : {}),
        });
        const reconcileCommitted = async (accountMode: AccountMode): Promise<SettlementResult | null> => {
            const committed = await params.readCredential(account);
            if (!committed) return null;
            if (committed.revisionSemantics !== 'revisioned') throw new Error('connected_account_settlement_outcome_unknown');
            if (!sameQualifiedConnectedAccountRef(committed.ref, account)
                || committed.authenticationModeId !== request.authenticationModeId) {
                return { status: 'conflict', code: 'connected_account_settlement_conflict' };
            }
            if (committed.credentialRevision === request.expectedCredentialRevision) return null;
            const payload = parseQualifiedConnectedAccountCredentialPlaintextV1({ ref: account,
                authenticationModeId: committed.authenticationModeId,
                plaintext: await params.open('credential', accountMode, committed.content), metadata: committed.metadata });
            const committedMetadata = { ...committed.metadata };
            if (metadata.authenticationProvenance === undefined) delete committedMetadata.authenticationProvenance;
            if (!pluginJsonValuesEqual(payload, expectedPayload) || !pluginJsonValuesEqual(committedMetadata, metadata)
                || (stagedConfiguration === undefined && committed.configurationRevision !== request.expectedCredentialConfigurationRevision)) {
                return { status: 'conflict', code: 'connected_account_settlement_conflict' };
            }
            if (stagedConfiguration !== undefined) {
                const configuration = await params.readConfiguration(account);
                if (!configuration || configuration.credentialRevision !== committed.credentialRevision
                    || configuration.configurationRevision !== committed.configurationRevision) throw new Error('connected_account_settlement_outcome_unknown');
                let content: unknown;
                try { content = params.parseConfigurationContent(await params.open('configuration', accountMode,
                    configuration.configurationContent), configuration.configurationRevision); }
                catch { throw new Error('connected_account_settlement_outcome_unknown'); }
                if (!pluginJsonValuesEqual(content, stagedConfiguration)) throw new Error('connected_account_settlement_outcome_unknown');
            }
            failedStage = 'credential_health';
            return await publish({ account, accountMode, credentialRevision: committed.credentialRevision,
                configurationRevision: committed.configurationRevision }, request);
        };
        try {
            const accountMode = await params.resolveAccountMode('fresh-authority');
            if (reconciliation) {
                failedStage = 'committed_payload';
                const committed = await reconcileCommitted(accountMode);
                if (committed) return committed;
            }
            if (request.intent === 'reconnect' && resources.length) {
                failedStage = 'held_credential_read';
                const held = await params.readCredential(account);
                if (!held || !sameQualifiedConnectedAccountRef(held.ref, account)
                    || held.authenticationModeId !== request.authenticationModeId || held.revisionSemantics !== 'revisioned'
                    || held.credentialRevision !== request.expectedCredentialRevision
                    || held.configurationRevision !== request.expectedCredentialConfigurationRevision) {
                    return { status: 'conflict', code: 'connected_account_settlement_conflict' };
                }
                const payload = parseQualifiedConnectedAccountCredentialPlaintextV1({ ref: account,
                    authenticationModeId: held.authenticationModeId, plaintext: await params.open('credential', accountMode, held.content),
                    metadata: held.metadata });
                const rotations = resources.flatMap(([key]) => {
                    const reference = payload.secretRefs?.[key];
                    if (!reference) return [];
                    const resource = parseSavedSecretRefV1(reference);
                    if (resource.kind !== 'shared_resource') throw new Error('connected_account_credential_secret_unavailable');
                    return [{ key, resourceId: resource.resourceId, ref: reference, value: request.stagedCredentials[key]! }];
                });
                if (rotations.length) {
                    // The credential envelope cannot prove an unacknowledged resource update.
                    // Do not replay it on reconciliation; the person can deliberately retry reconnect.
                    if (reconciliation || !params.rotateCredentialSecrets) return { status: 'unavailable',
                        code: 'connected_account_authentication_reconciliation_unavailable' };
                    const heldRefs = new Map(rotations.map(secret => [secret.key, secret.ref]));
                    resources = resources.filter(([key]) => !heldRefs.has(key));
                    references = references.map(([key, reference]) => [key,
                        heldRefs.get(key) ?? reference] as const);
                    expectedPayload = QualifiedConnectedAccountCredentialPayloadV1Schema.parse({ ...expectedPayload,
                        secretRefs: Object.fromEntries(references) });
                    failedStage = 'credential_rotation';
                    const outcome = await params.rotateCredentialSecrets({ secrets: rotations.map(({ resourceId, value }) => ({ resourceId, value })) });
                    if (outcome === 'conflict') return { status: 'conflict', code: 'connected_account_settlement_conflict' };
                    if (outcome === 'unavailable') return { status: 'unavailable', code: 'connected_account_credential_persistence_unavailable' };
                    if (outcome === 'outcome_unknown') throw new Error('connected_account_settlement_outcome_unknown');
                }
            }
            failedStage = 'credential_materialization';
            const content = await params.seal('credential', accountMode, projectQualifiedConnectedAccountCredentialPlaintextV1({
                ref: account, authenticationModeId: request.authenticationModeId, payload: expectedPayload,
                metadata: { ...(metadata.providerIdentity ? { providerIdentity: metadata.providerIdentity } : {}), scopes: metadata.scopes }, now: params.now(),
            }));
            const initialConfiguration = request.expectedCredentialRevision === null && stagedConfiguration !== undefined
                ? { expectedConfigurationRevision: null, replacementContentEnvelope: await params.seal('configuration', accountMode, stagedConfiguration) } : undefined;
            failedStage = 'credential_write';
            const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse({
                ref: account, authenticationModeId: request.authenticationModeId,
                directExportContract: request.directExportContract ?? null,
                savedSecretResourceIds: [...new Set(references.map(([, reference]) => {
                    const resource = parseSavedSecretRefV1(reference);
                    if (resource.kind !== 'shared_resource') throw new Error('connected_account_credential_secret_unavailable');
                    return resource.resourceId;
                }))],
                ...(selected.length ? { savedSecretRevisions: selected.map(secret => ({ resourceId: secret.resourceId,
                    expectedRevision: secret.resourceRevision })) } : {}),
                ...(request.contributionContractVersion ? { contributionContractVersion: request.contributionContractVersion } : {}),
                content, metadata, expectedCredentialRevision: request.expectedCredentialRevision,
                ...(request.expectedCredentialRevision === null ? (initialConfiguration ? { initialConfiguration } : {})
                    : { expectedConfigurationRevision: request.expectedCredentialConfigurationRevision }),
            });
            let acknowledgement: ReturnType<typeof QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse>;
            if (resources.length) {
                if (!params.promoteCredentialSecrets) return { status: 'unavailable', code: 'connected_account_credential_persistence_unavailable' };
                const outcome = await params.promoteCredentialSecrets({ accountMode, credential: mutation,
                    secrets: resources.map(([key, resource]) => ({ ...resource, kind: 'apiKey', value: request.stagedCredentials[key]! })) });
                if (outcome.status !== 'applied') {
                    if (outcome.status === 'conflict') return { status: 'conflict', code: 'connected_account_settlement_conflict' };
                    if (outcome.status === 'unavailable' || outcome.status === 'invalid') return { status: 'unavailable', code: 'connected_account_credential_persistence_unavailable' };
                    throw new Error('connected_account_settlement_outcome_unknown');
                }
                if (!outcome.credential) throw new Error('connected_account_settlement_outcome_unknown');
                acknowledgement = outcome.credential;
            } else {
                acknowledgement = await params.mutateCredential(mutation, request);
            }
            failedStage = 'credential_receipt';
            if (initialConfiguration ? acknowledgement.configurationRevision === null
                : acknowledgement.configurationRevision !== request.expectedCredentialConfigurationRevision) {
                throw new Error('Qualified Connected Account settlement did not commit the exact configuration basis');
            }
            failedStage = 'credential_health';
            return await publish({ account, accountMode, credentialRevision: acknowledgement.credentialRevision,
                configurationRevision: acknowledgement.configurationRevision }, request);
        } catch (error) {
            const code = params.readFailureCode(error);
            if (code === 'revision_conflict') return { status: 'conflict', code: 'connected_account_settlement_conflict' };
            const reason = params.readFailureReason?.(error);
            const refusal = QualifiedConnectedAccountCredentialErrorV4Schema.safeParse({ error: code,
                ...(code === 'connect_credential_mutation_superseded' ? {
                    reason: reason ?? 'concurrent_mutation', credentialRevision: null, configurationRevision: null,
                } : code === 'managed_resources_review_required' ? { resources: [] } : {}),
            });
            if (refusal.success || params.readHttpStatus(error) === 409) {
                return { status: 'conflict', code: refusal.success
                    ? refusal.data.error === 'connect_credential_mutation_superseded' && reason != null
                        ? `${refusal.data.error}.${refusal.data.reason}` : refusal.data.error
                    : 'connected_account_settlement_conflict' };
            }
            if (failedStage === 'committed_payload') throw error;
            if (failedStage === 'held_credential_read') return { status: 'unavailable', code: 'connected_account_credential_persistence_unavailable' };
            if (failedStage === 'credential_health') {
                params.onUnknown?.({ account, reconciliation, failedStage, recoveryStage: 'health_update_not_replayed', error, recoveryError: error });
                throw error;
            }
            if (failedStage === 'credential_rotation') {
                params.onUnknown?.({ account, reconciliation, failedStage, recoveryStage: 'resource_update_not_replayed', error, recoveryError: error });
                throw error;
            }
            try {
                const committed = await reconcileCommitted(await params.resolveAccountMode());
                if (committed) return committed;
                throw error;
            } catch (recoveryError) {
                params.onUnknown?.({ account, reconciliation, failedStage, recoveryStage: 'committed_payload', error, recoveryError });
                throw error;
            }
        }
    };
    return Object.freeze({ settle: request => settle(request, false), reconcile: request => settle(request, true) });
}
