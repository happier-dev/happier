import { generateKeyPair, randomBytes, randomUUID } from 'node:crypto';
import { readManagedGuestHomeWarning, resolveManagedGuestHome } from './homeQualification';
import { join } from 'node:path';
import { reconcileManagedMachine as reconcileManagedMachineShared, reconcileManagedAcquisitionIdentity as reconcileManagedAcquisitionIdentityShared,
    createManagedNativeBootstrapIO, createManagedBootstrapSshCredential, readManagedBootstrapCredential, bindManagedMachineRoleCredentials,
    type ManagedReconciliationEnrollment } from '@happier-dev/cli-common/machines/managed';
import tweetnacl from 'tweetnacl';
import { sameAccountEncryptionIdentity } from '@happier-dev/sync-client';
import { SharedSavedSecretCreateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createAccountScopedCryptoMaterialSnapshotV1, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { MachineAdminAccessMutationResultV1Schema, MachineAdminAccessFieldV1, type ActionExecuteResult, type JsonValue } from '@happier-dev/protocol';
import type { ActionOperationProgressV1, ManagedMachineBootstrapPromptV1 } from '@happier-dev/protocol/actions/operations/v1';
import { resolveManagedMachineEnrollmentAdminAccessV1, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { DevcontainerRebuildIntentV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { ManagedMachineActionIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MANAGED_RESIZE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { AdmittedManagedProviderOperationExecutionRequest } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { projectContributedActionFailure } from '@/plugins/runtime/invocation/actions/contributedActionFailure';
import type { ManagedNativeCredentialInvocationBinding, PluginExternalActionContext } from '@/plugins/runtime/invocation/services/types';
import { createPrivateBearerCredential } from '@/daemon/privateBearerFile';
import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createManagedNativeObservationWait } from './nativeObservationWait';
import { ManagedMachineControllerError, ManagedMachineNativeEffectGuardRefusal, readManagedNativeFailureDetails } from './controllerErrors';
import type { ManagedMachineAcquisitionDriverInput, ManagedMachineControllerClient, ManagedMachineExecutionOptions } from './acquire';
import { sshPublicKey } from './bootstrapSshPublicKey';
import { isRetryableHomeOperationError, type HomeOperationRetry } from '@/api/client/retryHomeOperation';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { dispatchManagedMachineAdminAccess, dispatchLocalManagedMachineAdminAccess } from '@/api/externalActionExecutionAuthorization';
import { initializeManagedMachineEnrollmentIsolation } from './enrollmentIsolation';

export type ManagedMachineReconciliationInput = Readonly<{
    input: ManagedMachineAcquisitionDriverInput;
    options: ManagedMachineExecutionOptions;
    client: ManagedMachineControllerClient;
    machine: ManagedMachineV1;
    action: ManagedMachineActionIdV1;
    includeGuestDiagnostics?: true;
    rebuild?: DevcontainerRebuildIntentV1;
    admittedProvisioner?: MachineProvisionerContributionV1;
}>;

type ManagedNativeInvocationInput = ManagedMachineReconciliationInput | (Omit<ManagedMachineReconciliationInput, 'action' | 'client'> & Readonly<{
    action: 'deployments.backups.restore';
}>);

export async function resolveManagedRoleCredentialAuthorizations(input: ManagedMachineAcquisitionDriverInput, provider: ManagedMachineV1['launch']['provider'], localId: string,
    credentials: ManagedMachineV1['launch']['credentials'], qualification?: Readonly<{ descriptor: MachineProvisionerContributionV1; launch: unknown }>) {
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

function assertBootstrapCredentialAccount(params: ManagedNativeInvocationInput, machine: ManagedMachineV1): void {
    // The server owns custody authorization. This only binds the local
    // Account's material to that already verified controller custodian.
    if (params.input.credentials.token !== params.input.token
        || readAccountIdFromToken(params.input.credentials.token) !== machine.custodianAccountId) {
        throw new ManagedMachineControllerError('credential_unavailable');
    }
}

async function prepareBootstrapCredential(params: ManagedMachineReconciliationInput, machine: ManagedMachineV1,
    kind: 'ssh' | 'native-token'): Promise<Readonly<{ machine: ManagedMachineV1; publicKey?: string; guestHostPublicKey?: string; credentialRevision: number }>> {
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
            recipientMachineKey = material?.type === 'legacy' ? deriveAccountMachineKeyFromRecoverySecret(material.secret) : null;
            const recipientPublicKey = material ? tweetnacl.box.keyPair.fromSecretKey(
                material.type === 'dataKey' ? material.machineKey : recipientMachineKey!,
            ).publicKey : null;
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
        } finally {
            resourceDataKey?.fill(0);
            recipientMachineKey?.fill(0);
            if (cryptoSnapshot?.material.type === 'dataKey') cryptoSnapshot.material.machineKey.fill(0);
            else if (cryptoSnapshot?.material.type === 'legacy') cryptoSnapshot.material.secret.fill(0);
        }
    }
    const credential = await readBootstrapCredentialValue(params, machine);
    return { machine, ...(kind === 'ssh' ? { publicKey: sshPublicKey(credential.value),
        ...(credential.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: credential.guestHostPublicKey }) } : {}),
        credentialRevision: credential.revision };
}

async function readBootstrapCredentialValue(params: ManagedNativeInvocationInput, machine: ManagedMachineV1,
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

async function materializeBootstrapCredential(params: ManagedNativeInvocationInput, machine: ManagedMachineV1, expectedRevision: number) {
    params.options.signal?.throwIfAborted();
    const provider = machine.launch.provider;
    const occurrenceId = params.input.runtimeRegistry.readPluginOccurrenceId?.(provider.pluginId);
    if (!occurrenceId) throw new ManagedMachineControllerError('provider_unavailable');
    const credential = await readBootstrapCredentialValue(params, machine, expectedRevision);
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
    return { path, dispose: async () => { for (const cleanup of cleanups) await cleanup.dispose(); } };
}

/** Acquisition and retained-resource control share the same private native custody. */
export function createManagedNativeInvocation<NativePolicyAdmission extends true | undefined = undefined>(params: ManagedNativeInvocationInput & Readonly<{
    /** The signed current-set census already admitted this row-free replacement. */
    nativePolicyAdmission?: NativePolicyAdmission;
}>, readMachine: () => ManagedMachineV1,
    readBootstrapCredentialRevision?: () => number | undefined) {
    const machine = readMachine();
    // Native placement keeps the leased controller registry as its role authority;
    // reviewed facts neither select roles nor require Account catalog membership.
    const selectedContribution = params.input.runtimeRegistry.contributes.machineProvisioners?.find((candidate) =>
        candidate.identity.pluginId === machine.launch.provider.pluginId && candidate.identity.localId === machine.launch.provider.localId);
    if (!selectedContribution || !params.admittedProvisioner && selectedContribution.definition.schemaVersion !== machine.launch.schemaVersion) throw new ManagedMachineControllerError('provider_unavailable');
    const contribution = params.admittedProvisioner ? { ...selectedContribution, definition: params.admittedProvisioner } : selectedContribution;
    const bootstrapCredentialKind = contribution.definition.bootstrapCredential?.kind
        ?? (contribution.definition.bootstrapTransport ? undefined : 'ssh');
    let nativeBootstrapCredentialRevision: number | undefined;
    const selectedOccurrenceId = params.input.runtimeRegistry.readPluginOccurrenceId?.(contribution.pluginId);
    if (!selectedOccurrenceId) throw new ManagedMachineControllerError('provider_unavailable');
    const occurrenceId = selectedOccurrenceId;
    const target = params.input.homeTarget;
    if (target.homeServerIdentityId !== params.input.homeId) throw new ManagedMachineControllerError('admission_unavailable');
    const admittedRestore = params.action === 'deployments.backups.restore'
        && params.options.context?.operationAcceptance?.actionId === params.action;
    if (params.action !== 'machines.managed.inspect' && (!target.descriptor
        || !params.nativePolicyAdmission && !admittedRestore && !params.options.context?.operationOwnerUpdate)) {
        throw new ManagedMachineControllerError('admission_unavailable');
    }
    async function roleCredentialAuthorization(localId: string, input = params.input) {
        const launch = readMachine().launch;
        return resolveManagedRoleCredentialAuthorizations(input, launch.provider, localId, launch.credentials,
            { descriptor: contribution.definition, launch: launch.choices });
    }
    async function invoke(role: keyof typeof contribution.definition.actions | 'exec' | 'putFile' | 'reconcile' | 'cleanup' | 'nativeCredentialApply', body: unknown, io?: Readonly<{ signal?: AbortSignal; timeoutMs?: number | null; onStdoutChunk?: (text: string) => void; beforeNativeEffect?: () => Promise<void>; managedNativeCredentials?: ManagedNativeCredentialInvocationBinding }>): Promise<JsonValue | null> {
        let dispatched = false;
        try {
            if (params.action === 'machines.managed.inspect' && role !== 'inspect' && role !== 'reconcile' && role !== 'cleanup'
                && !(params.includeGuestDiagnostics && role === 'exec')) {
                throw new ManagedMachineControllerError('native_intent_unsupported');
            }
            const machine = readMachine();
            const { executeContributedAction } = await import('@/plugins/runtime/invocation/actions/executeContributedAction');
            const localId = role === 'nativeCredentialApply' ? contribution.definition.nativeCredentialDelivery?.apply
                : role === 'reconcile' ? contribution.definition.reconciliation?.action
                : role === 'cleanup' ? contribution.definition.reconciliation?.cleanup
                : role === 'exec' || role === 'putFile' ? contribution.definition.bootstrapTransport?.[role] : contribution.definition.actions[role];
            if (!localId) throw new ManagedMachineControllerError('provider_unavailable');
            const input = await resolveManagedRoleRuntime(params.input, contribution.pluginId, localId);
            const occurrenceId = input.runtimeRegistry.readPluginOccurrenceId?.(contribution.pluginId);
            if (!occurrenceId) throw new ManagedMachineControllerError('provider_unavailable');
            const actionId = buildQualifiedPluginContributionKey({ pluginId: contribution.pluginId, localId });
            const invocationSignal = io?.signal ?? params.options.signal;
            if (invocationSignal?.aborted) throw new ManagedMachineControllerError('intent_changed');
            const stdoutDecoder = new TextDecoder();
            // Home admitted this finite operation. Local cancellation owns its
            // remaining lifetime; credential acquisition still checks its own custody.
            let rowCurrent = true;
            const authorizations = await roleCredentialAuthorization(localId, input);
            const activation = await input.managedProviderOperationAuthority.activate({
                identity: { pluginId: contribution.pluginId, localId },
                operationId: params.options.context?.operationAcceptance?.operationId ?? params.options.requestId,
                purposes: authorizations.map(authorization => authorization.purpose),
                purposeBindings: { v: 1, bindings: authorizations.map(authorization => ({ purpose: authorization.purpose,
                    target: { kind: 'account' as const, account: authorization.credential.account } })) },
                requestAuthUses: [],
                isCurrent: () => rowCurrent && !invocationSignal?.aborted,
                managedOperation: { role,
                    credentialConfigurations: authorizations.flatMap(({ credential }) => credential.configurationRevision === undefined
                        ? [] : [{ account: credential.account, revision: credential.configurationRevision }]),
                    isCurrent: (currentRole) => currentRole === role && rowCurrent },
            });
            let nativeEffectGuardFailure: Readonly<{ error: unknown }> | undefined;
            try {
                let retainedBootstrapCredential: ReturnType<typeof readBootstrapCredentialValue> | undefined;
                const readRetainedBootstrapCredential = () => {
                    retainedBootstrapCredential ??= (async () => {
                        const retained = await readBootstrapCredentialValue(params, machine,
                            readBootstrapCredentialRevision?.() ?? nativeBootstrapCredentialRevision);
                        nativeBootstrapCredentialRevision = retained.revision;
                        return retained;
                    })();
                    return retainedBootstrapCredential;
                };
                const custody: AdmittedManagedProviderOperationExecutionRequest = {
                    managedId: machine.id, homeId: machine.homeId, intentRevision: machine.intentRevision,
                    controller: params.input.controller,
                    contribution: { ...contribution.identity, occurrenceId },
                    role,
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
                    ...(activation.exactPurposeBindingSubjectId ? { exactPurposeBindingSubjectId: activation.exactPurposeBindingSubjectId } : {}),
                    isCurrent: () => rowCurrent && !invocationSignal?.aborted && activation.isCurrent(),
                };
                const beforeHandlerInvocation = async () => {
                    try {
                        if (!rowCurrent || !activation.isCurrent()) throw new ManagedMachineControllerError('intent_changed');
                        if ((role === 'power' || role === 'destroy') && io?.beforeNativeEffect) {
                            await io.beforeNativeEffect();
                        }
                        if (params.action !== 'deployments.backups.restore' && params.action !== MANAGED_RESIZE_ACTION_ID_V1 && (role === 'power' || role === 'destroy')
                            && params.options.context?.externalActionExecutionAuthorization?.binding.workflowActionOrigin
                            && !await params.client.isOriginCurrent()) {
                            // Final guest confirmation awaits independently of
                            // the managed row. Recheck the FIN source, not that row.
                            throw new ManagedMachineControllerError('intent_changed');
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
                const externalActionContext: PluginExternalActionContext | undefined = context?.externalActionCredential
                    && context.externalActionExecutionAuthorization && context.externalActionTarget && context.serverId ? {
                        authority: 'account_automation', serverId: context.serverId, serverIdentityId: params.input.homeId,
                        actionRequestId: context.externalActionExecutionAuthorization.binding.requestId,
                        externalActionCredential: context.externalActionCredential,
                        externalActionExecutionAuthorization: context.externalActionExecutionAuthorization,
                        externalActionTarget: context.externalActionTarget,
                        signExternalActionApprovalInput: context.signExternalActionApprovalInput,
                    } : undefined;
                if (context?.externalActionCredential && !externalActionContext) throw new ManagedMachineControllerError('admission_unavailable');
                // Native SDK transports do not spawn through ExecService. Carry the
                // same task-owned budget to their declared exec role as well.
                let nativeInput = role === 'exec' && io?.timeoutMs !== undefined
                    && typeof body === 'object' && body !== null && !Array.isArray(body)
                    ? { ...body, timeoutMs: io.timeoutMs } : body;
                if ((role === 'acquire' || role === 'rebuild') && contribution.definition.billing.location === 'local'
                    && typeof nativeInput === 'object' && nativeInput !== null && !Array.isArray(nativeInput)) {
                    const guestHome = await resolveManagedGuestHome(target);
                    if (guestHome) nativeInput = { ...nativeInput, guestHome };
                }
                dispatched = true;
                const attempt = await executeContributedAction({
                    runtimeRegistry: input.runtimeRegistry, actionId,
                    input: nativeInput, expectedContributorOccurrenceId: occurrenceId,
                    admittedManagedProviderOperation: custody,
                    ...(context?.recordOperationCredentialUse
                        ? { approvalContext: { recordOperationCredentialUse: context.recordOperationCredentialUse } } : {}),
                    context: { surface: 'plugin', invocationSurface: 'plugin', originSurface: 'cli', signal: invocationSignal,
                        initiatingActionCaller: context?.actionCaller, externalActionContext, beforeHandlerInvocation,
                    },
                });
                if (nativeEffectGuardFailure) throw nativeEffectGuardFailure.error;
                if (!attempt.matched) throw new ManagedMachineNativeEffectGuardRefusal('provider_unavailable');
                if (!attempt.result.ok) {
                    const failureDetails = readManagedNativeFailureDetails(projectContributedActionFailure(attempt.result), { pluginId: contribution.pluginId, localId });
                    throw attempt.result.actionHandlerInvocation === 'notStarted'
                        ? new ManagedMachineNativeEffectGuardRefusal(attempt.result.errorCode, undefined, failureDetails)
                        : new ManagedMachineControllerError(attempt.result.errorCode, undefined, failureDetails);
                }
                const remaining = stdoutDecoder.decode();
                if (remaining) io?.onStdoutChunk?.(remaining);
                return attempt.result.result;
            } catch (error) {
                if (nativeEffectGuardFailure) {
                    const refusal = nativeEffectGuardFailure.error;
                    throw refusal instanceof ManagedMachineControllerError
                        ? new ManagedMachineNativeEffectGuardRefusal(refusal.code, refusal.status, refusal.details) : refusal;
                }
                throw error;
            } finally { rowCurrent = false; await activation.cleanup(); }
        } catch (error) {
            // Preparation cannot call plugin/native IO. After dispatch, only
            // the dispatcher's explicit notStarted/guard evidence is definite.
            if (!dispatched) throw error instanceof ManagedMachineControllerError
                ? new ManagedMachineNativeEffectGuardRefusal(error.code, error.status, error.details)
                : new ManagedMachineNativeEffectGuardRefusal('admission_unavailable');
            throw error;
        }
    }
    const admittedInvoke: (
        role: NativePolicyAdmission extends true ? 'nativeCredentialApply' | 'renew' : Parameters<typeof invoke>[0],
        body: unknown,
        io?: Parameters<typeof invoke>[2],
    ) => ReturnType<typeof invoke> = invoke;
    return { contribution, occurrenceId, target, bootstrapCredentialKind, roleCredentialAuthorization, invoke: admittedInvoke };
}

/** Read the same submitted acquisition by its retained handle or immutable launch correlation. */
export async function reconcileManagedAcquisitionIdentity(params: ManagedMachineReconciliationInput,
    machine: ManagedMachineV1, native: ReturnType<typeof createManagedNativeInvocation>): Promise<ManagedMachineV1> {
    return await reconcileManagedAcquisitionIdentityShared({ action: params.action, requestId: params.options.requestId,
        home: params.client, provisioner: native.contribution.definition }, machine, native.invoke);
}

async function recordEnrollmentAdministratorAccess(input: ManagedMachineAcquisitionDriverInput, machine: ManagedMachineV1, options: ManagedMachineExecutionOptions): Promise<void> {
    const policy = resolveManagedMachineEnrollmentAdminAccessV1(machine.enrollmentIdentity);
    if (!policy) return;
    options.context?.operationProgress?.update({ phase: 'machines.setup.adminAccess.set', label: 'Configuring administrator access' });
    const context = options.context;
    if (!context || !machine.enrolledMachineId) throw new ManagedMachineControllerError('enrollment_retired');
    // The initial field is None; field comparison may rebase unrelated
    // metadata versions but never replaces an independently changed policy.
    // The continuation retains the original creation even when the public
    // retry carrying this first enrollment has a new request identity.
    const request = { serverId: machine.homeId, machineId: machine.enrolledMachineId, expectedMetadataVersion: 0,
        expectedAdminAccess: { version: 1 as const, mode: 'none' as const }, adminAccess: policy, comparison: 'field' as const };
    const authorization = context.externalActionExecutionAuthorization;
    let execution: ActionExecuteResult;
    if (authorization) {
        if (!input.externalActionMachineRequestPrivateKey || authorization.binding.machineId !== input.controller.machineId
            || authorization.binding.installationId !== input.controller.installationId
            || authorization.binding.serverIdentityId !== machine.homeId) throw new ManagedMachineControllerError('admission_unavailable');
        const requester = readRequesterAccountActionContext(authorization);
        const encryption = authorization.binding.accountEncryptionMode === 'e2ee'
            ? await requester?.resolveEncryption(options.signal, authorization) : undefined;
        if (authorization.binding.accountEncryptionMode === 'e2ee' && encryption?.serverIdentityId !== machine.homeId)
            throw new ManagedMachineControllerError('admission_unavailable');
        execution = await dispatchManagedMachineAdminAccess({ input: request, serverId: context.serverId ?? machine.homeId, homeTarget: input.homeTarget,
            observeRecordedApprovalExecution: input.observeRecordedApprovalExecution,
            context, continuation: { managedId: machine.id, creationRequestId: options.requestId,
                expectedIntentRevision: machine.intentRevision }, authorization, authority: context.authority,
            installationId: input.controller.installationId, privateKey: input.externalActionMachineRequestPrivateKey,
            serverHttpBaseUrl: input.serverUrl, ...(encryption ? { material: encryption.material } : {}), signal: options.signal });
    } else {
        execution = await dispatchLocalManagedMachineAdminAccess({ input: request, homeId: machine.homeId, context,
            observeRecordedApprovalExecution: input.observeRecordedApprovalExecution,
            managedContinuation: { managedId: machine.id, creationRequestId: options.requestId,
                expectedIntentRevision: machine.intentRevision },
            credentials: input.credentials, custodianAccountId: machine.custodianAccountId, serverHttpBaseUrl: input.serverUrl,
            isCurrent: async () => !options.signal?.aborted });
    }
    if (!execution.ok) throw ManagedMachineControllerError.fromActionFailure(execution, 'machines.setup.adminAccess.set');
    const result = MachineAdminAccessMutationResultV1Schema.safeParse(execution.result);
    if (!result.success || result.data.status === 'outcomeUnknown') {
        throw new ManagedMachineControllerError('action_outcome_unknown');
    }
    if (!['applied', 'satisfied', 'unchanged'].includes(result.data.status)
        || !('policy' in result.data) || !MachineAdminAccessFieldV1.equal(result.data.policy, policy)) {
        throw new ManagedMachineControllerError('administrator_policy_unconfirmed');
    }
}

export async function reconcileManagedMachine(params: ManagedMachineReconciliationInput): Promise<JsonValue | null> {
    params.client.assertConnection(params.machine);
    const retainedProvisioner = params.input.runtimeRegistry.contributes.machineProvisioners?.find(candidate =>
        candidate.identity.pluginId === params.machine.launch.provider.pluginId && candidate.identity.localId === params.machine.launch.provider.localId
        && candidate.definition.schemaVersion === params.machine.launch.schemaVersion);
    let native: ReturnType<typeof createManagedNativeInvocation>;
    const machine = await reconcileManagedMachineShared({ machine: params.machine, action: params.action,
        requestId: params.options.requestId, signal: params.options.signal, home: params.client,
        provisioner: retainedProvisioner?.definition,
        createNative: (readMachine, readRevision) => {
            native = createManagedNativeInvocation(params, readMachine, readRevision);
            const { contribution, bootstrapCredentialKind, roleCredentialAuthorization, invoke } = native;
            const optionsAction = contribution.definition.actions.options;
            const optionsInputSchema = optionsAction ? params.input.runtimeRegistry.contributes.actionsById?.get(
                buildQualifiedPluginContributionKey({ pluginId: contribution.pluginId, localId: optionsAction }))?.admittedTarget?.declaration.inputSchema : undefined;
            return { bootstrapCredentialKind, invoke, optionsInputSchema, prepareRoles: async () => {
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
            prepareCredential: (row, kind) => prepareBootstrapCredential(params, row, kind),
            readCredential: async (row, revision) => {
                const credential = await readBootstrapCredentialValue(params, row, revision);
                return { revision: credential.revision,
                    ...(native.bootstrapCredentialKind === 'ssh' ? { publicKey: sshPublicKey(credential.value),
                        ...(credential.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: credential.guestHostPublicKey }) } : {}) };
            },
            enroll: enrollment => runManagedEnrollment(params, enrollment, native),
            complete: async row => {
                // Only creation or the first enrollment initializes administrator
                // and isolation policies. Enrolled guest recovery preserves stored policy.
                if (params.action === 'machines.managed.acquire' || !params.machine.enrolledMachineId) {
                    await recordEnrollmentAdministratorAccess(params.input, row, params.options);
                    await initializeManagedMachineEnrollmentIsolation(row, params.input, params.options);
                }
            },
        },
        waitForObservation: createManagedNativeObservationWait(params.options.signal),
        onResource: row => params.options.context?.operationOwnerUpdate?.update({ domainRef: {
            kind: 'managedMachine', id: row.id, controller: row.controller, resource: row.resource,
        } }),
        onProgress: progress => params.options.context?.operationOwnerUpdate?.update({ progress }),
    });
    return params.action === 'machines.managed.inspect' ? { machine } : null;
}

async function runManagedEnrollment(params: ManagedMachineReconciliationInput, enrollmentInput: ManagedReconciliationEnrollment,
    invocation: ReturnType<typeof createManagedNativeInvocation>): Promise<ManagedMachineV1> {
    let machine = enrollmentInput.machine;
    const { carrier, correlation, invoke } = enrollmentInput;
    const bootstrapCredentialRevision = enrollmentInput.credentialRevision;
    const { target, contribution, occurrenceId } = invocation;
    const domainRef = { kind: 'managedMachine' as const, id: machine.id, controller: machine.controller, resource: machine.resource };
    const { runManagedMachineEnrollment } = await import('./enrollment');
    const native = carrier.kind === 'native' ? createManagedNativeBootstrapIO(correlation, invoke) : undefined;
    let bootstrapTask: Readonly<{ id: string; taskKind: 'remote.ssh.bootstrapMachine.v1' }> | undefined;
    let bootstrapPrompt: ManagedMachineBootstrapPromptV1 | null = null;
    const publishBootstrapTask = () => {
        if (!bootstrapTask) return;
        params.options.context?.operationOwnerUpdate?.update({ domainRef: { ...domainRef,
            bootstrapTask: { ...bootstrapTask, ...(bootstrapPrompt ? { prompt: bootstrapPrompt } : {}) } } });
    };
    let enrollmentLifetime: HomeOperationRetry | undefined;
    let enrollmentAttempted = false;
    try {
        const enrollment = await runManagedMachineEnrollment({ correlation, target, carrier, signal: params.options.signal,
            onInstalled: enrollmentInput.onInstalled,
            reviewedChild: params.options.context?.hostReviewedChild,
            accountCredentials: readRequesterAccountActionContext(params.options.context?.externalActionExecutionAuthorization)?.credentials,
            ...(enrollmentInput.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: enrollmentInput.guestHostPublicKey }),
            operationId: params.options.context?.operationAcceptance?.operationId,
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
                if (event.stepId === 'ssh.auth.wait') enrollmentAttempted = true;
                const progress = (event.stepId
                    ? { kind: 'phase', phase: event.stepId, label: event.message }
                    : { kind: 'indeterminate', label: event.message }) satisfies ActionOperationProgressV1;
                params.options.context?.operationOwnerUpdate?.update({ progress });
            },
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
            materializeBootstrapCredential: async (reference) => {
                if (reference.resourceId !== machine.bootstrapCredentialRef?.resourceId || bootstrapCredentialRevision === undefined) {
                    throw new ManagedMachineControllerError('credential_unavailable');
                }
                return await materializeBootstrapCredential(params, machine, bootstrapCredentialRevision);
            },
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
