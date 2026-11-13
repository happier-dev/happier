import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionIdSchema, DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectExternalActionExecutionResultV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { ProjectSourcesCreateOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { createDeploymentSocketHome } from '../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { auth } from '../../../server/sources/app/auth/auth';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createHostApprovalOriginCurrentness } from '@/session/actions/approvals/hostOriginCurrentness';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createRequesterBoundDeploymentActionDeps } from '@/daemon/externalActions/deploymentActionDeps';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import * as installationStore from '@/daemon/identity/store';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createS0DeploymentDaemonIngress, installationBoundary, readS0ControllerCredentials, readS0Installation } from './deploymentDaemonIngress.testkit';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';
import { configuration } from '@/configuration';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { handleActionsCommand } from '@/cli/commands/actions';
import { writeStoredCredentialsForServerId } from '@/persistence';

afterEach(() => vi.restoreAllMocks());

// Both fixtures share the server process's canonical Home identity cache.
const serverId = `srv_${randomUUID().replaceAll('-', '')}`;

it.each(['controller', 'targeted-cli', 'targeted-terminal'] as const)('retains the %s binding review through its canonical approval decision', async entry => withConfiguredDaemonTestHome({
    prefix: 'happier-cli-binding-review-', env: { HAPPIER_ACTIVE_SERVER_ID: 'cli-review-profile' },
}, async () => {
    const home = await createDeploymentSocketHome({ encryptionMode: 'plain', serverId });
    let daemon: Awaited<ReturnType<typeof createS0DeploymentDaemonIngress>> | undefined;
    const lifetime = new AbortController();
    try {
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(
            () => installationBoundary.getStore() ?? readS0Installation(home));
        const credentials = readS0ControllerCredentials(home);
        await adoptServerProfileHomeConnectionDescriptor({ observation: 'exact', createIfMissing: true,
            expectedProfileId: configuration.activeServerId, descriptor: {
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
                serverHttpBaseUrl: home.baseUrl, machineId: home.machineId, runtime,
                resolveRequesterIdentity,
                runActionOperation: operations.runActionOperation,
                acquirePluginRuntimeRegistryLease: () => pluginReloadController.acquireRuntimeRegistry(),
                ...(requester ? { savedSecretOperationContext: requester.savedSecretOperationContext } : {}),
            }) });
        const caller = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
            externalActionClient: true, machineId: home.machineId,
            serverId: home.serverId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl });
        const invoke = (action: string, input: unknown) => runWithServerHttpBaseUrl(home.baseUrl,
            () => caller.execute(ActionIdSchema.parse(action), input, {
                surface: 'cli',
                serverId: home.serverId, serverIdentityId: home.serverId, actionRequestId: randomUUID(),
            }));
        const invokeSettled = async (action: string, input: unknown) => {
            const result = await invoke(action, input);
            const approval = result.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
            if (!approval?.success) return result;
            const decision = await invoke('approval.request.decide', { artifactId: approval.data.artifactId, decision: 'approve' });
            if (!decision.ok) return decision;
            const settlement = decision.result;
            if (settlement === null || typeof settlement !== 'object' || !('execution' in settlement))
                throw new Error('Setup approval did not execute');
            const execution = projectExternalActionExecutionResultV1(settlement.execution);
            if (!execution) throw new Error('Setup approval returned an invalid execution result');
            return execution;
        };
        const sourceResponse = await fetch(`${home.baseUrl}/v1/projects/sources`, {
            method: 'POST', headers: { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverId: home.serverId, requestKey: randomUUID(), name: 'CLI custody', audience: [] }),
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
            ...await home.createContentArtifact({ body: JSON.stringify({ name: 'CLI custody', retainPreviousDeployments: 1,
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
        const saved = await invokeSettled('secrets.shared.create', { resourceId, displayName: 'Binding credential', kind: 'token',
            encryptionMode: 'plain', storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
                content: { v: 1, name: 'Binding credential', kind: 'token', value: randomUUID() } }), keyEnvelopes: [] });
        expect(saved.ok).toBe(true);
        const approvals: string[] = [];
        const resolveServerFeaturesSnapshot = () => fetchServerFeaturesSnapshot({
            serverUrl: home.baseUrl, token: home.token });
        const checkDaemonOrigin = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
            machineId: home.machineId, serverId: home.serverId, serverApiUrl: home.baseUrl, resolveServerFeaturesSnapshot });
        const actionsSettingsProvider = createActionSettingsProvider({ accountSettings: accountSettingsParse({
                actionsSettingsV1: { v: 1, actions: { 'deployments.bindings.set': { approvalRequiredSurfaces: ['cli'] } } },
            }) });
        const onApprovalRequested: NonNullable<Parameters<typeof createCliActionExecutor>[0]['onApprovalRequested']> = async (artifactId, _signal, decide) => {
            approvals.push(artifactId);
            return decide('approve');
        };
        const targetedCredentials = entry === 'targeted-terminal' ? readS0ControllerCredentials({ ...home,
            token: await auth.createToken(home.accountId, undefined, { kind: 'terminal', authority: 'account_automation' }) }) : credentials;
        const executor = entry !== 'controller'
            ? createCliActionExecutorFromCredentials({ credentials: targetedCredentials, readCredentials: async () => targetedCredentials,
                externalActionClient: true, machineId: home.machineId,
                serverId: home.serverId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl,
                actionsSettingsProvider, onApprovalRequested })
            : createCliActionExecutor({ token: home.token, credentials,
            sessionId: 'cli-global', mode: 'plain', ctx: null, actionsSettingsProvider,
            serverId: home.serverId, serverIdentityId: home.serverId, serverHttpBaseUrl: home.baseUrl,
            machineId: home.machineId,
            isApprovalExecutionOriginCurrent: createHostApprovalOriginCurrentness({ credentials,
                serverId: home.serverId, serverApiUrl: home.baseUrl, resolveServerFeaturesSnapshot, checkDaemonOrigin }),
            onApprovalRequested });
        const bindingInput = { serverId: home.serverId,
            environmentId: environment.environmentId, expectedRevision: detail.environment.revision,
            set: [{ purpose: 'dataRole', service: 'database', role: 'readOnlyPassword',
                source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } }], remove: [] };
        if (entry === 'targeted-terminal') {
            expect(configuration.activeServerId).not.toBe(home.serverId);
            await writeStoredCredentialsForServerId(configuration.activeServerId, targetedCredentials);
            const output: string[] = [];
            const previousExitCode = process.exitCode;
            const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
                output.push(String(chunk));
                const callback = args.find(value => typeof value === 'function');
                if (typeof callback === 'function') callback();
                return true;
            });
            const stderr = vi.spyOn(console, 'error').mockImplementation(value => {
                let event: unknown = value;
                if (typeof value === 'string') {
                    try { event = JSON.parse(value); } catch { return; }
                }
                if (event && typeof event === 'object' && 'data' in event && event.data
                    && typeof event.data === 'object' && 'kind' in event.data
                    && event.data.kind === 'approval_request_created' && 'artifactId' in event.data
                    && typeof event.data.artifactId === 'string') approvals.push(event.data.artifactId);
            });
            try {
                await handleActionsCommand(['invoke', 'deployments.bindings.set', '--input-json', JSON.stringify(bindingInput),
                    '--server-id', configuration.activeServerId, '--machine-id', home.machineId,
                    '--request-id', randomUUID(), '--yes', '--json'], {
                    createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params, actionsSettingsProvider }),
                }, lifetime.signal);
            } finally {
                stdout.mockRestore();
                stderr.mockRestore();
                process.exitCode = previousExitCode;
            }
            const result: unknown = JSON.parse(output.join(''));
            expect(approvals, JSON.stringify(result)).toHaveLength(1);
            expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { code: 'service_unavailable' } });
            return;
        }
        const decided = await executor.execute('deployments.bindings.set', bindingInput,
            { surface: 'cli', actionCaller: { kind: 'host' }, authority: entry === 'controller' ? 'present_user' : 'account_automation',
                serverId: home.serverId, serverIdentityId: home.serverId, actionRequestId: randomUUID(),
                externalActionTarget: { kind: 'machine', machineId: home.machineId } });
        expect(approvals, JSON.stringify(decided)).toHaveLength(1);
        expect(decided, JSON.stringify(decided)).toMatchObject({ ok: false,
            errorCode: entry === 'targeted-cli' ? 'present_user_required' : 'service_unavailable' });
    } finally {
        lifetime.abort();
        await daemon?.close();
        await home.close();
    }
}));
