import { generateKeyPair, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { SharedSavedSecretCreateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createAccountScopedCryptoMaterialSnapshotV1, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { JsonValue } from '@happier-dev/protocol';
import type { ActionOperationProgressV1 } from '@happier-dev/protocol/actions/operations/v1';
import { AcquireResultV1Schema, ProviderObservationV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { DevcontainerRebuildIntentV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { ManagedMachineActionIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { AdmittedManagedProviderOperationExecutionRequest } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import type { PluginExternalActionContext } from '@/plugins/runtime/invocation/services/types';
import { createPrivateBearerCredential } from '@/daemon/privateBearerFile';
import { MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ManagedEnrollmentCorrelationV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedBootstrapCarrierV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { ManagedNativeBootstrapIO } from './enrollment';
import { ManagedMachineControllerError, ManagedMachineNativeEffectGuardRefusal, type ManagedMachineAcquisitionDriverInput, type ManagedMachineControllerClient, type ManagedMachineExecutionOptions } from './acquire';
import { sshPublicKey } from './bootstrapSshPublicKey';

export type ManagedMachineReconciliationInput = Readonly<{
    input: ManagedMachineAcquisitionDriverInput;
    options: ManagedMachineExecutionOptions;
    client: ManagedMachineControllerClient;
    machine: ManagedMachineV1;
    action: ManagedMachineActionIdV1;
    rebuild?: DevcontainerRebuildIntentV1;
}>;

export async function resolveManagedRoleCredentialAuthorizations(input: ManagedMachineAcquisitionDriverInput, providerPluginId: string, localId: string, credentials: ManagedMachineV1['launch']['credentials']) {
    const { resolveRegistryConnectedAccountActionPurposeAuthorizations } = await import('@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations');
    const declarations = resolveRegistryConnectedAccountActionPurposeAuthorizations({
        registry: input.runtimeRegistry.contributes,
        qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: providerPluginId, localId }),
        resolveOptionalAccess: input.runtimeRegistry.resolveOptionalAccess,
    });
    if (!declarations) throw new ManagedMachineControllerError('provider_unavailable');
    return declarations.map(authorization => {
        const matches = credentials?.filter(credential => credential.purpose.consumer.pluginId === providerPluginId
            && credential.purpose.purpose === authorization.purpose.purpose) ?? [];
        const credential = matches[0];
        if (matches.length !== 1 || !credential || !authorization.serviceRefs.some(service =>
            service.pluginId === credential.account.service.pluginId && service.localId === credential.account.service.localId)) {
            throw new ManagedMachineControllerError('credential_unavailable');
        }
        return { ...authorization, credential };
    });
}

function assertBootstrapCredentialAccount(params: ManagedMachineReconciliationInput, machine: ManagedMachineV1): void {
    // The server owns custody authorization. This only binds the local
    // Account's material to that already verified controller custodian.
    if (params.input.credentials.token !== params.input.token
        || readAccountIdFromToken(params.input.credentials.token) !== machine.custodianAccountId) {
        throw new ManagedMachineControllerError('credential_unavailable');
    }
}

async function prepareBootstrapCredential(params: ManagedMachineReconciliationInput, machine: ManagedMachineV1,
    kind: 'ssh' | 'native-token'): Promise<Readonly<{ machine: ManagedMachineV1; publicKey?: string; credentialRevision: number }>> {
    assertBootstrapCredentialAccount(params, machine);
    const { fetchAccountEncryptionCurrentness } = await import('@/api/client/connectedServiceCredentialApi');
    if (!machine.bootstrapCredentialRef) {
        if (!await params.client.isCurrent(machine)) throw new ManagedMachineControllerError('intent_changed');
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
            const value = kind === 'native-token' ? createPrivateBearerCredential() : await new Promise<string>((resolve, reject) => {
                generateKeyPair('rsa', { modulusLength: 3072,
                    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
                }, (error, _publicKey, privateKey) => error ? reject(error) : resolve(privateKey));
            });
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
    return { machine, ...(kind === 'ssh' ? { publicKey: sshPublicKey(credential.value) } : {}), credentialRevision: credential.revision };
}

async function readBootstrapCredentialValue(params: ManagedMachineReconciliationInput, machine: ManagedMachineV1,
    expectedRevision?: number): Promise<Readonly<{ value: string; revision: number }>> {
    assertBootstrapCredentialAccount(params, machine);
    if (!machine.bootstrapCredentialRef) throw new ManagedMachineControllerError('credential_unavailable');
    const [{ resolveAccountSettingsScopeKeyForToken }, { refreshSavedSecretCatalogForOperation, createInvocationSavedSecretOperationContextV1 },
        { createSavedSecretMaterializerFromSnapshotV1 }, { bootstrapAccountSettingsContext }, { runWithServerHttpBaseUrl },
        { fetchAccountProfile }, { fetchAccountEncryptionCurrentness }] = await Promise.all([
        import('@/settings/accountSettings/accountSettingsScopeKey'), import('@/settings/secrets/hydrateSavedSecretCatalog'), import('@/settings/secrets/savedSecretCatalog'),
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
        if (!await params.client.isCurrent(machine)) return null;
        const [profile, currentness] = await Promise.all([
            fetchAccountProfile({ token: credentials.token, signal: params.options.signal }),
            fetchAccountEncryptionCurrentness({ token: credentials.token, serverBaseUrl: params.input.serverUrl, signal: params.options.signal }),
        ]);
        return profile.id === machine.custodianAccountId
            && (currentness.mode === 'plain' ? credentials.encryption === null : credentials.encryption !== null)
            && (currentness.mode === 'plain' || currentness.contentKeyFingerprint === contentKeyFingerprint)
            && await params.client.isCurrent(machine) ? currentness : null;
    });
    const admitted = await readAccountCurrentness();
    if (!admitted) throw new ManagedMachineControllerError('credential_unavailable');
    const isCurrent = async () => {
        const current = await readAccountCurrentness();
        return current !== null && current.mode === admitted.mode && current.version === admitted.version
            && current.contentKeyFingerprint === admitted.contentKeyFingerprint;
    };
    const accountSettings = await runWithServerHttpBaseUrl(params.input.serverUrl, () => bootstrapAccountSettingsContext({
        credentials, mode: 'blocking', refresh: 'force', publication: 'invocation', honorAccountSettingsModeEnv: false,
        minSettingsVersion: admitted.settingsVersion, shouldCommit: () => !params.options.signal?.aborted,
    }));
    // The canonical Settings importer owns source CAS/readback, including its
    // own version advance. Account custody is a separate mode/key/row lifetime.
    if (accountSettings.source !== 'network' || !await isCurrent()) throw new ManagedMachineControllerError('credential_unavailable');
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot: accountSettings,
        serverHttpBaseUrl: params.input.serverUrl, isCurrent });
    const reference = formatSharedSavedSecretRefV1(machine.bootstrapCredentialRef.resourceId);
    try {
        const snapshot = await refreshSavedSecretCatalogForOperation({
            expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
            references: [{ ref: reference, ...(expectedRevision === undefined ? {} : { revision: expectedRevision }) }],
            operationContext, signal: params.options.signal,
        });
        if (!await isCurrent()) throw new ManagedMachineControllerError('credential_unavailable');
        const secret = createSavedSecretMaterializerFromSnapshotV1(snapshot, { isCurrent: () => operationContext.readSnapshot() === snapshot }).resolve(reference);
        const revision = snapshot.savedSecretResources?.find(resource => resource.resourceId === machine.bootstrapCredentialRef?.resourceId)?.revision;
        if (secret.status !== 'ready' || secret.source !== 'shared_resource' || revision === undefined) {
            throw new ManagedMachineControllerError('credential_unavailable');
        }
        return { value: secret.value, revision };
    } finally { operationContext.withdrawCatalog(); }
}

async function materializeBootstrapCredential(params: ManagedMachineReconciliationInput, machine: ManagedMachineV1, expectedRevision: number) {
    if (!await params.client.isCurrent(machine)) throw new ManagedMachineControllerError('intent_changed');
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
export function createManagedNativeInvocation(params: ManagedMachineReconciliationInput, readMachine: () => ManagedMachineV1,
    readBootstrapCredentialRevision?: () => number | undefined) {
    const machine = readMachine();
    const selectedContribution = params.input.runtimeRegistry.contributes.machineProvisioners?.find((candidate) =>
        candidate.identity.pluginId === machine.launch.provider.pluginId && candidate.identity.localId === machine.launch.provider.localId);
    if (!selectedContribution || selectedContribution.definition.schemaVersion !== machine.launch.schemaVersion) throw new ManagedMachineControllerError('provider_unavailable');
    const contribution = selectedContribution;
    const bootstrapCredentialKind = contribution.definition.bootstrapCredential?.kind
        ?? (contribution.definition.bootstrapTransport ? undefined : 'ssh');
    let nativeBootstrapCredentialRevision: number | undefined;
    const selectedOccurrenceId = params.input.runtimeRegistry.readPluginOccurrenceId?.(contribution.pluginId);
    if (!selectedOccurrenceId) throw new ManagedMachineControllerError('provider_unavailable');
    const occurrenceId = selectedOccurrenceId;
    const target = params.input.homeTarget;
    if (target.homeServerIdentityId !== params.input.homeId) throw new ManagedMachineControllerError('admission_unavailable');
    if (params.action !== 'machines.managed.inspect' && (!target.descriptor || !params.options.context?.operationOwnerUpdate)) {
        throw new ManagedMachineControllerError('admission_unavailable');
    }
    async function roleCredentialAuthorization(localId: string) {
        return resolveManagedRoleCredentialAuthorizations(params.input, contribution.pluginId, localId, readMachine().launch.credentials);
    }
    async function invoke(role: keyof typeof contribution.definition.actions | 'exec' | 'putFile' | 'reconcile', body: unknown, io?: Readonly<{ signal?: AbortSignal; timeoutMs?: number | null; onStdoutChunk?: (text: string) => void; beforeNativeEffect?: () => Promise<void> }>): Promise<JsonValue | null> {
        const machine = readMachine();
        const { executeContributedAction } = await import('@/plugins/runtime/invocation/actions/executeContributedAction');
        const localId = role === 'reconcile' ? contribution.definition.reconciliation?.action
            : role === 'exec' || role === 'putFile' ? contribution.definition.bootstrapTransport?.[role] : contribution.definition.actions[role];
        if (!localId) throw new ManagedMachineControllerError('provider_unavailable');
        const actionId = buildQualifiedPluginContributionKey({ pluginId: contribution.pluginId, localId });
        const invocationSignal = io?.signal ?? params.options.signal;
        const stdoutDecoder = new TextDecoder();
        let rowCurrent = await params.client.isCurrent(machine, role === 'inspect' ? 'inspect' : undefined);
        if (!rowCurrent) throw new ManagedMachineControllerError('intent_changed');
        const credentials = machine.launch.credentials ?? [];
        const configurationCurrent = async () => {
            if (!credentials.length) return true;
            const read = params.input.managedProviderOperationAuthority.readCredentialConfigurationRevision;
            if (!read || credentials.some(credential => credential.configurationRevision === undefined)) return false;
            try { return (await Promise.all(credentials.map(async credential =>
                await read(credential.account, invocationSignal ?? new AbortController().signal) === credential.configurationRevision))).every(Boolean); }
            catch { return false; }
        };
        if (!await configurationCurrent()) throw new ManagedMachineControllerError('credential_unavailable');
        const authorizations = await roleCredentialAuthorization(localId);
        const activation = await params.input.managedProviderOperationAuthority.activate({
            identity: { pluginId: contribution.pluginId, localId },
            operationId: params.options.context?.operationAcceptance?.operationId ?? params.options.requestId,
            purposes: authorizations.map(authorization => authorization.purpose),
            purposeBindings: { v: 1, bindings: authorizations.map(authorization => ({ purpose: authorization.purpose,
                target: { kind: 'account' as const, account: authorization.credential.account } })) },
            requestAuthUses: [],
            isCurrent: () => rowCurrent && !invocationSignal?.aborted,
            managedOperation: { role, isCurrent: (currentRole) => currentRole === role && rowCurrent,
                credentialConfigurations: credentials.map(credential => ({ account: credential.account,
                    revision: credential.configurationRevision! })),
            },
        });
        let nativeEffectGuardFailure: Readonly<{ error: unknown }> | undefined;
        try {
            const custody: AdmittedManagedProviderOperationExecutionRequest = {
                managedId: machine.id, homeId: machine.homeId, intentRevision: machine.intentRevision,
                controller: machine.controller,
                contribution: { ...contribution.identity, occurrenceId },
                role,
                ...(bootstrapCredentialKind && ['acquire', 'bootstrap', 'exec', 'putFile'].includes(role)
                    ? { readBootstrapCredential: async () => {
                        if (!await params.client.isCurrent(machine)) throw new ManagedMachineControllerError('intent_changed');
                        const retained = await readBootstrapCredentialValue(params, machine,
                            readBootstrapCredentialRevision?.() ?? nativeBootstrapCredentialRevision);
                        nativeBootstrapCredentialRevision = retained.revision;
                        if (!await params.client.isCurrent(machine)) throw new ManagedMachineControllerError('intent_changed');
                        return new TextEncoder().encode(retained.value);
                    } } : {}),
                ...(role === 'exec' && io?.timeoutMs !== undefined ? { execTimeoutMs: io.timeoutMs } : {}),
                ...(role === 'exec' && io?.onStdoutChunk ? { onProcessOutput: (output: Parameters<NonNullable<AdmittedManagedProviderOperationExecutionRequest['onProcessOutput']>>[0]) => {
                    if (output.stream === 'stdout') io.onStdoutChunk?.(stdoutDecoder.decode(output.data, { stream: true }));
                } } : {}),
                ...(activation.exactPurposeBindingSubjectId ? { exactPurposeBindingSubjectId: activation.exactPurposeBindingSubjectId } : {}),
                isCurrent: async () => {
                    rowCurrent = await params.client.isCurrent(machine, role === 'inspect' ? 'inspect' : undefined);
                    if (!rowCurrent || !activation.isCurrent()) {
                        // Only this host-owned pre-handler check proves that
                        // an admitted FIN native effect has not been issued.
                        // Other custody failures and issued IO remain uncertain.
                        if ((role === 'power' || role === 'destroy') && params.options.context?.externalActionExecutionAuthorization?.binding.workflowActionOrigin) {
                            nativeEffectGuardFailure = { error: new ManagedMachineNativeEffectGuardRefusal('intent_changed') };
                        }
                        return false;
                    }
                    if (!await configurationCurrent()) {
                        nativeEffectGuardFailure = { error: new ManagedMachineControllerError('credential_unavailable') };
                        rowCurrent = false;
                        return false;
                    }
                    if ((role === 'power' || role === 'destroy') && io?.beforeNativeEffect) {
                        try { await io.beforeNativeEffect(); }
                        catch (error) { nativeEffectGuardFailure = { error }; rowCurrent = false; return false; }
                    }
                    if ((role === 'power' || role === 'destroy') && params.options.context?.externalActionExecutionAuthorization?.binding.workflowActionOrigin) {
                        // Credential preparation and final idle confirmation
                        // both await. Re-read the same Home-issued source only
                        // after those awaits, immediately before handler IO.
                        rowCurrent = await params.client.isCurrent(machine);
                        if (!rowCurrent) {
                            nativeEffectGuardFailure = { error: new ManagedMachineNativeEffectGuardRefusal('intent_changed') };
                            return false;
                        }
                    }
                    return true;
                },
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
            const nativeInput = role === 'exec' && io?.timeoutMs !== undefined
                && typeof body === 'object' && body !== null && !Array.isArray(body)
                ? { ...body, timeoutMs: io.timeoutMs } : body;
            const attempt = await executeContributedAction({
                runtimeRegistry: params.input.runtimeRegistry, actionId,
                input: nativeInput, expectedContributorOccurrenceId: occurrenceId,
                admittedManagedProviderOperation: custody,
                context: { surface: 'plugin', invocationSurface: 'plugin', originSurface: 'cli', signal: invocationSignal,
                    initiatingActionCaller: context?.actionCaller, externalActionContext,
                },
            });
            if (nativeEffectGuardFailure) throw nativeEffectGuardFailure.error;
            if (!attempt.matched) throw new ManagedMachineControllerError('provider_unavailable');
            if (!attempt.result.ok) throw new ManagedMachineControllerError(attempt.result.errorCode);
            const remaining = stdoutDecoder.decode();
            if (remaining) io?.onStdoutChunk?.(remaining);
            return attempt.result.result;
        } catch (error) {
            if (nativeEffectGuardFailure) throw nativeEffectGuardFailure.error;
            throw error;
        } finally { rowCurrent = false; await activation.cleanup(); }
    }
    return { contribution, occurrenceId, target, bootstrapCredentialKind, roleCredentialAuthorization, invoke };
}

export async function reconcileManagedMachine(params: ManagedMachineReconciliationInput): Promise<JsonValue | null> {
    let machine = params.machine;
    let bootstrapCredentialRevision: number | undefined;
    params.client.assertConnection(machine);
    const retainedProvisioner = params.input.runtimeRegistry.contributes.machineProvisioners?.find(candidate =>
        candidate.identity.pluginId === machine.launch.provider.pluginId && candidate.identity.localId === machine.launch.provider.localId
        && candidate.definition.schemaVersion === machine.launch.schemaVersion);
    if (params.action === 'machines.managed.inspect' && (machine.allocation === 'confirmed-absent'
        || !machine.resource && !machine.nativeOperationRef && (machine.allocation !== 'may-exist' || !retainedProvisioner?.definition.reconciliation))) return { machine };
    if (params.action !== 'machines.managed.inspect' && (machine.creationState !== 'active' || machine.allocation === 'confirmed-absent'
        || (machine.enrolledMachineId && params.action !== 'machines.managed.bootstrap.retry'))) return null;
    if (machine.enrolledMachineId && params.action === 'machines.managed.bootstrap.retry') {
        // Ordinary enrolled resources retain their existing no-op retry. Only
        // a native transport can declare process custody in its carrier below.
        if (!retainedProvisioner?.definition.bootstrapTransport) return null;
    }
    // Unknown/pending purchase is never submitted again. The durable row keeps
    // the native handle/recovery data even after its initiating Action is gone.
    if (!machine.resource && machine.allocation !== 'unsubmitted' && !machine.nativeOperationRef && !retainedProvisioner?.definition.reconciliation) return null;
    const { contribution, occurrenceId, target, bootstrapCredentialKind, roleCredentialAuthorization, invoke }
        = createManagedNativeInvocation(params, () => machine, () => bootstrapCredentialRevision);
    if (!machine.resource && machine.allocation === 'may-exist') {
        const retained = machine.nativeOperationRef;
        if (retained && (retained.contributionRef.pluginId !== machine.launch.provider.pluginId
            || retained.contributionRef.localId !== machine.launch.provider.localId
            || retained.schemaVersion !== machine.launch.schemaVersion)) throw new ManagedMachineControllerError('resource_mismatch');
        if (!contribution.definition.reconciliation) throw new ManagedMachineControllerError('provider_unavailable');
        const reportBound = params.action === 'machines.managed.inspect' ? null
            : await params.client.preparePendingAcquireBoundReport(machine);
        const result = AcquireResultV1Schema.parse(await invoke('reconcile', retained ? { nativeOperation: retained.value }
            : { correlation: { managedId: machine.id, requestId: params.options.requestId, launch: machine.launch.choices } }));
        // A refused read is not evidence that the submitted purchase is absent.
        if (result.kind === 'rejected') throw new ManagedMachineControllerError(result.code);
        // Preserve a known paid identity even if cancellation won during the
        // read. Only the subsequent creation effects require fresh custody.
        machine = result.kind === 'bound' && reportBound ? await reportBound(result)
            : await params.client.row('report', { ...params.client.correlation(machine), result }, null);
        if (result.kind !== 'bound') return params.action === 'machines.managed.inspect' ? { machine } : null;
    }
    if (params.action === 'machines.managed.inspect') {
        if (!machine.resource) return { machine };
        const observation = ProviderObservationV1Schema.parse(await invoke('inspect', { resource: machine.resource.value }));
        const result = { kind: 'bound' as const, resource: machine.resource };
        machine = await params.client.row('report', { ...params.client.correlation(machine), result, observation });
        return { machine };
    }
    if (machine.allocation === 'unsubmitted') {
        // Load the actual incumbent recipe before issuing a paid request.
        await import('./enrollment');
        // Validate every credential-consuming bootstrap phase before a paid
        // native submission. An omitted captured account never means default.
        for (const localId of [contribution.definition.actions.acquire, contribution.definition.actions.bootstrap,
            ...(contribution.definition.bootstrapTransport ? [contribution.definition.bootstrapTransport.exec, contribution.definition.bootstrapTransport.putFile] : [])]) {
            await roleCredentialAuthorization(localId);
        }
        let bootstrapPublicKey: string | undefined;
        if (bootstrapCredentialKind) {
            const prepared = await prepareBootstrapCredential(params, machine, bootstrapCredentialKind);
            machine = prepared.machine;
            bootstrapPublicKey = prepared.publicKey;
            bootstrapCredentialRevision = prepared.credentialRevision;
        }
        const submitted = await params.client.submit(machine);
        machine = submitted.machine;
        if (!submitted.submitted) return null;
        let result;
        try {
            result = AcquireResultV1Schema.parse(await invoke('acquire', { managedId: machine.id,
                launch: machine.launch.choices, ...(bootstrapPublicKey ? { bootstrapPublicKey } : {}),
            }));
        } catch (error) {
            // An exception may follow a submitted native request. Retain the
            // exact selection as recovery, never claim absence or buy again.
            await params.client.row('report', { ...params.client.correlation(machine), result: {
                kind: 'unknown', recovery: { reference: machine.id, reason: 'native_acquisition_unconfirmed' },
            } }, null);
            throw error;
        }
        machine = result.kind === 'bound' || result.kind === 'pending'
            ? await params.client.reportIssuedAcquireFact(machine, result)
            : await params.client.row('report', { ...params.client.correlation(machine), result }, null);
        if (result.kind !== 'bound') throw new ManagedMachineControllerError(result.kind === 'rejected' ? result.code : 'native_acquisition_unconfirmed');
    }
    if (!machine.resource || (machine.enrolledMachineId && params.action !== 'machines.managed.bootstrap.retry')) return null;
    // Installation/enrollment consumes this already persisted identity.
    const bootstrapCredential = machine.bootstrapCredentialRef
        ? await readBootstrapCredentialValue(params, machine, bootstrapCredentialRevision) : null;
    if (bootstrapCredential) bootstrapCredentialRevision = bootstrapCredential.revision;
    const carrier = ManagedBootstrapCarrierV1Schema.parse(await invoke('bootstrap', { resource: machine.resource.value,
        ...(bootstrapCredentialKind === 'ssh' && machine.bootstrapCredentialRef && bootstrapCredential ? { credentialRef: machine.bootstrapCredentialRef,
            bootstrapPublicKey: sshPublicKey(bootstrapCredential.value) } : {}),
    }));
    if (machine.enrolledMachineId && (carrier.kind !== 'native' || !carrier.guestHome)) return null;
    const correlation = ManagedEnrollmentCorrelationV1Schema.parse({ ...params.client.correlation(machine), resource: machine.resource });
    if (!machine.enrolledMachineId) machine = await params.client.row('enrollment-context', correlation);
    const { runManagedMachineEnrollment } = await import('./enrollment');
    const native: ManagedNativeBootstrapIO | undefined = carrier.kind === 'native' ? {
        exec: async (request) => {
            const result = MachineProvisionerNativeExecResultV1Schema.parse(await invoke('exec', {
                resource: correlation.resource.value, argv: ['sh', '-c', request.command],
                ...(request.input === undefined ? {} : { inputBase64: Buffer.from(request.input).toString('base64') }),
                ...(request.processConfig ? { processConfig: request.processConfig } : {}),
            }, request));
            if ('kind' in result) {
                if (!request.processConfig) throw new ManagedMachineControllerError('provider_unavailable');
                return { status: 0, stdout: '', stderr: '' };
            }
            if (request.processConfig) throw new ManagedMachineControllerError('native_boot_unconfirmed');
            if (result.termination.requestedBy.kind !== 'none' || result.termination.observed.kind !== 'exit'
                || result.stdoutTruncated || result.stderrTruncated) throw new ManagedMachineControllerError('provider_unavailable');
            return { status: result.termination.observed.exitCode, stdout: Buffer.from(result.stdoutBase64, 'base64').toString('utf8'), stderr: Buffer.from(result.stderrBase64, 'base64').toString('utf8') };
        },
        putFile: async (request) => {
            const result = MachineProvisionerPutFileResultV1Schema.parse(await invoke('putFile', {
                resource: correlation.resource.value, guestPath: request.path, bytesBase64: Buffer.from(request.bytes).toString('base64'),
            }, request));
            if (result.kind !== 'confirmed') throw new ManagedMachineControllerError(result.code ?? 'provider_unavailable');
        },
    } : undefined;
    // Native boot recovery has no installer task. Publish its retained identity
    // on the actual host operation before either recovery or installation runs.
    const domainRef = { kind: 'managedMachine' as const, id: machine.id,
        controller: correlation.controller, resource: correlation.resource };
    params.options.context?.operationOwnerUpdate?.update({ domainRef });
    const enrollment = await runManagedMachineEnrollment({ correlation, target, carrier, signal: params.options.signal,
        onTask: ({ taskId, kind }) => { params.options.context?.operationOwnerUpdate?.update({ domainRef: {
            ...domainRef, bootstrapTask: { id: taskId, taskKind: kind },
        } }); },
        onEvent: (event) => {
            if (event.type !== 'progress' || !event.message) return;
            const progress = (event.stepId
                ? { kind: 'phase', phase: event.stepId, label: event.message }
                : { kind: 'indeterminate', label: event.message }) satisfies ActionOperationProgressV1;
            params.options.context?.operationOwnerUpdate?.update({ progress });
        },
    }, {
        readCurrentManagedRow: async () => {
            params.options.signal?.throwIfAborted();
            if (params.input.runtimeRegistry.readPluginOccurrenceId(contribution.pluginId) !== occurrenceId) {
                throw new ManagedMachineControllerError('provider_unavailable');
            }
            return await params.client.row('current', correlation);
        }, native,
        materializeBootstrapCredential: async (reference) => {
            if (reference.resourceId !== machine.bootstrapCredentialRef?.resourceId || bootstrapCredentialRevision === undefined) {
                throw new ManagedMachineControllerError('credential_unavailable');
            }
            return await materializeBootstrapCredential(params, machine, bootstrapCredentialRevision);
        },
    });
    machine = await params.client.row('current', correlation);
    if (machine.enrolledMachineId !== enrollment.machineId) throw new ManagedMachineControllerError('enrollment_retired');
    return null;
}
