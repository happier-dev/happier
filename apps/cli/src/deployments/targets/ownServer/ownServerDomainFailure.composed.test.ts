import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { readDeploymentTargetLinkArtifactV1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentApprovalScopeResolverV1, DeploymentEnvironmentGetResultV1Schema, type ActionExecutorDeps, FeaturesResponseSchema, DeploymentActionInputSchemasV1, DeploymentChildRpcV1Schema } from '@happier-dev/protocol';
import { DeploymentDomainFailureDetailsV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { createOwnServerDomainActions, createOwnServerDomainContentWriter } from './ownServerDomainActions';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { readDeploymentEnvironmentForHost } from '@/deployments/readEnvironmentForHost';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { handleActionsCommand } from '@/cli/commands/actions';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = undefined; });

it.each(['service', 'missing_artifact', 'root_verify'] as const)('preserves native Domain %s diagnostics through the public CLI', async scenario => {
    await withConfiguredDaemonTestHome({ prefix: 'domain-service-failure-' }, async () => {
        const installation = await readOrCreateInstallationIdentity();
        const endpoint = 'https://domain-failure.test';
        const environment = createDeploymentEnvironmentDetailV1();
        const serverId = environment.environment.serverId;
        const machineId = 'receiver';
        const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, board: { enabled: true } } }, capabilities: { serverIdentity: { serverIdentityId: 'srv_domain_failure' } } });
        vi.stubGlobal('fetch', async () => Response.json(features));
        const machine = { id: machineId, kind: 'persistent', active: true, installationId: installation.installationId,
            revokedAt: null, replacedByMachineId: null,
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
        const link = environment.targetLinks[0].targetLink;
        link.members = [{ machineId, installationId: installation.installationId, state: 'active' }];
        link.machines = [machineId];
        const addInput = DeploymentActionInputSchemasV1['deployments.domains.add'].parse({ serverId,
            environmentId: environment.environment.id, domainId: 'domain', targetLinkId: link.id,
            expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision,
            requestKey: 'add-domain', contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 });
        const actionId = scenario === 'root_verify' ? 'deployments.domains.verify' : 'deployments.domains.add';
        const input = scenario === 'root_verify' ? DeploymentActionInputSchemasV1[actionId].parse({ serverId,
            environmentId: addInput.environmentId, domainId: addInput.domainId, expectedRevision: addInput.expectedRevision,
            expectedDomainRevision: 1, requestKey: 'verify-domain' }) : addInput;
        const domainHeader = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: input.domainId,
            environmentId: input.environmentId, targetLinkId: link.id, revision: 1, state: 'active',
            contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1,
            createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1, placements: [{
                placement: { serverId, accountId: 'owner', environmentId: input.environmentId, targetLinkId: link.id,
                    domainId: input.domainId, machineId, installationId: installation.installationId,
                    actionOperationId: 'original-domain-operation', requestId: 'original-domain-request', nativeServer: 'native' },
                content: { contentArtifactId: scenario === 'root_verify' ? 'retained-domain-content' : 'domain-content',
                    contentHeaderVersion: 1, contentBodyVersion: 1 },
                desired: true, listener: 'public' }] });
        const domain = { hostname: 'never-log-hostname.test', target: { service: 'never-log-service', containerPort: 8080 },
            healthCheck: { path: '/health', expectStatus: 200 } };
        const content = new Map<string, { kind: string; body: unknown }>([
            ['domain-content', { kind: 'deployment-domain.v1', body: domain }],
            [environment.environment.contentArtifactId, { kind: 'deployment-environment.v1', body: environment.content }],
            [link.contentArtifactId, { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, body: environment.targetLinks[0].content }],
        ]);
        // Home HTTP is the only substituted boundary. Artifact decoding, identity,
        // installed registry, native acquisition and operation settlement stay real.
        const httpPaths: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            httpPaths.push(path);
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
            if (path === '/v1/machines') return { status: 200, data: [machine] };
            if (path === `/v1/machines/${machineId}`) return { status: 200, data: { machine } };
            if (path === '/v1/account/encryption/currentness') return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === `/v1/deployments/environments/${input.environmentId}`) return { status: 200, data: {
                ok: true, environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) } };
            if (path === `/v1/deployments/environments/${input.environmentId}/domains/${input.domainId}`)
                return { status: 200, data: { ok: true, environmentId: input.environmentId, revision: input.expectedRevision, domain: domainHeader } };
            const id = decodeURIComponent(path.split('/').at(-1)!);
            if (scenario === 'missing_artifact' && id === 'domain-content'
                || scenario === 'root_verify' && id === 'retained-domain-content') return { status: 404, data: { error: 'not_found' } };
            const document = content.get(id);
            if (!document) throw new Error('Unexpected Home HTTP request');
            return { status: 200, data: { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ kind: document.kind, title: 'Domain' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(document.body) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            if (config.method?.toUpperCase() !== 'GET') throw new Error('Unexpected Home HTTP mutation');
            return axios.get(config.url!);
        });
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
        const artifacts = createCredentialedAccountArtifactStore(credentials);
        const mounted = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
            pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
        const runtime = createHostActionOperationRuntime({ serverId, machineId, resolveAccountId: async () => 'owner' });
        const daemon = createDaemonDeploymentActionDeps({ credentials, serverId, serverHttpBaseUrl: endpoint, machineId,
            accountArtifacts: artifacts, acquirePluginRuntimeRegistryLease: async () => mounted.lease,
            resolveRequesterIdentity: async () => { throw new Error('Unreached Source identity'); },
            runtime: { acquire: async () => { throw new Error('Unreached deployment acquisition'); } },
        });
        const open = (id: string, context: Parameters<NonNullable<ActionExecutorDeps['deploymentAction']>>[2]) =>
            runWithServerHttpBaseUrl(endpoint, () => artifacts.read(id, { signal: context.signal,
                prepareRecipients: false, includeSharedAudience: false }));
        const headers = async () => ({ Authorization: `Bearer ${credentials.token}` });
        // Verify is the legitimate sibling of add's proof-required discovery.
        // Compose the real root with concrete storage/native ports; no trusted
        // authorization is fabricated merely to reach the forwarding owner.
        const rootDomains = createOwnServerDomainActions({ serverId, machineId, credentials, serverHttpBaseUrl: endpoint,
            storage: daemon.deploymentAction,
            createContent: async () => { throw new Error('Verification does not author Domain content'); },
            dispatch: (job, context) => daemon.deploymentChild(DeploymentChildRpcV1Schema.parse(job), context),
            open, headers, persistPreparedContent: createOwnServerDomainContentWriter({ serverId,
                serverHttpBaseUrl: endpoint, artifacts, headers }),
            readInstallation: async () => installation.installationId,
            readEnvironment: async request => {
                const detail = await readDeploymentEnvironmentForHost(request, { open,
                    assertCurrent: async context => context.signal?.throwIfAborted(),
                    readMetadata: async ({ environmentId, context }) => {
                        const result = DeploymentEnvironmentGetResultV1Schema.parse(await daemon.deploymentAction(
                            'deployments.environments.get', { serverId, environmentId }, context));
                        if (!result.ok) throw new Error(result.error);
                        return result;
                    } });
                return { ...detail, targetLinks: await Promise.all(detail.targetLinks.map(async targetLink => {
                    const opened = readDeploymentTargetLinkArtifactV1(targetLink, await open(targetLink.contentArtifactId, request.context));
                    if (!opened.ok) throw new Error(opened.error);
                    return { targetLink, content: opened.content };
                })) };
            },
        });
        try {
            let output = '';
            vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
                output += String(chunk);
                const callback = args.find(argument => typeof argument === 'function');
                if (typeof callback === 'function') callback();
                return true;
            });
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            let stored: ApprovalRequestV2 | null = null;
            let onApprovalRequested: Parameters<typeof createCliActionExecutorHarness>[0]['onApprovalRequested'];
            // The CLI-to-receiver transport invokes the real native RPC owner.
            // Its operation runtime, approval replay and public projection remain real.
            const deployment: NonNullable<ActionExecutorDeps['deploymentAction']> = async (requestedActionId, args, context) => {
                if (requestedActionId === 'deployments.environments.get') return DeploymentEnvironmentGetResultV1Schema.parse(
                    (await axios.get(`${endpoint}/v1/deployments/environments/${input.environmentId}`)).data);
                if (requestedActionId === 'deployments.domains.verify') return rootDomains(requestedActionId, args, context);
                if (requestedActionId !== 'deployments.domains.add') throw new Error('Unexpected deployment transport');
                return ActionExecuteFailureSchema.parse(await daemon.deploymentChild(DeploymentChildRpcV1Schema.parse({
                    v: 1, kind: 'domainDiscover', actionId: requestedActionId, input: args,
                    machineId, installationId: installation.installationId }), context));
            };
            const { executor } = createCliActionExecutorHarness({ token: credentials.token, sessionId: '', mode: 'plain', ctx: null,
                serverHttpBaseUrl: endpoint, serverId, serverIdentityId: 'srv_domain_failure', machineId, deploymentAction: deployment,
                onApprovalRequested: (id, signal, decide) => onApprovalRequested?.(id, signal, decide) }, {
                ...createUnavailableActionTransportDeps(), deploymentAction: deployment,
                resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deployment),
                runActionOperation: runtime.runActionOperation,
                isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
                    credentials, machineId, serverId, serverApiUrl: endpoint }),
                approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'approval' }; },
                approvalsGet: async () => stored,
                approvalsUpdate: async ({ request }) => {
                    if (!stored) throw new Error('Missing approval');
                    const transition = decideApprovalRequestTransition(stored, request);
                    if (!transition.ok) return transition;
                    stored = ApprovalRequestV2Schema.parse(request);
                    return { ok: true };
                },
            });
            const context = { authority: 'account_automation' as const, runtimeAccountId: 'owner', serverId,
                serverIdentityId: 'srv_domain_failure', defaultSessionMachineId: machineId,
                externalActionTarget: { kind: 'machine' as const, machineId }, actionCaller: { kind: 'host' as const } };
            await handleActionsCommand(['invoke', actionId, '--input-json', JSON.stringify(input), '--yes', '--json'], {
                readCredentialsFn: async () => ({ ...credentials, credentialProvenance: 'stored_session' }),
                createExecutorFn: params => {
                    onApprovalRequested = params.onApprovalRequested;
                    return { execute: (id, args, ctx) => executor.execute(id, args, { ...ctx, ...context,
                        ...(id === 'approval.request.decide' ? { authority: 'present_user' } : {}) }),
                        resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } };
                },
            });
            const errorCode = scenario === 'service' ? 'service_unavailable' : 'deployment_content_unavailable';
            const step = scenario === 'service' ? 'service_docker' : 'native_execution';
            const phase = `deployment.domain.${step}`;
            const printed = JSON.parse(output);
            const result = { ok: false, errorCode: printed.error?.code, ...printed.error };
            expect(result, JSON.stringify({ httpPaths, error: printed.error })).toMatchObject({ ok: false, errorCode,
                failureCause: { phase, errorClass: 'Error' },
                details: { environmentId: input.environmentId, domainId: input.domainId, step,
                    ...(scenario === 'service' ? { requiredFact: 'managedServiceDocker' } : {}),
                    ...(scenario === 'root_verify' ? {} : { operation: { serverId, machineId, operationId: expect.any(String) } }) } });
            const details = DeploymentDomainFailureDetailsV1Schema.parse(result.details);
            if (scenario === 'root_verify') {
                // This read-only sibling proves the shared root forwarding seam.
                // Add's two cases below own approval settlement and receipts.
                expect(details).not.toHaveProperty('operation');
                expect(process.exitCode).toBe(1);
                expect(JSON.stringify(result)).not.toMatch(/never-log|Bearer|signature/);
                return;
            }
            if (!details.operation) throw new Error('Missing actual operation receipt');
            if (scenario !== 'service') expect(details).not.toHaveProperty('requiredFact');
            const receipt = await runtime.handlers.getV2({ operationId: details.operation.operationId },
                { callerAuthority: 'account_automation' });
            expect(receipt).toMatchObject({ operation: { operationId: details.operation.operationId,
                state: 'failed', error: { errorCode, failureCause: { phase } } } });
            const publicRead = await executor.execute('approval.request.get', { artifactId: 'approval' }, { surface: 'cli', ...context });
            expect(publicRead).toMatchObject({ ok: true, result: { request: { status: 'failed', execution: {
                failureCause: { phase }, details: result.details,
            } } } });
            expect(publicRead).not.toHaveProperty('result.request.execution.effectAttempted');
            const settled = ApprovalRequestV2Schema.parse(stored);
            expect(settled.execution).not.toHaveProperty('effectAttempted');
            for (const invalidDetails of [
                { ...details, environmentId: 'foreign-environment' },
                { ...details, domainId: 'foreign-domain' },
                { ...details, operation: { ...details.operation, serverId: 'foreign-home' } },
                { ...details, operation: { ...details.operation, machineId: 'foreign-machine' } },
                scenario === 'service' ? { ...details, requiredFact: 'routeUpstreams' } : { ...details, step: 'unknown' },
            ]) {
                // The persisted Artifact is a trust boundary: foreign or malformed
                // bags must not acquire the actual operation's receipt authority.
                stored = ApprovalRequestV2Schema.parse({ ...settled, execution: { ...settled.execution, details: invalidDetails } });
                const rejected = await executor.execute('approval.request.get', { artifactId: 'approval' }, { surface: 'cli', ...context });
                expect(rejected).toMatchObject({ ok: true, result: { request: { execution: {
                    failureCause: { phase },
                } } } });
                expect(rejected).not.toHaveProperty('result.request.execution.effectAttempted');
                if (!rejected.ok) throw new Error('Expected public approval read');
                expect(JSON.stringify(rejected.result)).not.toContain('"details"');
            }
            const previousNamedDetails = { ok: false, error: 'deployment_invalid', diagnostic: {
                step: 'target_link.environment_read', field: 'environmentId', rule: 'path_mismatch' } };
            stored = ApprovalRequestV2Schema.parse({ ...settled, execution: { ...settled.execution,
                errorCode: 'deployment_invalid', error: 'deployment_invalid', details: previousNamedDetails } });
            expect(await executor.execute('approval.request.get', { artifactId: 'approval' }, { surface: 'cli', ...context }))
                .toMatchObject({ ok: true, result: { request: { execution: { details: previousNamedDetails } } } });
            expect(printed.error).not.toHaveProperty('effectAttempted');
            expect(process.exitCode).toBe(1);
            expect(JSON.stringify(result)).not.toMatch(/never-log|Bearer|signature/);
        } finally { await mounted.dispose(); }
    });
});
