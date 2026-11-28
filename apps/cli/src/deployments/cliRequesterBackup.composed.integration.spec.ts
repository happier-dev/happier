import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { mkdir } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionIdSchema, DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { createDeploymentDumpBackupSourceV1, RESTIC_RUNTIME_V1 } from '@happier-dev/deployments';
import { ProjectSourcesCreateOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { DeploymentBackupConfigureResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import { SFTP_BACKUP_DESTINATION_REF_V1 } from '@happier-dev/protocol/plugins/contributions/backupDestinations';
import { sealSavedSecretResourceRecipientEnvelopeV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createDeploymentSocketHome } from '../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createRequesterBoundDeploymentActionDeps } from '@/daemon/externalActions/deploymentActionDeps';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import * as installationStore from '@/daemon/identity/store';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { configuration } from '@/configuration';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { sealAccountSettingsV2RawContent } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { startDaemonControlServer } from '@/daemon/controlServer';
import { createDaemonPatVerifier } from '@/daemon/auth/daemonPatVerifier';
import { createAccountServerPatIntrospector } from '@/daemon/auth/accountServerPatIntrospector';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { writeDaemonState } from '@/persistence';
import { resolveLiveDaemonControlTargetForServer } from '@/daemon/multiDaemon';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { nativeRestic0191 } from '@/daemon/local/services/launch/nativeResticRegistry.testkit';
import { createS0DeploymentDaemonIngress, installationBoundary, readS0ControllerCredentials, readS0Installation } from './deploymentDaemonIngress.composed.testkit';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';
import { createOwnServerDockerBoundary } from './targets/ownServer/ownServerDeployment.testkit';
import { installRestoreBoundary } from './targets/ownServer/nativeRestore.testkit';

afterEach(() => vi.restoreAllMocks());

it.each(['plain', 'e2ee'] as const)('materializes a Saved Secret when an own-local CLI backup Test crosses Home approval and daemon ingress (%s)', async encryptionMode => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-cli-backup-custody-' }, async () => {
        const home = await createDeploymentSocketHome({ encryptionMode, requireE2ee: encryptionMode === 'e2ee',
            prepareMachineContent: (key, metadata) => createMachineContentCodec({
                encryptionMode: 'e2ee', encryptionKey: key, encryptionVariant: 'dataKey',
            }).encodeStored(metadata) });
        let daemon: Awaited<ReturnType<typeof createS0DeploymentDaemonIngress>> | undefined;
        let control: Awaited<ReturnType<typeof startDaemonControlServer>> | undefined;
        let mounted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        const lifetime = new AbortController();
        const nativeEnvironment = createEnvKeyScope(['PATH']);
        let privateRootRequests = 0;
        // Observe the real HTTP transports without replacing either ingress.
        const observeRequest = (message: unknown) => {
            if (!message || typeof message !== 'object' || !('request' in message)) return;
            const request = message.request;
            if (request && typeof request === 'object' && 'path' in request
                && request.path === '/actions/root/execute') privateRootRequests++;
        };
        const transports = [channel('http.client.request.start'), channel('undici:request:create')];
        for (const transport of transports) transport.subscribe(observeRequest);
        try {
            // Installation files and Docker/restic are the genuine host boundaries.
            vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(
                () => installationBoundary.getStore() ?? readS0Installation(home));
            const credentials = readS0ControllerCredentials(home);
            const artifacts = createCredentialedAccountArtifactStore(credentials);
            const createContentArtifact = async (body: string, kind: string) => {
                const artifact = await runWithServerHttpBaseUrl(home.baseUrl,
                    () => artifacts.create({ header: { kind, title: 'Backup fixture content' }, body }));
                return { contentArtifactId: artifact.artifactId, contentHeaderVersion: artifact.revision.headerVersion,
                    contentBodyVersion: artifact.revision.bodyVersion };
            };
            mounted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: {
                pluginIds: ['happier.backup.destinations'],
                scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider() },
            } });
            const profileId = configuration.activeServerId;
            const preferences = { actionsSettingsV1: { v: 1 as const,
                actions: { 'deployments.backups.configure': { approvalRequiredSurfaces: ['cli' as const] } } } };
            const settingsHeaders = { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json',
                ...buildCurrentAccountStoredContentCompatibilityHttpHeaders() };
            const currentSettings = AccountSettingsV2GetResponseSchema.parse(await (await fetch(
                `${home.baseUrl}/v2/account/settings`, { headers: settingsHeaders })).json());
            const settingsWrite = await fetch(`${home.baseUrl}/v2/account/settings`, {
                method: 'POST', headers: settingsHeaders,
                body: JSON.stringify({ expectedVersion: currentSettings.version, content: sealAccountSettingsV2RawContent({ credentials, raw: preferences,
                    envelopeKind: encryptionMode === 'e2ee' ? 'encrypted' : 'plain', randomBytes }) }),
            });
            expect(AccountSettingsV2UpdateResponseSchema.parse(await settingsWrite.json())).toMatchObject({ success: true });
            await adoptServerProfileHomeConnectionDescriptor({ observation: 'exact', createIfMissing: true,
                expectedProfileId: profileId, descriptor: {
                    v: 1, homeServerIdentityId: home.serverId, canonicalServerUrl: home.baseUrl,
                    revision: 1, endpoints: [{ kind: 'https', url: home.baseUrl }],
                } });
            const authority = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => home.serverId,
                resolveHostIdentity: async () => ({ custodianAccountId: home.accountId,
                    machineId: home.machineId, installationId: home.installationId }) });
            const resolveRequesterIdentity: Parameters<typeof createOwnServerDeploymentRuntimeForHost>[0]['resolveRequesterIdentity'] = async context => {
                const requester = await authority.resolveActionRequester!(context);
                try { return requester.identity; } finally { await requester.dispose(); }
            };
            const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: home.serverId,
                resolveRequesterIdentity, acquirePluginRuntimeRegistryLease: () => pluginReloadController.acquireRuntimeRegistry(),
                serverHttpBaseUrl: home.baseUrl, machineId: home.machineId, signal: lifetime.signal });
            daemon = await createS0DeploymentDaemonIngress({ home, resolveDeploymentRequesterIdentity: resolveRequesterIdentity,
                createDeploymentActionDeps: (requester, operations) => createRequesterBoundDeploymentActionDeps({
                    credentials: requester?.credentials ?? credentials, serverId: home.serverId,
                    serverHttpBaseUrl: home.baseUrl, machineId: home.machineId, runtime, resolveRequesterIdentity,
                    runActionOperation: operations.runActionOperation,
                    acquirePluginRuntimeRegistryLease: () => pluginReloadController.acquireRuntimeRegistry(),
                    ...(requester ? { savedSecretOperationContext: requester.savedSecretOperationContext } : {}),
                }) });
            const resolveOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl: home.baseUrl,
                resolveCurrentMachineId: () => home.machineId, resolveCurrentServerIdentityId: () => home.serverId });
            const controlToken = randomUUID();
            control = await startDaemonControlServer({ machineId: home.machineId, controlToken,
                getChildren: () => [], stopSession: async () => ({ status: 'stopped' }),
                spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
                requestShutdown: () => {}, onHappySessionWebhook: () => {},
                externalActionApi: {
                    ...daemon.externalActionIngressOwner, currentAccountId: home.accountId,
                    resolveInstallationId: () => home.installationId,
                    resolvePluginExecutionOriginContext: resolveOrigin,
                    acquirePluginRuntimeRegistryLease: () => pluginReloadController.acquireRuntimeRegistry(),
                    verifyPat: createDaemonPatVerifier({ accountId: home.accountId,
                        introspect: createAccountServerPatIntrospector({ daemonConnectionToken: credentials.token,
                            serverBaseUrl: home.baseUrl }) }),
                    executeOriginalAccountAction: request => dispatchOriginalAccountAction({ credentials,
                        serverHttpBaseUrl: home.baseUrl, serverIdentityId: home.serverId,
                        actionId: request.actionId, input: request.input,
                        requestId: request.actionRequestId ?? randomUUID(),
                        target: request.target ?? { kind: 'machine', machineId: home.machineId },
                        invocation: { caller: { kind: 'host' }, surface: request.surface ?? 'cli', authority: request.authority },
                        authority: request.authority, signal: request.signal }),
                } });
            const approvals: string[] = [];
            const onApprovalRequested: NonNullable<Parameters<typeof createCliActionExecutorFromCredentials>[0]['onApprovalRequested']> = async (artifactId, _signal, decide) => {
                approvals.push(artifactId);
                return decide('approve');
            };
            const caller = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
                externalActionClient: true, machineId: home.machineId,
                actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse(preferences) }),
                serverId: profileId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl,
                onApprovalRequested });
            const invoke = (action: string, input: unknown) => runWithServerHttpBaseUrl(home.baseUrl,
                () => caller.execute(ActionIdSchema.parse(action), input, {
                    surface: 'cli', actionCaller: { kind: 'host' }, authority: 'present_user',
                    serverId: profileId, serverIdentityId: home.serverId, actionRequestId: randomUUID(),
                    externalActionTarget: { kind: 'machine', machineId: home.machineId },
                }));
            const sourceResponse = await fetch(`${home.baseUrl}/v1/projects/sources`, {
                method: 'POST', headers: { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ serverId: home.serverId, requestKey: randomUUID(), name: 'CLI backup custody', audience: [] }),
            });
            const source = ProjectSourcesCreateOutputV1Schema.parse(await sourceResponse.json());
            if (!source.ok) throw new Error(source.error);
            const document = 'services:\n  database:\n    image: postgres:17\n';
            const created = await fetch(`${home.baseUrl}/v1/deployments/environments`, {
                method: 'POST', headers: { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                serverId: home.serverId, projectSourceId: source.source.id, requestKey: randomUUID(),
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: home.machineId, buildMachineId: home.machineId,
                ...await createContentArtifact(JSON.stringify({ name: 'CLI backup custody', retainPreviousDeployments: 1,
                    definition: { kind: 'stored', contentRevision: 1, document,
                        composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
                        profiles: [], services: ['database'] }, bindings: [] }), DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1),
                firstTargetLink: { machines: [{ machineId: home.machineId, installationId: home.installationId }],
                    ...await createContentArtifact('{}', DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1) },
            }) });
            const environment = DeploymentEnvironmentCreateResultV1Schema.parse(await created.json());
            if (!environment.ok) throw new Error(environment.error);
            const opened = await invoke('deployments.environments.get', { serverId: home.serverId, environmentId: environment.environmentId });
            if (!opened.ok) throw new Error(opened.errorCode);
            const detail = DeploymentEnvironmentGetResultV1Schema.parse(opened.result);
            if (!detail.ok) throw new Error(detail.error);
            const savePassword = async (value: string) => {
                const resourceId = randomUUID();
                const content = { v: 1 as const, name: 'Backup repository password', kind: 'token' as const, value };
                const resourceDataKey = randomBytes(32);
                const saved = await invoke('secrets.shared.create', { resourceId, displayName: content.name, kind: content.kind,
                    ...(home.encryption ? { encryptionMode: 'e2ee',
                        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey,
                            content, randomBytes }),
                        keyEnvelopes: [{ recipientAccountId: home.accountId, ...sealSavedSecretResourceRecipientEnvelopeV1({
                            resourceDataKey, recipientContentPublicKey: home.encryption.publicKey, randomBytes,
                        }) }] }
                        : { encryptionMode: 'plain', storedContent: sealSavedSecretResourceStoredContentV1({
                            resourceId, mode: 'plain', content }), keyEnvelopes: [] }),
                });
                resourceDataKey.fill(0);
                expect(saved.ok, saved.ok ? '' : saved.errorCode).toBe(true);

                return resourceId;
            };
            const password = randomUUID();
            const resourceId = await savePassword(password);

            const docker = await createOwnServerDockerBoundary(join(home.baseDir, 'tools'));
            const tools = dirname(docker.executablePath);
            await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
            await installRestoreBoundary(tools, 'repositoryOnly', {
                toolDirectory: tools, environmentId: environment.environmentId,
                repositoryPasswordDigest: createHash('sha256').update(password).digest('hex'),
            });
            nativeEnvironment.patch({ PATH: `${tools}${delimiter}${process.env.PATH ?? ''}` });
            const repository = join(home.baseDir, 'backup-repository');
            await mkdir(join(repository, environment.environmentId), { recursive: true });
            const testBackup = (secretId: string) => invoke('deployments.backups.configure', {
                serverId: home.serverId, environmentId: environment.environmentId,
                expectedRevision: detail.environment.revision, intent: 'test',
                configuration: {
                    configRevision: 1, destinationRef: { pluginId: SFTP_BACKUP_DESTINATION_REF_V1.pluginId, localId: 'local' },
                    occurrenceId: 'resolved-by-configure', config: { path: repository },
                    credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
                    sources: [createDeploymentDumpBackupSourceV1('database')],
                    ownership: { environmentId: environment.environmentId, prefix: environment.environmentId },
                    retention: { kind: 'keepEverything' },
                },
                backupBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword',
                    source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(secretId), resourceRevision: 1 } }],
            });
            // The named own-local target must retain Home requester custody.
            writeDaemonState({ pid: process.pid, httpPort: control.port, startedAt: Date.now(),
                startedWithCliVersion: 'test', controlToken, machineId: home.machineId, accountId: home.accountId });
            const publication = await resolveLiveDaemonControlTargetForServer(profileId);
            expect({ machineId: publication?.machineId, accountId: publication?.accountId, port: publication?.httpPort })
                .toEqual({ machineId: home.machineId, accountId: home.accountId, port: control.port });
            approvals.length = 0;
            privateRootRequests = 0;
            const tested = await testBackup(resourceId);
            expect(tested.ok, tested.ok ? '' : tested.errorCode).toBe(true);
            if (!tested.ok) throw new Error(tested.errorCode);
            expect(DeploymentBackupConfigureResultV1Schema.parse(tested.result)).toMatchObject({
                kind: 'tested', test: { kind: 'reachable', repositoryId: 'c'.repeat(64) },
            });
            expect(approvals).toHaveLength(1);
            expect(privateRootRequests).toBe(0);
            if (encryptionMode === 'e2ee') {
                const wrong = await testBackup(await savePassword(randomUUID()));
                if (!wrong.ok) throw new Error(wrong.errorCode);
                expect(DeploymentBackupConfigureResultV1Schema.parse(wrong.result)).toMatchObject({
                    kind: 'tested', test: { kind: 'failed', step: 'repository', reason: 'repository_password_incorrect' },
                });
            }
        } finally {
            for (const transport of transports) transport.unsubscribe(observeRequest);
            lifetime.abort();
            await control?.stop();
            await daemon?.close();
            await mounted?.dispose();
            nativeEnvironment.restore();
            await home.close();
        }
    });
});
