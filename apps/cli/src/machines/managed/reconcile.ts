import { createExternalActionRequesterServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { projectManagedMachineRolePurposeBindingsV1, readManagedMachineRoleCredentialConfigurationsV1,
    readManagedOpaquePresetAcquireEffectDigestV1, type ManagedNativeChannelIO } from '@happier-dev/cli-common/machines/managed';
import { captureManagedMachineRoleCredentialConfigurationsV1 } from '@happier-dev/cli-common/machines/managed/reconcile';
import type { ConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import { generateKeyPair, randomBytes, randomUUID } from 'node:crypto';
import { readManagedGuestHomeWarning, resolveManagedGuestHome } from './homeQualification';
import { join } from 'node:path';
import { reconcileManagedMachine as reconcileManagedMachineShared, reconcileManagedAcquisitionIdentity as reconcileManagedAcquisitionIdentityShared,
    createManagedNativeBootstrapIO, createManagedBootstrapSshCredential, readManagedBootstrapCredential, bindManagedMachineRoleCredentials,
    createManagedOpaquePresetReviewedChildPortV1, buildManagedBootstrapInput, type ManagedReconciliationEnrollment } from '@happier-dev/cli-common/machines/managed';
import tweetnacl from 'tweetnacl';
import { sameAccountEncryptionIdentity } from '@happier-dev/sync-client';
import { SharedSavedSecretCreateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createAccountScopedCryptoMaterialSnapshotV1, resolveAccountContentSecretKey } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { ActionExecutorContext, JsonValue } from '@happier-dev/protocol';
import type { ActionOperationProgressV1, ManagedMachineBootstrapPromptV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ManagedMachineFullV1, ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { readManagedMachineRequesterEnrollmentAccountIdV1 } from '@happier-dev/protocol/machines/managed/enrollmentIdentityV1';
import type { DevcontainerRebuildIntentV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { ManagedMachineActionIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1, MANAGED_RESIZE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import type { AdmittedManagedProviderOperationExecutionRequest } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { projectContributedActionFailure } from '@/plugins/runtime/invocation/actions/contributedActionFailure';
import type { ManagedNativeCredentialInvocationBinding, PluginExternalActionContext } from '@/plugins/runtime/invocation/services/types';
import { createPrivateBearerCredential } from '@/daemon/privateBearerFile';
import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createManagedNativeObservationWait } from './nativeObservationWait';
import { ManagedMachineControllerError, ManagedMachineNativeEffectGuardRefusal, readManagedNativeFailureDetails } from './controllerErrors';
import type { ManagedMachineAcquisitionDriverInput, ManagedMachineControllerClient, ManagedMachineExecutionOptions } from './acquire';
import { sshPublicKey } from './bootstrapSshPublicKey';
import { isRetryableHomeOperationError, type HomeOperationRetry } from '@/api/client/retryHomeOperation';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { initializeManagedMachineEnrollmentPolicies } from './enrollmentPolicy';
import { readManagedOpaquePresetReview } from './presetHydration';
import type { ManagedPresetHydrator } from './presetHydration';
import { readManagedMachinePresetPreparationV1 } from '@happier-dev/cli-common/machines/managed';
import type { ManagedMachinePresetPreparationBindingV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1';
import { resolveManagedGuestCliBuildIdentity } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { readManagedGuestCliLocalBuildPayloadMetadata } from '@happier-dev/cli-common/systemTasks/kinds/remoteFirstPartyPayloadInstaller';
import { MachineProvisionerPreparationInspectResultV1Schema, readMachineProvisionerActionRolesV1,
    readMachineProvisionerPreparedLaunchV1, type MachineProvisionerRoleV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { rebuildManagedPresetAtFirstUse } from './presetPreparationRebuild';

export type ManagedMachineReconciliationInput = Readonly<{
    input: ManagedMachineAcquisitionDriverInput;
    options: ManagedMachineExecutionOptions;
    client: ManagedMachineControllerClient;
    machine: ManagedMachineFullV1;
    action: ManagedMachineActionIdV1;
    includeGuestDiagnostics?: true;
    /** Home-issued snapshot from this explicit Retry root's verified admission. */
    guestCli?: import('@happier-dev/protocol/features').GuestCliIdentityV1;
    rebuild?: DevcontainerRebuildIntentV1;
    hydrator?: ManagedPresetHydrator;
    credentialConfigurations?: ManagedMachinePresetPreparationBindingV1['credentialConfigurations'];
}>;

/**
 * The authority of an already-admitted Session spawn over its own placement
 * target (P03 container Sessions). It is one more authority source of this
 * owner, not a second invocation path: it admits transport preparation and the
 * Session holder's channel roles (`bootstrap`, `exec`, `putFile`, `stream`) on a row this
 * controller controls, and ends with the Session: `lifetime` aborts on Stop,
 * exit or untrack and aborts every invocation still running under it.
 * Requester access to the row is decided by the Session spawn admission
 * before it constructs this authority.
 */
export type ManagedSessionTargetAuthority = Readonly<{
    sessionId: string;
    /** The tracked Session's lifetime; its abort ends the authority and every running channel. */
    lifetime: AbortSignal;
}>;
/** An Account graph relationship already admitted by the sync lifecycle owner. */
export type ManagedWorkspaceSyncTargetAuthority = Readonly<{
    relationshipId: string;
    lifetime: AbortSignal;
}>;
const MANAGED_TARGET_ROLES: ReadonlySet<string> = new Set(['bootstrap', 'exec', 'putFile', 'stream']);

/**
 * The retained-row check shared by admitted Session and Account sync targets:
 * every call: controlled by this controller and installation, in this Home,
 * bound to a resource and not being deleted. The guest each channel reaches is
 * the row's own resource, so a rebuild (new resource) ends the authority too.
 */
function managedTargetRow(row: ManagedMachineV1, input: Readonly<{ homeId: string; controller: Readonly<{ machineId: string; installationId: string }> }>) {
    const admitted = row.controller?.machineId === input.controller.machineId && row.controller.installationId === input.controller.installationId
        && row.homeId === input.homeId && row.allocation === 'bound' && row.desired !== 'delete' && row.archivedAt === undefined;
    return admitted && row.resource ? row.resource.value : undefined;
}

type ManagedNativeInvocationInput = ManagedMachineReconciliationInput | (Omit<ManagedMachineReconciliationInput, 'action' | 'client'> & Readonly<{
    action: 'deployments.backups.restore';
}>) | (Omit<ManagedMachineReconciliationInput, 'action' | 'client'> & Readonly<{
    action: 'session.spawn_new';
    sessionTarget: ManagedSessionTargetAuthority;
}>) | (Omit<ManagedMachineReconciliationInput, 'action' | 'client'> & Readonly<{
    action: 'workspace.sync.relationship.create';
    workspaceSyncTarget: ManagedWorkspaceSyncTargetAuthority;
}>);

export async function resolveManagedRoleCredentialAuthorizations(input: ManagedMachineAcquisitionDriverInput, provider: ManagedMachineFullV1['launch']['provider'], localId: string,
    credentials: ManagedMachineFullV1['launch']['credentials'], qualification?: Readonly<{ descriptor: MachineProvisionerContributionV1; launch: unknown }>) {
    const { resolveRegistryConnectedAccountActionPurposeAuthorizations } = await import('@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations');
    const declarations = resolveRegistryConnectedAccountActionPurposeAuthorizations({
        registry: input.runtimeRegistry.contributes,
        qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: provider.pluginId, localId }),
        resolveOptionalAccess: input.runtimeRegistry.resolveOptionalAccess,
    });
    if (!declarations) throw new ManagedMachineControllerError('provider_unavailable');
    return bindManagedMachineRoleCredentials({ authorizations: declarations, provider, credentials, qualification });
}

/** Controller placement and a portable role's execution realm are independent. */
export async function resolveManagedRoleRuntime(input: ManagedMachineAcquisitionDriverInput, pluginId: string, localId: string): Promise<ManagedMachineAcquisitionDriverInput> {
    const action = input.runtimeRegistry.contributes.actionsById?.get(buildQualifiedPluginContributionKey({ pluginId, localId }));
    if (action?.admittedTarget?.declaration.execution.target !== 'account' || input.runtimeRegistry.executionRealm === 'account') return input;
    if (!input.resolveAccountRuntime) throw new ManagedMachineControllerError('provider_unavailable');
    return { ...input, ...await input.resolveAccountRuntime() };
}

function assertBootstrapCredentialAccount(params: ManagedNativeInvocationInput, machine: ManagedMachineFullV1): void {
    // The server owns custody authorization. This only binds the local
    // Account's material to that already verified controller custodian.
    if (params.input.credentials.token !== params.input.token
        || readAccountIdFromToken(params.input.credentials.token) !== machine.custodianAccountId) {
        throw new ManagedMachineControllerError('credential_unavailable');
    }
}

type BootstrapCredentialValue = Readonly<{
    value: string; guestHostPrivateKey?: string; guestHostPublicKey?: string; revision?: number;
}>;
type BootstrapCredentialOperation = Readonly<{
    read(machine: ManagedMachineFullV1, expectedRevision?: number): Promise<BootstrapCredentialValue>;
    retain(credential: BootstrapCredentialValue): void;
}>;

async function prepareBootstrapCredential(params: ManagedMachineReconciliationInput, machine: ManagedMachineFullV1,
    kind: 'ssh' | 'native-token', operation: BootstrapCredentialOperation): Promise<Readonly<{ machine: ManagedMachineFullV1; publicKey?: string; guestHostPublicKey?: string; credentialRevision?: number }>> {
    assertBootstrapCredentialAccount(params, machine);
    const { fetchAccountEncryptionCurrentness } = await import('@/api/client/connectedServiceCredentialApi');
    if (!machine.bootstrapCredentialRef) {
        params.options.signal?.throwIfAborted();
        const currentness = await fetchAccountEncryptionCurrentness({ token: params.input.token, serverBaseUrl: params.input.serverUrl, signal: params.options.signal });
        const stored = params.input.credentials;
        if (currentness.mode === 'plain' ? stored.encryption !== null : stored.encryption === null) {
            throw new ManagedMachineControllerError('credential_unavailable');
        }
        const cryptoSnapshot = currentness.mode === 'e2ee' && stored.encryption
            ? createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: stored.encryption,
                ...(stored.encryption.type === 'dataKey' ? { dataKeyPublicKey: stored.encryption.publicKey } : {}),
            }) : null;
        let resourceDataKey: Buffer | null = null;
        let recipientMachineKey: Uint8Array | null = null;
        try {
            if (currentness.mode === 'e2ee' && (!cryptoSnapshot
                || convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(cryptoSnapshot.contentPublicKeyFingerprint)
                    !== currentness.contentKeyFingerprint)) {
                throw new ManagedMachineControllerError('credential_unavailable');
            }
            const bootstrapCredential = kind === 'native-token' ? createPrivateBearerCredential() : await new Promise<string>((resolve, reject) => {
                generateKeyPair('rsa', { modulusLength: 3072,
                    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
                }, (error, _publicKey, privateKey) => error ? reject(error) : resolve(privateKey));
            });
            const value = kind === 'ssh' ? createManagedBootstrapSshCredential({ bootstrapPrivateKey: bootstrapCredential, randomBytes }) : bootstrapCredential;
            const resourceId = randomUUID();
            const content = { v: 1 as const, name: 'Managed machine bootstrap', kind: 'other' as const, value };
            resourceDataKey = cryptoSnapshot ? randomBytes(32) : null;
            const storedContent = resourceDataKey
                ? sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', content, resourceDataKey, randomBytes })
                : sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', content });
            const material = cryptoSnapshot?.material;
            recipientMachineKey = material ? resolveAccountContentSecretKey(material) : null;
            const recipientPublicKey = recipientMachineKey ? tweetnacl.box.keyPair.fromSecretKey(recipientMachineKey).publicKey : null;
            if (resourceDataKey && !recipientPublicKey) throw new ManagedMachineControllerError('credential_unavailable');
            const credential = SharedSavedSecretCreateInputV1Schema.parse({
                resourceId, displayName: content.name, kind: content.kind, encryptionMode: currentness.mode, storedContent,
                accountGrants: [], teamGrants: [], groupGrants: [],
                keyEnvelopes: resourceDataKey && recipientPublicKey ? [{
                    recipientAccountId: machine.custodianAccountId,
                    encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceDataKey, recipientPublicKey, randomBytes })).toString('base64'),
                    recipientContentPublicKeyFingerprint: cryptoSnapshot!.contentPublicKeyFingerprint,
                }] : [],
            });
            // The server invokes the canonical SavedSecret mutation and records
            // its reference atomically. A retry may return the incumbent credential.
            machine = await params.client.row('create-bootstrap-credential', { ...params.client.correlation(machine), credential });
            // A replay can return the incumbent key. Only retain the material
            // whose resource this mutation actually selected.
            if (machine.bootstrapCredentialRef?.resourceId === resourceId) {
                const generated = readManagedBootstrapCredential(value);
                operation.retain({ value: generated.bootstrapPrivateKey,
                    ...(generated.guestHostPrivateKey === undefined ? {} : { guestHostPrivateKey: generated.guestHostPrivateKey }),
                    ...(generated.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: generated.guestHostPublicKey }) });
            }
        } finally {
            resourceDataKey?.fill(0);
            recipientMachineKey?.fill(0);
            if (cryptoSnapshot?.material.type === 'dataKey') cryptoSnapshot.material.machineKey.fill(0);
            else if (cryptoSnapshot?.material.type === 'legacy') cryptoSnapshot.material.secret.fill(0);
        }
    }
    const credential = await operation.read(machine);
    return { machine, ...(kind === 'ssh' ? { publicKey: sshPublicKey(credential.value),
        ...(credential.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: credential.guestHostPublicKey }) } : {}),
        credentialRevision: credential.revision };
}

async function readBootstrapCredentialValue(params: ManagedNativeInvocationInput, machine: ManagedMachineFullV1,
    expectedRevision?: number): Promise<Readonly<{ value: string; guestHostPrivateKey?: string; guestHostPublicKey?: string; revision: number }>> {
    assertBootstrapCredentialAccount(params, machine);
    if (!machine.bootstrapCredentialRef) throw new ManagedMachineControllerError('credential_unavailable');
    const [{ resolveAccountSettingsScopeKeyForToken }, { refreshSavedSecretCatalogForOperation, createInvocationSavedSecretOperationContextV1 },
        { acquireSavedSecretMaterializerForOperation }, { bootstrapAccountSettingsContext }, { runWithServerHttpBaseUrl },
        { fetchAccountProfile }, { fetchAccountEncryptionCurrentness }] = await Promise.all([
        import('@/settings/accountSettings/accountSettingsScopeKey'), import('@/settings/secrets/hydrateSavedSecretCatalog'), import('@/settings/secrets/savedSecretCatalogRead'),
        import('@/settings/accountSettings/bootstrapAccountSettingsContext'), import('@/api/client/serverHttpBaseUrl'),
        import('@/api/accountProfile'), import('@/api/client/connectedServiceCredentialApi'),
    ]);
    const credentials = params.input.credentials;
    const cryptoSnapshot = credentials.encryption ? createAccountScopedCryptoMaterialSnapshotV1({
        accountEncryptionMode: 'e2ee', material: credentials.encryption,
        ...(credentials.encryption.type === 'dataKey' ? { dataKeyPublicKey: credentials.encryption.publicKey } : {}),
    }) : null;
    const contentKeyFingerprint = cryptoSnapshot
        ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(cryptoSnapshot.contentPublicKeyFingerprint) : null;
    if (cryptoSnapshot?.material.type === 'dataKey') cryptoSnapshot.material.machineKey.fill(0);
    else if (cryptoSnapshot?.material.type === 'legacy') cryptoSnapshot.material.secret.fill(0);
    const readAccountCurrentness = async () => await runWithServerHttpBaseUrl(params.input.serverUrl, async () => {
        const [profile, currentness] = await Promise.all([
            fetchAccountProfile({ token: credentials.token, projection: 'self', signal: params.options.signal }),
            fetchAccountEncryptionCurrentness({ credentials: credentials, token: credentials.token, serverBaseUrl: params.input.serverUrl, signal: params.options.signal }),
        ]);
        return profile.id === machine.custodianAccountId
            && (currentness.mode === 'plain' ? credentials.encryption === null : credentials.encryption !== null)
            && (currentness.mode === 'plain' || currentness.contentKeyFingerprint === contentKeyFingerprint) ? currentness : null;
    });
    const admitted = await readAccountCurrentness();
    if (!admitted) throw new ManagedMachineControllerError('credential_unavailable');
    const isCurrent = async () => {
        const current = await readAccountCurrentness();
        // Account.seq also advances for the import below and unrelated writes.
        // Custody follows the canonical mode/key/timestamp identity instead.
        return current !== null && sameAccountEncryptionIdentity(current, admitted);
    };
    const accountSettings = await runWithServerHttpBaseUrl(params.input.serverUrl, () => bootstrapAccountSettingsContext({
        credentials, mode: 'blocking', refresh: 'force', publication: 'invocation', honorAccountSettingsModeEnv: false,
        minSettingsVersion: admitted.settingsVersion, shouldCommit: () => !params.options.signal?.aborted,
    }));
    // The canonical Settings importer owns source CAS/readback, including its
    // own version advance. Account custody is a separate mode/key/row lifetime.
    if (accountSettings.source !== 'network' || !await isCurrent()) throw new ManagedMachineControllerError('credential_unavailable');
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot: accountSettings,
        machineAdmission: readRequesterAccountActionContext(params.options.context?.externalActionExecutionAuthorization)
            ?.savedSecretOperationContext.machineAdmission,
        serverHttpBaseUrl: params.input.serverUrl, isCurrent });
    const reference = formatSharedSavedSecretRefV1(machine.bootstrapCredentialRef.resourceId);
    try {
        const snapshot = await refreshSavedSecretCatalogForOperation({
            expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
            references: [{ ref: reference, ...(expectedRevision === undefined ? {} : { revision: expectedRevision }) }],
            operationContext, signal: params.options.signal,
        });
        if (!await isCurrent()) throw new ManagedMachineControllerError('credential_unavailable');
        const materializer = await acquireSavedSecretMaterializerForOperation({ snapshot, operationContext,
            references: [{ ref: reference, ...(expectedRevision === undefined ? {} : { revision: expectedRevision }) }],
            signal: params.options.signal, secretSources: params.input.runtimeRegistry.secretSources });
        const secret = materializer.resolve(reference);
        const revision = snapshot.savedSecretResources?.find(resource => resource.resourceId === machine.bootstrapCredentialRef?.resourceId)?.revision;
        if (secret.status !== 'ready' || secret.source !== 'shared_resource' || revision === undefined) {
            throw new ManagedMachineControllerError('credential_unavailable');
        }
        const credential = readManagedBootstrapCredential(secret.value);
        return { value: credential.bootstrapPrivateKey, revision,
            ...(credential.guestHostPrivateKey === undefined ? {} : { guestHostPrivateKey: credential.guestHostPrivateKey }),
            ...(credential.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: credential.guestHostPublicKey }) };
    } finally { operationContext.withdrawCatalog(); }
}

async function materializeBootstrapCredential(params: ManagedNativeInvocationInput, machine: ManagedMachineFullV1, operation: BootstrapCredentialOperation, expectedRevision?: number) {
    params.options.signal?.throwIfAborted();
    const provider = machine.launch.provider;
    const occurrenceId = params.input.runtimeRegistry.readPluginOccurrenceId?.(provider.pluginId);
    if (!occurrenceId) throw new ManagedMachineControllerError('provider_unavailable');
    const credential = await operation.read(machine, expectedRevision);
    const [{ createManagedServiceCredentialFileOwner }, { resolvePluginStorePaths }] = await Promise.all([
        import('@/plugins/runtime/invocation/services/managedServiceCredentialFileOwner'), import('@/plugins/store/paths'),
    ]);
    const owner = createManagedServiceCredentialFileOwner({ rootDir: join(resolvePluginStorePaths().secretsDir, 'managed-services') });
    const cleanups: Array<{ dispose(): void | Promise<void> }> = [];
    const lease = await owner.materialize({
        scope: { occurrenceId, pluginId: provider.pluginId, contributionQualifiedId: buildQualifiedPluginContributionKey(provider),
            operationId: params.options.context?.operationAcceptance?.operationId ?? params.options.requestId },
        files: { bootstrap: new TextEncoder().encode(credential.value) },
        retainCleanup: (cleanup) => { cleanups.push(cleanup); },
    });
    const path = lease.pathsByFileId.bootstrap;
    if (!path) { await lease.dispose(); throw new ManagedMachineControllerError('credential_unavailable'); }
    return { path, guestHostPublicKey: credential.guestHostPublicKey,
        dispose: async () => { for (const cleanup of cleanups) await cleanup.dispose(); } };
}

/** Acquisition and retained-resource control share the same private native custody. */
export function createManagedNativeInvocation<NativePolicyAdmission extends true | undefined = undefined>(params: ManagedNativeInvocationInput & Readonly<{
    /** The signed current-set census already admitted this row-free replacement. */
    nativePolicyAdmission?: NativePolicyAdmission;
}>, readMachine: () => ManagedMachineFullV1,
    readBootstrapCredentialRevision?: () => number | undefined) {
    const machine = readMachine();
    // Native placement keeps the leased controller registry as its role authority;
    // reviewed facts neither select roles nor require Account catalog membership.
    const selectedContribution = params.input.runtimeRegistry.contributes.machineProvisioners?.find((candidate) =>
        candidate.identity.pluginId === machine.launch.provider.pluginId && candidate.identity.localId === machine.launch.provider.localId);
    if (!selectedContribution || selectedContribution.definition.schemaVersion !== machine.launch.schemaVersion) {
        throw new ManagedMachineControllerError('provider_unavailable');
    }
    const contribution = selectedContribution;
    const bootstrapCredentialKind = contribution.definition.bootstrapCredential?.kind
        ?? (contribution.definition.bootstrapTransport ? undefined : 'ssh');
    let retainedBootstrapCredential: Promise<BootstrapCredentialValue> | undefined;
    // One finite reconciliation owns the key, including native roles and SSH
    // enrollment. A later operation creates a new owner and reads storage once.
    const bootstrapCredential: BootstrapCredentialOperation = {
        read: (current, expectedRevision) => retainedBootstrapCredential ??= readBootstrapCredentialValue(params, current, expectedRevision),
        retain: credential => { retainedBootstrapCredential = Promise.resolve(credential); },
    };
    const selectedOccurrenceId = params.input.runtimeRegistry.readPluginOccurrenceId?.(contribution.pluginId);
    if (!selectedOccurrenceId) throw new ManagedMachineControllerError('provider_unavailable');
    const occurrenceId = selectedOccurrenceId;
    const target = params.input.homeTarget;
    if (target.homeServerIdentityId !== params.input.homeId) throw new ManagedMachineControllerError('admission_unavailable');
    const admittedRestore = params.action === 'deployments.backups.restore'
        && params.options.context?.operationAcceptance?.actionId === params.action;
    const targetAuthority = params.action === 'session.spawn_new' && 'sessionTarget' in params ? params.sessionTarget
        : params.action === 'workspace.sync.relationship.create' && 'workspaceSyncTarget' in params ? params.workspaceSyncTarget : undefined;
    // Both admitted lifetimes use the same controller-owned resource and channel authority.
    if (targetAuthority && managedTargetRow(machine, params.input) === undefined) throw new ManagedMachineControllerError('admission_unavailable');
    const assertManagedTargetCurrent = (requested: unknown) => {
        if (!targetAuthority) throw new ManagedMachineControllerError('admission_unavailable');
        if (targetAuthority.lifetime.aborted) throw new ManagedMachineControllerError('intent_changed');
        const ownResource = managedTargetRow(readMachine(), params.input);
        if (ownResource === undefined || requested === undefined || !pluginJsonValuesEqual(requested, ownResource)) {
            throw new ManagedMachineControllerError('admission_unavailable');
        }
    };
    if (params.action !== 'machines.managed.inspect' && (!target.descriptor
        || !params.nativePolicyAdmission && !admittedRestore && !targetAuthority && !params.options.context?.operationOwnerUpdate)) {
        throw new ManagedMachineControllerError('admission_unavailable');
    }
    // Held channels and finite effects share the admitted lifetime, with one provider operation per call.
    let targetInvocations = 0;
    async function roleCredentialAuthorization(localId: string, input = params.input) {
        const launch = readMachine().launch;
        return resolveManagedRoleCredentialAuthorizations(input, launch.provider, localId, launch.credentials,
            { descriptor: contribution.definition, launch: launch.choices });
    }
    async function invoke(role: MachineProvisionerRoleV1, body: unknown, io?: Readonly<{ signal?: AbortSignal; timeoutMs?: number | null; onStdoutChunk?: (text: string) => void; channel?: ManagedNativeChannelIO; beforeNativeEffect?: () => Promise<void>; managedNativeCredentials?: ManagedNativeCredentialInvocationBinding }>): Promise<JsonValue | null> {
        let dispatched = false;
        try {
            if (params.action === 'machines.managed.inspect' && role !== 'inspect' && role !== 'reconcile' && role !== 'cleanup'
                && !(params.includeGuestDiagnostics && role === 'exec')) {
                throw new ManagedMachineControllerError('native_intent_unsupported');
            }
            if (targetAuthority) {
                // Transport preparation and holder channels only; bootstrap returns a carrier, never enrolls.
                const startsProcess = role === 'exec' && typeof body === 'object' && body !== null && 'processConfig' in body;
                if (!MANAGED_TARGET_ROLES.has(role) || startsProcess) throw new ManagedMachineControllerError('native_intent_unsupported');
                // The body names the guest; it must be this row's own resource (every provider resolves the guest from it).
                const requested = typeof body === 'object' && body !== null && !Array.isArray(body) && 'resource' in body ? body.resource : undefined;
                assertManagedTargetCurrent(requested);
                // Channel roles never power a stopped target on: its power stays with the reconciler's desired state.
                // (`stream` has no wake input: its providers never wake, e.g. Coder `--disable-autostart`.)
                if (role === 'exec' || role === 'putFile') body = { ...(body as Record<string, unknown>), allowWake: false };
            }
            const machine = readMachine();
            const { executeContributedAction } = await import('@/plugins/runtime/invocation/actions/executeContributedAction');
            const localId = readMachineProvisionerActionRolesV1(contribution.definition).find(binding => binding.role === role)?.action;
            if (!localId) throw new ManagedMachineControllerError('provider_unavailable');
            const input = await resolveManagedRoleRuntime(params.input, contribution.pluginId, localId);
            const occurrenceId = input.runtimeRegistry.readPluginOccurrenceId?.(contribution.pluginId);
            if (!occurrenceId) throw new ManagedMachineControllerError('provider_unavailable');
            const actionId = buildQualifiedPluginContributionKey({ pluginId: contribution.pluginId, localId });
            const requestedSignal = io?.signal ?? params.options.signal;
            // The admitting Session or Account relationship owns cancellation, without repeated admission.
            const invocationSignal = targetAuthority
                ? requestedSignal ? AbortSignal.any([requestedSignal, targetAuthority.lifetime]) : targetAuthority.lifetime
                : requestedSignal;
            if (invocationSignal?.aborted) throw new ManagedMachineControllerError('intent_changed');
            const stdoutDecoder = new TextDecoder();
            // Home admitted this finite operation. Local cancellation owns its
            // remaining lifetime; credential acquisition still checks its own custody.
            let rowCurrent = true;
            const authorizations = await roleCredentialAuthorization(localId, input);
            const signal = invocationSignal ?? new AbortController().signal;
            const declaration = input.runtimeRegistry.contributes.actionsById?.get(actionId);
            const binding: ConnectedAccountInvocationPurposeBinding = {
                identity: { pluginId: contribution.pluginId, localId },
                operationId: targetAuthority ? `${params.options.requestId}:${++targetInvocations}`
                    : params.options.context?.externalActionExecutionAuthorization?.binding.requestId ?? params.options.requestId,
                purposes: authorizations.map(authorization => authorization.purpose),
                purposeBindings: projectManagedMachineRolePurposeBindingsV1(authorizations),
                ...(declaration?.pluginVersion ? { actionOperation: { pluginVersion: declaration.pluginVersion, signal,
                    resolveRequestHeaders: createExternalActionRequesterServerRequestHeaders(params.options.context) } } : {}),
                isCurrent: () => rowCurrent && !signal.aborted,
                managedOperation: { role,
                    credentialConfigurations: params.credentialConfigurations ?? readManagedMachineRoleCredentialConfigurationsV1(authorizations),
                    isCurrent: (currentRole) => currentRole === role && rowCurrent },
            };
            const activation = await input.managedProviderOperationAuthority.activate({ ...binding, requestAuthUses: [] });
            let nativeEffectGuardFailure: Readonly<{ error: unknown }> | undefined;
            try {
                const readRetainedBootstrapCredential = () => bootstrapCredential.read(machine, readBootstrapCredentialRevision?.());
                const custody: AdmittedManagedProviderOperationExecutionRequest = {
                    managedId: machine.id, homeId: machine.homeId, intentRevision: machine.intentRevision,
                    controller: params.input.controller,
                    contribution: { ...contribution.identity, occurrenceId },
                    role,
                    ...(role === 'bootstrap' ? { managedSshHostTrust: async (carrier: Parameters<NonNullable<AdmittedManagedProviderOperationExecutionRequest['managedSshHostTrust']>>[0]) => {
                        const { runManagedSessionSshTrust } = await import('./enrollmentSshTrust');
                        await runManagedSessionSshTrust({ carrier, correlation: {
                            homeId: machine.homeId, managedId: machine.id, controller: params.input.controller,
                            requestId: params.options.requestId, expectedIntentRevision: machine.intentRevision,
                        }, signal,
                        operationId: params.options.context?.operationAcceptance?.operationId,
                        requesterEnrollmentAccountId: readManagedMachineRequesterEnrollmentAccountIdV1(machine),
                        ...createManagedBootstrapProgress(params, machine) });
                    } } : {}),
                    ...(io?.managedNativeCredentials
                        ? { managedNativeCredentials: io.managedNativeCredentials } : {}),
                    ...(bootstrapCredentialKind
                        ? { readBootstrapCredential: async () => {
                            const retained = await readRetainedBootstrapCredential();
                            return new TextEncoder().encode(retained.value);
                        } } : {}),
                    ...(bootstrapCredentialKind === 'ssh' && role === 'acquire'
                        ? { readGuestHostCredential: async () => {
                            const retained = await readRetainedBootstrapCredential();
                            if (retained.guestHostPrivateKey === undefined) throw new ManagedMachineControllerError('credential_unavailable');
                            return new TextEncoder().encode(retained.guestHostPrivateKey);
                        } } : {}),
                    ...(role === 'exec' && io?.timeoutMs !== undefined ? { execTimeoutMs: io.timeoutMs } : {}),
                    ...(role === 'exec' && io?.onStdoutChunk ? { onProcessOutput: (output: Parameters<NonNullable<AdmittedManagedProviderOperationExecutionRequest['onProcessOutput']>>[0]) => {
                        if (output.stream === 'stdout') io.onStdoutChunk?.(stdoutDecoder.decode(output.data, { stream: true }));
                    } } : {}),
                    ...(role === 'stream' && io?.channel ? { onProcessOutput: io.channel.onOutput, bindProcessInput: io.channel.bindInput } : {}),
                    ...(activation.exactPurposeBindingSubjectId ? { exactPurposeBindingSubjectId: activation.exactPurposeBindingSubjectId } : {}),
                    ...(activation.executeBrokeredAction ? { executeBrokeredAction: activation.executeBrokeredAction } : {}),
                    isCurrent: () => rowCurrent && !invocationSignal?.aborted && activation.isCurrent(),
                };
                const beforeHandlerInvocation = async () => {
                    try {
                        if (!rowCurrent || !activation.isCurrent()) throw new ManagedMachineControllerError('intent_changed');
                        if ((role === 'power' || role === 'destroy') && io?.beforeNativeEffect) {
                            await io.beforeNativeEffect();
                        }
                        if (params.action !== 'deployments.backups.restore' && params.action !== MANAGED_RESIZE_ACTION_ID_V1 && (role === 'power' || role === 'destroy')
                            && params.options.context?.externalActionExecutionAuthorization?.binding.workflowActionOrigin) {
                            // A Session target carries no row client whose origin could be rechecked;
                            // it keeps the admission refusal this path has always settled to.
                            if (!('client' in params)) throw new ManagedMachineControllerError('admission_unavailable');
                            // Final guest confirmation awaits independently of
                            // the managed row. Recheck the FIN source, not that row.
                            if (!await params.client.isOriginCurrent()) throw new ManagedMachineControllerError('intent_changed');
                        }
                    } catch (error) {
                        rowCurrent = false;
                        // This host callback is before native IO. Keep that
                        // definite refusal through the dispatcher's error wrapper.
                        nativeEffectGuardFailure = { error };
                        throw error;
                    }
                };
                const context = params.options.context;
                // Native SDK transports do not spawn through ExecService. Carry the
                // same task-owned budget to their declared exec role as well.
                let nativeInput = role === 'exec' && io?.timeoutMs !== undefined
                    && typeof body === 'object' && body !== null && !Array.isArray(body)
                    ? { ...body, timeoutMs: io.timeoutMs } : body;
                if ((role === 'acquire' || role === 'rebuild') && contribution.definition.billing.location === 'local'
                    && typeof nativeInput === 'object' && nativeInput !== null && !Array.isArray(nativeInput)) {
                    const guestHome = await resolveManagedGuestHome(target, await input.readGuestHomeHostIdentity?.(input.homeId));
                    if (guestHome) nativeInput = { ...nativeInput, guestHome };
                }
                const executeRole = async (roleInput: unknown, approvalContext?: ActionExecutorContext) => {
                    const executionContext = approvalContext ?? context;
                    const externalActionContext: PluginExternalActionContext | undefined = executionContext?.externalActionCredential
                        && executionContext.externalActionExecutionAuthorization && executionContext.externalActionTarget && executionContext.serverId ? {
                            authority: 'account_automation', serverId: executionContext.serverId, serverIdentityId: params.input.homeId,
                            actionRequestId: executionContext.externalActionExecutionAuthorization.binding.requestId,
                            externalActionCredential: executionContext.externalActionCredential,
                            externalActionExecutionAuthorization: executionContext.externalActionExecutionAuthorization,
                            externalActionTarget: executionContext.externalActionTarget,
                            signExternalActionApprovalInput: executionContext.signExternalActionApprovalInput,
                        } : undefined;
                    if (executionContext?.externalActionCredential && !externalActionContext) {
                        throw new ManagedMachineControllerError('admission_unavailable');
                    }
                    dispatched = true;
                    return await executeContributedAction({
                        runtimeRegistry: input.runtimeRegistry, actionId,
                        input: roleInput, expectedContributorOccurrenceId: occurrenceId,
                        admittedManagedProviderOperation: custody,
                        ...(approvalContext ? { approvalContext }
                            : context?.recordOperationCredentialUse
                                ? { approvalContext: { recordOperationCredentialUse: context.recordOperationCredentialUse } } : {}),
                        context: { surface: 'plugin', invocationSurface: 'plugin', originSurface: 'cli', signal: invocationSignal,
                            initiatingActionCaller: executionContext?.actionCaller, externalActionContext, beforeHandlerInvocation,
                        },
                    });
                };
                const opaqueReview = readManagedOpaquePresetReview(params.options, machine);
                let execution: Awaited<ReturnType<typeof executeRole>>;
                if (opaqueReview) {
                    let childExecution: Awaited<ReturnType<typeof executeRole>> | undefined;
                    const port = createManagedOpaquePresetReviewedChildPortV1({ parent: opaqueReview.parent,
                        context: context ?? {}, custody: opaqueReview.custody, launch: machine.launch,
                        provisioner: contribution.definition, localId, role,
                        execute: async (childInput, childContext) => {
                            childExecution = await executeRole(childInput, childContext);
                            return childExecution.matched ? childExecution.result
                                : { ok: false, errorCode: 'provider_unavailable', error: 'provider_unavailable' };
                        },
                    });
                    if (!port) throw new ManagedMachineControllerError('provider_unavailable');
                    const child = await port.invoke({ action: { pluginId: contribution.pluginId, localId }, role,
                        input: projectNativeJsonValueForTransport(nativeInput) });
                    if (!childExecution) {
                        if (!child.ok) throw ManagedMachineNativeEffectGuardRefusal.fromActionFailure(child, params.action,
                            { pluginId: contribution.pluginId, localId });
                        throw new ManagedMachineNativeEffectGuardRefusal('admission_unavailable');
                    }
                    execution = childExecution;
                } else {
                    execution = await executeRole(nativeInput);
                }
                const attempt = execution;
                if (nativeEffectGuardFailure) throw nativeEffectGuardFailure.error;
                if (!attempt.matched) throw new ManagedMachineNativeEffectGuardRefusal('provider_unavailable');
                if (!attempt.result.ok) {
                    const ErrorClass = attempt.result.actionHandlerInvocation === 'notStarted'
                        ? ManagedMachineNativeEffectGuardRefusal : ManagedMachineControllerError;
                    throw ErrorClass.fromActionFailure(projectContributedActionFailure(attempt.result), params.action,
                        { pluginId: contribution.pluginId, localId });
                }
                const remaining = stdoutDecoder.decode();
                if (remaining) io?.onStdoutChunk?.(remaining);
                return attempt.result.result;
            } catch (error) {
                if (nativeEffectGuardFailure) {
                    const refusal = nativeEffectGuardFailure.error;
                    throw refusal instanceof ManagedMachineControllerError
                        ? new ManagedMachineNativeEffectGuardRefusal(refusal.code, refusal.status, refusal.details, refusal.failureCause, refusal.cause) : refusal;
                }
                throw error;
            } finally { rowCurrent = false; await activation.cleanup(); }
        } catch (error) {
            // Preparation cannot call plugin/native IO. After dispatch, only
            // the dispatcher's explicit notStarted/guard evidence is definite.
            if (!dispatched) throw error instanceof ManagedMachineControllerError
                ? new ManagedMachineNativeEffectGuardRefusal(error.code, error.status, error.details, error.failureCause, error.cause)
                : new ManagedMachineNativeEffectGuardRefusal('admission_unavailable', undefined, undefined, undefined, error);
            throw error;
        }
    }
    const admittedInvoke: (
        role: NativePolicyAdmission extends true ? 'nativeCredentialApply' | 'renew' : Parameters<typeof invoke>[0],
        body: unknown,
        io?: Parameters<typeof invoke>[2],
    ) => ReturnType<typeof invoke> = invoke;
    return { contribution, occurrenceId, target, bootstrapCredentialKind, bootstrapCredential, roleCredentialAuthorization, invoke: admittedInvoke,
        assertManagedTargetCurrent,
        readBootstrapInput: async () => {
            const row = readMachine();
            if (!row.resource) throw new ManagedMachineControllerError('admission_unavailable');
            const retained = bootstrapCredentialKind === 'ssh' && row.bootstrapCredentialRef
                ? await bootstrapCredential.read(row, readBootstrapCredentialRevision?.()) : null;
            return buildManagedBootstrapInput({ resource: row.resource.value, credentialKind: bootstrapCredentialKind,
                credentialRef: row.bootstrapCredentialRef, credential: retained ? { publicKey: sshPublicKey(retained.value),
                    guestHostPublicKey: retained.guestHostPublicKey } : null });
        },
        materializeBootstrapCredential: async (reference: NonNullable<ManagedMachineFullV1['bootstrapCredentialRef']>) => {
            const row = readMachine();
            if (!pluginJsonValuesEqual(reference, row.bootstrapCredentialRef)) throw new ManagedMachineControllerError('credential_unavailable');
            return await materializeBootstrapCredential(params, row, bootstrapCredential, readBootstrapCredentialRevision?.());
        },
    };
}

/** Read the same submitted acquisition by its retained handle or immutable launch correlation. */
export async function reconcileManagedAcquisitionIdentity(params: ManagedMachineReconciliationInput,
    machine: ManagedMachineFullV1, native: ReturnType<typeof createManagedNativeInvocation>): Promise<ManagedMachineFullV1> {
    return await reconcileManagedAcquisitionIdentityShared({ action: params.action, requestId: params.options.requestId,
        home: params.client, provisioner: native.contribution.definition }, machine, native.invoke);
}

export async function reconcileManagedMachine(params: ManagedMachineReconciliationInput): Promise<JsonValue | null> {
    params.client.assertConnection(params.machine);
    const retainedProvisioner = params.input.runtimeRegistry.contributes.machineProvisioners?.find(candidate =>
        candidate.identity.pluginId === params.machine.launch.provider.pluginId && candidate.identity.localId === params.machine.launch.provider.localId
        && candidate.definition.schemaVersion === params.machine.launch.schemaVersion);
    let credentialConfigurations = params.credentialConfigurations;
    if (params.action !== 'machines.managed.inspect' && params.machine.allocation === 'unsubmitted'
        && params.hydrator?.isOpaque(params.machine) && retainedProvisioner
        && params.hydrator.readPresetDefinition(params.machine)?.preparation?.enabled) {
        const descriptor = retainedProvisioner.definition;
        const roleHost = await resolveManagedRoleRuntime(params.input, params.machine.launch.provider.pluginId, descriptor.actions.acquire);
        const authorizations = await resolveManagedRoleCredentialAuthorizations(roleHost, params.machine.launch.provider,
            descriptor.actions.acquire, params.machine.launch.credentials, { descriptor, launch: params.machine.launch.choices });
        credentialConfigurations = await captureManagedMachineRoleCredentialConfigurationsV1({ authorizations,
            readCredentialConfigurationRevision: (account, signal) => {
                if (!roleHost.readCredentialConfigurationRevision) throw new ManagedMachineControllerError('credential_unavailable');
                return roleHost.readCredentialConfigurationRevision(account, signal);
            }, signal: params.options.signal ?? new AbortController().signal });
    }
    let native: ReturnType<typeof createManagedNativeInvocation>;
    const machine = await reconcileManagedMachineShared({ machine: params.machine, action: params.action,
        requestId: params.options.requestId, signal: params.options.signal, home: params.client,
        acquisitionMode: params.machine.acquisitionMode ?? params.options.acquisitionMode,
        observationOnly: params.action === 'machines.managed.inspect' && params.options.policyPurpose !== undefined,
        provisioner: retainedProvisioner?.definition,
        prepareAcquire: async (machine, configuration, captureConfiguration) => {
            const hydrator = params.hydrator;
            if (!hydrator?.isOpaque(machine) || !retainedProvisioner) return { machine };
            let content = hydrator.readPresetDefinition(machine);
            if (!content?.launch || !machine.preset) throw new ManagedMachineControllerError('credential_unavailable');
            if (!configuration && content.preparation?.enabled) configuration = await captureConfiguration();
            if (!configuration) return { machine };
            let launch = machine.launch;
            let preparationExecution: import('@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1').ManagedMachinePresetPreparationExecutionV1 | undefined;
            if (content.preparation?.enabled) {
                const projection = configuration.optionProjection;
                const guest = projection?.kind === 'ready' ? projection.nativeFacts?.preparationGuest : undefined;
                if (guest) {
                    const cli = await resolveManagedGuestCliBuildIdentity({ homeUrl: params.input.serverUrl, target: guest.target,
                        readLocalPayloadMetadata: readManagedGuestCliLocalBuildPayloadMetadata, signal: params.options.signal,
                        ...(params.input.guestCliFetch ? { fetchImpl: params.input.guestCliFetch } : {}) });
                    // Unsubmitted preparation captures this same basis before constructing native invocations.
                    let decision = readManagedMachinePresetPreparationV1({ content,
                        cliIdentity: cli.identity, credentialConfigurations: credentialConfigurations! });
                    if (decision.kind === 'warm' && decision.updateCli
                        && content.preparation.whenHappierUpdates === 'rebuild-automatically') {
                        await rebuildManagedPresetAtFirstUse({ input: params.input, options: params.options,
                            machine, hydrator, content, cliIdentity: cli.identity,
                            credentialConfigurations: credentialConfigurations! });
                        content = hydrator.readPresetDefinition(machine)!;
                        decision = readManagedMachinePresetPreparationV1({ content,
                            cliIdentity: cli.identity, credentialConfigurations: credentialConfigurations! });
                    }
                    if (decision.kind === 'warm') {
                        const preparedLaunch = readMachineProvisionerPreparedLaunchV1({ provisioner: retainedProvisioner.identity,
                            descriptor: retainedProvisioner.definition, artifact: decision.artifact });
                        if (preparedLaunch.success) {
                            const prepared = content.prepared!;
                            const observation = MachineProvisionerPreparationInspectResultV1Schema.parse(await native.invoke('preparationInspect',
                                prepared.nativeOperationRef ? { nativeOperation: prepared.nativeOperationRef }
                                    : { operationId: prepared.operationId, launch: prepared.binding.configuration.launch.choices }));
                            if (observation.kind === 'failed' || observation.kind === 'unknown') {
                                throw new ManagedMachineControllerError(observation.code, undefined,
                                    observation.nativeCause ? { kind: 'managedNative', nativeCause: observation.nativeCause } : undefined);
                            }
                            if (observation.kind === 'pending') throw new ManagedMachineControllerError('native_observation_unavailable');
                            if (observation.kind === 'ready') {
                                const currentLaunch = readMachineProvisionerPreparedLaunchV1({ provisioner: retainedProvisioner.identity,
                                    descriptor: retainedProvisioner.definition, artifact: observation.artifact });
                                if (!currentLaunch.success) throw new ManagedMachineControllerError('provider_unavailable');
                                // Retained launch wire values use the canonical mutable JSON vocabulary.
                                launch = { ...launch, choices: PluginJsonValueV2Schema.parse(currentLaunch.data) };
                                preparationExecution = { launch, binaryPath: decision.binaryPath,
                                    ...(decision.updateCli ? { updateCli: decision.updateCli } : {}),
                                    ...(decision.deferredSetup === undefined ? {} : { deferredSetup: decision.deferredSetup }) };
                            }
                        }
                    }
                }
            }
            const facts = preparationExecution === undefined ? configuration.facts : buildManagedConfigurationFactsV1({
                choicesSchema: createPluginJsonSchemaZodValueAdapter(retainedProvisioner.definition.launchSchema), launch,
                controller: machine.controller, provisioner: retainedProvisioner.definition, optionStatus: 'unavailable',
                prerequisites: configuration.facts.prerequisites, billing: configuration.facts.billing,
                retentionCapabilities: configuration.facts.retentionCapabilities, prices: configuration.facts.prices,
                nativeFacts: configuration.facts.nativeFacts, localResources: configuration.facts.localResources,
                preset: machine.preset, machineOverride: { retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage },
            });
            const contentReport = await hydrator.preparePresetContentReport(machine, { reviewedFacts: facts,
                ...(preparationExecution === undefined ? {} : { preparationExecution }) }, params.options.signal);
            return { machine: hydrator.normalize(hydrator.structural(machine)), presetContent: contentReport };
        },
        createNative: (readMachine, readRevision) => {
            native = createManagedNativeInvocation({ ...params,
                ...(credentialConfigurations === undefined ? {} : { credentialConfigurations }) }, readMachine, readRevision);
            const { contribution, bootstrapCredentialKind, roleCredentialAuthorization, invoke } = native;
            const optionsAction = contribution.definition.actions.options;
            const optionsInputSchema = optionsAction ? params.input.runtimeRegistry.contributes.actionsById?.get(
                buildQualifiedPluginContributionKey({ pluginId: contribution.pluginId, localId: optionsAction }))?.admittedTarget?.declaration.inputSchema : undefined;
            return { bootstrapCredentialKind, invoke, optionsInputSchema,
                ...(params.hydrator?.isOpaque(readMachine()) ? { readReviewedEffectDigest: () => {
                    const content = params.hydrator?.readPresetDefinition(readMachine());
                    return content === undefined ? undefined : readManagedOpaquePresetAcquireEffectDigestV1(content);
                } } : {}), prepareRoles: async () => {
                for (const localId of [contribution.definition.actions.acquire, contribution.definition.actions.bootstrap,
                    ...(contribution.definition.bootstrapTransport ? [contribution.definition.bootstrapTransport.exec, contribution.definition.bootstrapTransport.putFile] : [])]) {
                    await roleCredentialAuthorization(localId);
                }
            } };
        },
        bootstrap: {
            preflight: async () => {
                const homeWarning = readManagedGuestHomeWarning(params.input.homeTarget);
                if (homeWarning) throw new ManagedMachineControllerError(homeWarning.code);
                await import('./enrollment');
            },
            prepareCredential: (row, kind) => prepareBootstrapCredential(params, row, kind, native.bootstrapCredential),
            readCredential: async (row, revision) => {
                const credential = await native.bootstrapCredential.read(row, revision);
                return { revision: credential.revision,
                    ...(native.bootstrapCredentialKind === 'ssh' ? { publicKey: sshPublicKey(credential.value),
                        ...(credential.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: credential.guestHostPublicKey }) } : {}) };
            },
            prepareTransport: async transport => {
                const { runManagedSessionSshTrust } = await import('./enrollmentSshTrust');
                await runManagedSessionSshTrust({ ...transport, signal: params.options.signal,
                    operationId: params.options.context?.operationAcceptance?.operationId,
                    requesterEnrollmentAccountId: readManagedMachineRequesterEnrollmentAccountIdV1(transport.machine),
                    ...createManagedBootstrapProgress(params, transport.machine),
                });
            },
            enroll: enrollment => runManagedEnrollment(params, enrollment, native),
            complete: async row => {
                // Only creation or the first enrollment initializes administrator
                // and isolation policies. Enrolled guest recovery preserves stored policy.
                if (params.action === 'machines.managed.acquire' || !params.machine.enrolledMachineId) {
                    await initializeManagedMachineEnrollmentPolicies(params.input, row, params.options);
                }
            },
        },
        waitForObservation: createManagedNativeObservationWait(params.options.signal),
        onResource: row => params.options.context?.operationOwnerUpdate?.update({ domainRef: {
            kind: 'managedMachine', id: row.id, controller: row.controller, resource: row.resource,
        } }),
        onProgress: progress => params.options.context?.operationOwnerUpdate?.update({ progress }),
    });
    return params.action === 'machines.managed.inspect' ? projectNativeJsonValueForTransport({ machine }) : null;
}

function createManagedBootstrapProgress(params: Pick<ManagedMachineReconciliationInput, 'options'>, machine: ManagedMachineFullV1,
    onEnrollmentWait?: () => void): Pick<Parameters<typeof import('./enrollmentTask').createManagedBootstrapTaskRunner>[0], 'onTask' | 'onPrompt' | 'onEvent'> {
    const domainRef = { kind: 'managedMachine' as const, id: machine.id, controller: machine.controller, resource: machine.resource };
    let bootstrapTask: Readonly<{ id: string; taskKind: 'remote.ssh.bootstrapMachine.v1' }> | undefined;
    let bootstrapPrompt: ManagedMachineBootstrapPromptV1 | null = null;
    const publishBootstrapTask = () => {
        if (!bootstrapTask) return;
        params.options.context?.operationOwnerUpdate?.update({ domainRef: { ...domainRef,
            bootstrapTask: { ...bootstrapTask, ...(bootstrapPrompt ? { prompt: bootstrapPrompt } : {}) } } });
    };
    return {
            onTask: ({ taskId, kind }) => {
                bootstrapTask = { id: taskId, taskKind: kind };
                publishBootstrapTask();
            },
            // The task's open question rides on the same operation, so the page waiting on it can ask it.
            onPrompt: (prompt) => {
                // A prepared task can ask synchronously before startAdmitted
                // returns its id. Retain that question for the first publication.
                bootstrapPrompt = prompt;
                publishBootstrapTask();
            },
            onEvent: (event) => {
                if (event.type !== 'progress' || !event.message) return;
                if (event.stepId === 'ssh.auth.wait') onEnrollmentWait?.();
                const progress = (event.stepId
                    ? { kind: 'phase', phase: event.stepId, label: event.message }
                    : { kind: 'indeterminate', label: event.message }) satisfies ActionOperationProgressV1;
                params.options.context?.operationOwnerUpdate?.update({ progress });
            },
    };
}

async function runManagedEnrollment(params: ManagedMachineReconciliationInput, enrollmentInput: ManagedReconciliationEnrollment,
    invocation: ReturnType<typeof createManagedNativeInvocation>): Promise<ManagedMachineFullV1> {
    let machine = enrollmentInput.machine;
    const { carrier, correlation, homeCorrelation, invoke } = enrollmentInput;
    const { target, contribution, occurrenceId } = invocation;
    const { runManagedMachineEnrollment } = await import('./enrollment');
    const native = carrier.kind === 'native' ? createManagedNativeBootstrapIO(correlation, invoke) : undefined;
    let enrollmentLifetime: HomeOperationRetry | undefined;
    let enrollmentAttempted = false;
    try {
        const enrollment = await runManagedMachineEnrollment({ correlation, homeCorrelation, target, carrier, signal: params.options.signal,
            replacePayload: params.action === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1,
            ...(params.action === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1 ? { guestCli: params.guestCli } : {}),
            onInstalled: enrollmentInput.onInstalled,
            reviewedChild: params.options.context?.hostReviewedChild,
            accountCredentials: readRequesterAccountActionContext(params.options.context?.externalActionExecutionAuthorization)?.credentials,
            ...(enrollmentInput.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: enrollmentInput.guestHostPublicKey }),
            operationId: params.options.context?.operationAcceptance?.operationId,
            ...createManagedBootstrapProgress(params, machine, () => { enrollmentAttempted = true; }),
        }, {
            onEnrollmentLifetime: lifetime => {
                enrollmentLifetime = lifetime;
                params.client.setHomeOperationRetry(lifetime);
            },
            readCurrentManagedRow: async () => {
                params.options.signal?.throwIfAborted();
                if (params.input.runtimeRegistry.readPluginOccurrenceId?.(contribution.pluginId) !== occurrenceId) {
                    throw new ManagedMachineControllerError('provider_unavailable');
                }
                return await params.client.row('current', params.client.correlation(machine));
            }, native,
            materializeBootstrapCredential: reference => invocation.materializeBootstrapCredential(reference),
        });
        machine = await params.client.row('current', params.client.correlation(machine));
        if (machine.enrolledMachineId !== enrollment.machineId) throw new ManagedMachineControllerError('enrollment_retired');
        return machine;
    } catch (error) {
        // A guest may have committed enrollment while Home cannot be read.
        // Unavailable confirmation never proves that the guest effect failed.
        if (enrollmentLifetime && enrollmentAttempted && !params.options.signal?.aborted && isRetryableHomeOperationError(error)) {
            throw new ManagedMachineControllerError('action_outcome_unknown');
        }
        throw error;
    } finally { params.client.setHomeOperationRetry(); }
}
