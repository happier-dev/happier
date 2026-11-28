import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionIdSchema, DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
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
import { createS0DeploymentDaemonIngress, installationBoundary, readS0ControllerCredentials, readS0Installation } from './deploymentDaemonIngress.composed.testkit';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';
import { configuration } from '@/configuration';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { sealSavedSecretResourceRecipientEnvelopeV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { handleActionsCommand } from '@/cli/commands/actions';
import { writeDaemonState, writeStoredCredentialsForServerId } from '@/persistence';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { startDaemonControlServer } from '@/daemon/controlServer';
import { createDaemonPatVerifier } from '@/daemon/auth/daemonPatVerifier';
import { createAccountServerPatIntrospector } from '@/daemon/auth/accountServerPatIntrospector';
import { resolveLiveDaemonControlTargetForServer } from '@/daemon/multiDaemon';
import { bindPresentUserActionConfirmationV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import { MACHINE_ACCESS_GRANT_SET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machine/accessActionIdsV1';
import { db } from '../../../server/sources/storage/db';

afterEach(() => vi.restoreAllMocks());

// The fixtures share the server process's canonical Home identity cache.
const serverId = `srv_${randomUUID().replaceAll('-', '')}`;

it('settles one reviewed Team Machine grant through the signed requester route', async () => {
    const home = await createDeploymentSocketHome({ encryptionMode: 'plain', serverId });
    let daemon: Awaited<ReturnType<typeof createS0DeploymentDaemonIngress>> | undefined;
    try {
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(
            () => installationBoundary.getStore() ?? readS0Installation(home));
        daemon = await createS0DeploymentDaemonIngress({ home });
        const credentials = readS0ControllerCredentials(home);
        const executor = createCliActionExecutorFromCredentials({
            credentials, readCredentials: async () => credentials, externalActionClient: true,
            machineId: home.machineId, serverId, serverIdentityId: serverId, serverApiUrl: home.baseUrl,
        });
        const team = await db.team.create({ data: { name: 'Reviewed Machine grant' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: home.accountId, role: 'owner' } });
        const action = MACHINE_ACCESS_GRANT_SET_ACTION_ID_V1;
        const input = { serverId, machineId: home.machineId, principal: { kind: 'team', teamId: team.id }, level: 'view' } as const;
        const context = { surface: 'cli', authority: 'present_user', actionRequestId: randomUUID(),
            runtimeAccountId: home.accountId, serverId, serverIdentityId: serverId,
            externalActionTarget: { kind: 'machine', machineId: home.machineId } } as const;
        const readGrant = () => db.machineGrant.findFirst({
            where: { machineId: home.machineId, teamId: team.id }, select: { accessLevel: true },
        });
        const review = await executor.execute(action, input, context);
        expect(review).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
        if (review.ok || typeof review.details?.reviewDigest !== 'string') throw new Error('No current Machine grant review was returned');
        expect(await readGrant()).toBeNull();
        const digest = review.details.reviewDigest;
        const staleDigest = `${digest[0] === '0' ? '1' : '0'}${digest.slice(1)}`;
        const stale = await executor.execute(action, input, bindPresentUserActionConfirmationV1(action, input, context, staleDigest));
        expect(stale).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
        expect(await readGrant()).toBeNull();
        const settled = await executor.execute(action, input, bindPresentUserActionConfirmationV1(action, input, context, digest));
        expect(settled).toMatchObject({ ok: true, result: { kind: 'saved' } });
        expect(await readGrant()).toEqual({ accessLevel: 'view' });
    } finally {
        try { await daemon?.close(); } finally { await home.close(); }
    }
});

it.each([
    ['controller', 'plain', 'dataKey'], ['targeted-cli', 'plain', 'dataKey'], ['targeted-terminal', 'plain', 'dataKey'],
    ['controller-terminal', 'plain', 'dataKey'],
    ['targeted-terminal', 'e2ee', 'dataKey'], ['targeted-terminal', 'e2ee', 'legacy'],
    ['targeted-terminal-local', 'e2ee', 'legacy'],
    ['targeted-invalid-deploy', 'e2ee', 'legacy'],
] as const)('retains the %s binding review through its canonical approval decision (%s, %s)', async (entry, encryptionMode, credentialVariant) => withConfiguredDaemonTestHome({
    prefix: 'happier-cli-binding-review-', env: { HAPPIER_ACTIVE_SERVER_ID: 'cli-review-profile' },
}, async () => {
    const home = await createDeploymentSocketHome({ encryptionMode, credentialVariant, serverId,
        ...(encryptionMode === 'e2ee' ? { prepareMachineContent: (key: Uint8Array, metadata: Readonly<Record<string, unknown>>) =>
            createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: key,
                encryptionVariant: 'dataKey' }).encodeStored(metadata) } : {}) });
    let daemon: Awaited<ReturnType<typeof createS0DeploymentDaemonIngress>> | undefined;
    let control: Awaited<ReturnType<typeof startDaemonControlServer>> | undefined;
    const lifetime = new AbortController();
    try {
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(
            () => installationBoundary.getStore() ?? readS0Installation(home));
        const credentials = readS0ControllerCredentials(home);
        expect(credentials.encryption?.type ?? null).toBe(encryptionMode === 'plain' ? null : credentialVariant);
        const daemonToken = entry === 'targeted-terminal-local'
            ? await auth.createToken(home.accountId, undefined, { kind: 'terminal', authority: 'account_automation' }) : home.token;
        const daemonCredentials = readS0ControllerCredentials({ ...home, token: daemonToken });
        if (entry === 'targeted-terminal-local') {
            expect(readAuthTokenProvenance(decodeJwtPayload(daemonToken), { allowLegacyHome: false })?.provenance)
                .toMatchObject({ kind: 'terminal', authority: 'account_automation' });
        }
        const artifactStore = createCredentialedAccountArtifactStore(credentials);
        const createContentArtifact = async (content: { body: string }, kind: typeof DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1
            | typeof DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1) => {
            if (encryptionMode === 'plain') return home.createContentArtifact(content, kind);
            const artifact = await runWithServerHttpBaseUrl(home.baseUrl,
                () => artifactStore.create({ header: { kind, title: 'Deployment content' }, body: content.body }));
            return { contentArtifactId: artifact.artifactId, contentHeaderVersion: artifact.revision.headerVersion,
                contentBodyVersion: artifact.revision.bodyVersion };
        };
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
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: daemonCredentials, serverId: home.serverId,
            resolveRequesterIdentity, acquirePluginRuntimeRegistryLease: () => pluginReloadController.acquireRuntimeRegistry(),
            serverHttpBaseUrl: home.baseUrl, machineId: home.machineId, signal: lifetime.signal });
        daemon = await createS0DeploymentDaemonIngress({ home: { ...home, daemonToken }, resolveDeploymentRequesterIdentity: resolveRequesterIdentity,
            createDeploymentActionDeps: (requester, operations) => createRequesterBoundDeploymentActionDeps({
                credentials: requester?.credentials ?? daemonCredentials, serverId: home.serverId,
                serverHttpBaseUrl: home.baseUrl, machineId: home.machineId, runtime,
                resolveRequesterIdentity,
                runActionOperation: operations.runActionOperation,
                acquirePluginRuntimeRegistryLease: () => pluginReloadController.acquireRuntimeRegistry(),
                ...(requester ? { savedSecretOperationContext: requester.savedSecretOperationContext } : {}),
            }) });
        if (entry === 'targeted-terminal-local') {
            const resolveOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl: home.baseUrl,
                resolveCurrentMachineId: () => home.machineId, resolveCurrentServerIdentityId: () => home.serverId });
            const controlToken = randomUUID();
            control = await startDaemonControlServer({ machineId: home.machineId, controlToken,
                getChildren: () => [], stopSession: async () => ({ status: 'stopped' }),
                spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
                requestShutdown: () => {}, onHappySessionWebhook: () => {}, externalActionApi: {
                    ...daemon.externalActionIngressOwner, currentAccountId: home.accountId,
                    resolveInstallationId: () => home.installationId,
                    resolvePluginExecutionOriginContext: resolveOrigin,
                    acquirePluginRuntimeRegistryLease: () => pluginReloadController.acquireRuntimeRegistry(),
                    verifyPat: createDaemonPatVerifier({ accountId: home.accountId,
                        introspect: createAccountServerPatIntrospector({ daemonConnectionToken: daemonCredentials.token,
                            serverBaseUrl: home.baseUrl }) }),
                    executeOriginalAccountAction: request => dispatchOriginalAccountAction({ credentials: daemonCredentials,
                        serverHttpBaseUrl: home.baseUrl, serverIdentityId: home.serverId,
                        actionId: request.actionId, input: request.input,
                        requestId: request.actionRequestId ?? randomUUID(),
                        target: request.target ?? { kind: 'machine', machineId: home.machineId },
                        invocation: { caller: { kind: 'host' }, surface: request.surface ?? 'cli', authority: request.authority },
                        authority: request.authority, signal: request.signal }),
                } });
            writeDaemonState({ pid: process.pid, httpPort: control.port, startedAt: Date.now(),
                startedWithCliVersion: 'test', controlToken, machineId: home.machineId, accountId: home.accountId });
            const publication = await resolveLiveDaemonControlTargetForServer(configuration.activeServerId);
            expect({ machineId: publication?.machineId, accountId: publication?.accountId, port: publication?.httpPort })
                .toEqual({ machineId: home.machineId, accountId: home.accountId, port: control.port });
        }
        const callerCredentials = entry === 'targeted-invalid-deploy' ? { ...credentials,
            token: await auth.createToken(home.accountId, undefined, { kind: 'terminal', authority: 'account_automation' }) } : credentials;
        const caller = createCliActionExecutorFromCredentials({ credentials: callerCredentials, readCredentials: async () => callerCredentials,
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
        const definition = { kind: 'stored' as const, contentRevision: 1, document,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
            profiles: [], services: ['database'] };
        const created = await fetch(`${home.baseUrl}/v1/deployments/environments`, {
            method: 'POST', headers: { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
            serverId: home.serverId, projectSourceId: source.source.id, requestKey: randomUUID(),
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: home.machineId, buildMachineId: home.machineId,
            ...await createContentArtifact({ body: JSON.stringify({ name: 'CLI custody', retainPreviousDeployments: 1,
                definition, bindings: [],
            }) }, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1),
            firstTargetLink: { machines: [{ machineId: home.machineId, installationId: home.installationId }],
                ...await createContentArtifact({ body: '{}' }, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1) },
        }) });
        const environment = DeploymentEnvironmentCreateResultV1Schema.parse(await created.json());
        if (!environment.ok) throw new Error(environment.error);
        const opened = await invoke('deployments.environments.get', { serverId: home.serverId, environmentId: environment.environmentId });
        if (!opened.ok) throw new Error(opened.errorCode);
        const detail = DeploymentEnvironmentGetResultV1Schema.parse(opened.result);
        if (!detail.ok) throw new Error(detail.error);
        if (entry === 'targeted-invalid-deploy') {
            // The #153 CLI request supplied an Environment Artifact as a prepared
            // receipt. Keep the real Home content opening and daemon preparation.
            const link = detail.targetLinks[0];
            if (!link) throw new Error('Expected the created runtime target');
            const refused = await invoke('deployments.deploy', {
                serverId: home.serverId, environmentId: detail.environment.id,
                expectedRevision: detail.environment.revision,
                targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
                requestKey: randomUUID(), contentArtifactId: detail.environment.contentArtifactId,
                contentHeaderVersion: detail.environment.contentHeaderVersion,
                contentBodyVersion: detail.environment.contentBodyVersion,
            });
            expect(refused).toMatchObject({ ok: false, errorCode: 'deployment_content_unavailable',
                failureCause: { phase: 'deployment.artifact.kind', errorClass: 'TypeError',
                    errorCode: 'deployment_content_unavailable', httpStatus: null } });
            return;
        }
        const resourceId = randomUUID();
        const resourceDataKey = crypto.getRandomValues(new Uint8Array(32));
        const secretContent = { v: 1 as const, name: 'Binding credential', kind: 'token' as const, value: randomUUID() };
        const saved = await invokeSettled('secrets.shared.create', { resourceId, displayName: 'Binding credential', kind: 'token',
            ...(home.encryption ? { encryptionMode: 'e2ee',
                storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey,
                    content: secretContent, randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) }),
                keyEnvelopes: [{ recipientAccountId: home.accountId,
                    ...sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey,
                        recipientContentPublicKey: home.encryption.publicKey,
                        randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) }) }] }
                : { encryptionMode: 'plain', storedContent: sealSavedSecretResourceStoredContentV1({ resourceId,
                    mode: 'plain', content: secretContent }), keyEnvelopes: [] }) });
        resourceDataKey.fill(0);
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
        const terminal = entry === 'targeted-terminal' || entry === 'targeted-terminal-local';
        const controller = entry === 'controller' || entry === 'controller-terminal';
        const targetedCredentials = terminal || entry === 'controller-terminal' ? readS0ControllerCredentials({ ...home,
            token: await auth.createToken(home.accountId, undefined, { kind: 'terminal', authority: 'account_automation' }) }) : credentials;
        const executor = !controller
            ? createCliActionExecutorFromCredentials({ credentials: targetedCredentials, readCredentials: async () => targetedCredentials,
                externalActionClient: true, machineId: home.machineId,
                serverId: home.serverId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl,
                actionsSettingsProvider, onApprovalRequested })
            : createCliActionExecutor({ token: targetedCredentials.token, credentials: targetedCredentials,
            sessionId: 'cli-global', mode: 'plain', ctx: null, actionsSettingsProvider,
            serverId: home.serverId, serverIdentityId: home.serverId, serverHttpBaseUrl: home.baseUrl,
            machineId: home.machineId,
            isApprovalExecutionOriginCurrent: createHostApprovalOriginCurrentness({ credentials: targetedCredentials,
                serverId: home.serverId, serverApiUrl: home.baseUrl, resolveServerFeaturesSnapshot, checkDaemonOrigin }),
            onApprovalRequested });
        const bindingInput = { serverId: home.serverId,
            environmentId: environment.environmentId, expectedRevision: detail.environment.revision,
            set: [{ purpose: 'dataRole', service: 'database', role: 'readOnlyPassword',
                source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } }], remove: [] };
        if (terminal) {
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
                    && typeof event.data.artifactId === 'string') {
                    approvals.push(event.data.artifactId);
                }
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
            { surface: 'cli', actionCaller: { kind: 'host' }, authority: controller ? 'present_user' : 'account_automation',
                serverId: home.serverId, serverIdentityId: home.serverId, actionRequestId: randomUUID(),
                externalActionTarget: { kind: 'machine', machineId: home.machineId } });
        expect(approvals, JSON.stringify(decided)).toHaveLength(1);
        expect(decided, JSON.stringify(decided)).toMatchObject({ ok: false,
            errorCode: entry === 'targeted-cli' ? 'present_user_required' : 'service_unavailable' });
    } finally {
        lifetime.abort();
        await control?.stop();
        await daemon?.close();
        await home.close();
    }
}));
