import { createHash, randomUUID } from 'node:crypto';
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
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
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
import { createS0DeploymentDaemonIngress, installationBoundary, readS0ControllerCredentials, readS0Installation } from './deploymentDaemonIngress.testkit';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';
import { createOwnServerDockerBoundary } from './targets/ownServer/ownServerDeployment.testkit';
import { installRestoreBoundary } from './targets/ownServer/nativeRestore.testkit';

afterEach(() => vi.restoreAllMocks());

it('materializes a Saved Secret when an own-local CLI backup Test crosses Home approval and daemon ingress', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-cli-backup-custody-' }, async () => {
        const home = await createDeploymentSocketHome({ encryptionMode: 'plain' });
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
                body: JSON.stringify({ expectedVersion: currentSettings.version, content: { t: 'plain', v: preferences } }),
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
                ...await home.createContentArtifact({ body: JSON.stringify({ name: 'CLI backup custody', retainPreviousDeployments: 1,
                    definition: { kind: 'stored', contentRevision: 1, document,
                        composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
                        profiles: [], services: ['database'] }, bindings: [] }) }, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1),
                firstTargetLink: { machines: [{ machineId: home.machineId, installationId: home.installationId }],
                    ...await home.createContentArtifact({ body: '{}' }, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1) },
            }) });
            const environment = DeploymentEnvironmentCreateResultV1Schema.parse(await created.json());
            if (!environment.ok) throw new Error(environment.error);
            const opened = await invoke('deployments.environments.get', { serverId: home.serverId, environmentId: environment.environmentId });
            if (!opened.ok) throw new Error(opened.errorCode);
            const detail = DeploymentEnvironmentGetResultV1Schema.parse(opened.result);
            if (!detail.ok) throw new Error(detail.error);
            const resourceId = randomUUID();
            const saved = await invoke('secrets.shared.create', { resourceId, displayName: 'Backup repository password', kind: 'token',
                encryptionMode: 'plain', storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
                    content: { v: 1, name: 'Backup repository password', kind: 'token', value: randomUUID() } }), keyEnvelopes: [] });
            expect(saved.ok, saved.ok ? '' : saved.errorCode).toBe(true);

            const docker = await createOwnServerDockerBoundary(join(home.baseDir, 'tools'));
            const tools = dirname(docker.executablePath);
            await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
            await installRestoreBoundary(tools, 'repositoryOnly', { toolDirectory: tools, environmentId: environment.environmentId });
            nativeEnvironment.patch({ PATH: `${tools}${delimiter}${process.env.PATH ?? ''}` });
            const repository = join(home.baseDir, 'backup-repository');
            await mkdir(join(repository, environment.environmentId), { recursive: true });
            const testBackup = () => invoke('deployments.backups.configure', {
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
                    source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } }],
            });
            // The named own-local target must retain Home requester custody.
            writeDaemonState({ pid: process.pid, httpPort: control.port, startedAt: Date.now(),
                startedWithCliVersion: 'test', controlToken, machineId: home.machineId, accountId: home.accountId });
            const publication = await resolveLiveDaemonControlTargetForServer(profileId);
            expect({ machineId: publication?.machineId, accountId: publication?.accountId, port: publication?.httpPort })
                .toEqual({ machineId: home.machineId, accountId: home.accountId, port: control.port });
            approvals.length = 0;
            privateRootRequests = 0;
            const tested = await testBackup();
            expect(tested, JSON.stringify(tested)).toMatchObject({ ok: true });
            if (!tested.ok) throw new Error(tested.errorCode);
            expect(DeploymentBackupConfigureResultV1Schema.parse(tested.result)).toMatchObject({
                kind: 'tested', test: { kind: 'reachable', repositoryId: 'c'.repeat(64) },
            });
            expect(approvals).toHaveLength(1);
            expect(privateRootRequests).toBe(0);
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
