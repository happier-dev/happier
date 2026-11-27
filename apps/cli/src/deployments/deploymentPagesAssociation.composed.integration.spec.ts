import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { executeDeploymentAction } from '@happier-dev/protocol/actions/executor/deploymentAction';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { projectSettledApprovalExecution } from '@happier-dev/protocol/actions/executor/approvalResults';
import { projectApprovalRequestForPublicRead } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { DEPLOYMENT_TARGET_LINK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import {
    DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentGetResultV1Schema,
    DeploymentEnvironmentUpdateResultV1Schema, DeploymentTargetLinkCreateIntentInputV1Schema,
    DeploymentTargetLinkProvisionedResultV1Schema, readDeploymentActionOperationRequestIdV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ProjectSourcesCreateOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { decodeStoredCredentials, encodeStoredCredentials } from '@/persistence';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createDeploymentSocketHome } from '../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import * as cloudflare from '../../../../packages/plugins/deploy-cloudflare/src/index';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createInstalledDeploymentTargetContributions } from './platformFailureNotices.testkit';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';

const actionId = DEPLOYMENT_TARGET_LINK_ACTION_ID_V1;

it('associates a Pages Create through Home, keeps the typed partial result, and retries only the acknowledged Link', async () => {
    const home = await createDeploymentSocketHome();
    const cleanup: Array<() => Promise<void>> = [home.close];
    try {
        const homeMutation = async (method: 'POST' | 'PATCH', path: string, body: object) => {
            const response = await fetch(new URL(path, home.baseUrl), {
                method, headers: { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ serverId: home.serverId, ...body }),
            });
            return response.json();
        };
        const source = ProjectSourcesCreateOutputV1Schema.parse(await homeMutation('POST', '/v1/projects/sources', {
            requestKey: 'pages-project', name: 'Pages recovery', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const createFixture = async (requestKey: string, occupied: boolean) => {
            const content = await home.createContentArtifact({ body: JSON.stringify({
                name: requestKey, retainPreviousDeployments: 0, bindings: [],
                definition: { kind: 'folder', workspaceId: 'pages-workspace' },
            }) }, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1);
            const created = DeploymentEnvironmentCreateResultV1Schema.parse(await homeMutation('POST', '/v1/deployments/environments', {
                ...content, requestKey, projectSourceId: source.source.id, protection: 'nonProduction',
                purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: home.machineId, buildMachineId: home.machineId,
                ...(occupied ? { firstTargetLink: {
                    machines: [{ machineId: home.machineId, installationId: home.installationId }],
                    ...await home.createContentArtifact({ body: '{}' }, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1),
                } } : {}),
            }));
            if (!created.ok) throw new Error(created.error);
            return { ...created, content };
        };
        const occupied = await createFixture('occupied', true);
        const free = await createFixture('free', false);
        const stable = await createFixture('stable', false);
        const credentials = decodeStoredCredentials(encodeStoredCredentials({ token: home.token, encryption: home.encryption }));
        if (!credentials) throw new Error('Missing fixture Account credentials');
        const { contributes } = createInstalledDeploymentTargetContributions({
            pluginId: cloudflare.manifest.id, manifest: normalizePluginManifestV2(cloudflare.manifest),
            pluginRootPath: '/plugins/cloudflare', manifestPath: '/plugins/cloudflare/plugin.json',
            daemonEntryPath: '/plugins/cloudflare/daemon.js', devDaemonEntryPath: null,
            sourceSpec: { kind: 'package', locator: cloudflare.manifest.id, trustPolicy: 'local_trusted', installPolicy: 'copy' },
        });
        let currentRevision = free.revision;
        const nativePosts: string[] = [];
        const kit = await createPluginTestkit({ manifest: cloudflare.manifest, module: cloudflare, services: {
            http: createPluginHttpFixture({ async request(request) {
                expect(request.method).toBe('POST');
                expect(new URL(request.url).pathname).toBe('/client/v4/accounts/native-account/pages/projects');
                const { name } = JSON.parse(new TextDecoder().decode(request.body));
                nativePosts.push(name);
                if (name === 'needs-finish-linking') {
                    const patched = DeploymentEnvironmentUpdateResultV1Schema.parse(await homeMutation('PATCH', `/v1/deployments/environments/${free.environmentId}`, {
                        ...free.content, environmentId: free.environmentId, expectedRevision: free.revision,
                        patch: { deployerMode: 'members' },
                    }));
                    if (!patched.ok) throw new Error(patched.error);
                    expect(patched).toMatchObject({ ok: true, revision: free.revision + 1 });
                    currentRevision = patched.revision;
                }
                return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
                    result: { id: `native-${name}`, name, production_branch: 'main' },
                })) };
            } }),
        } });
        cleanup.push(kit.dispose);
        const host = { credentials, serverId: home.serverId, serverHttpBaseUrl: home.baseUrl, machineId: home.machineId };
        const resolveRequesterIdentity = async () => ({ kind: 'unknown' as const, reason: 'requester_authority_unavailable' as const });
        const deps = createDaemonDeploymentActionDeps({ ...host, resolveRequesterIdentity,
            runtime: createOwnServerDeploymentRuntimeForHost({ ...host, resolveRequesterIdentity }),
            acquirePluginRuntimeRegistryLease: async () => ({ registry: { contributes }, release: async () => {} }),
        });
        const operations = createHostActionOperationRuntime({ ...host, resolveAccountId: async () => home.accountId });
        const pluginId = cloudflare.manifest.id;
        const credentialRef = { service: { pluginId, localId: 'cloudflare' }, accountId: 'profile' };
        const createIntent = (environment: Pick<typeof free, 'environmentId' | 'revision'>, name: string,
            predecessor?: { id: string; revision: number }) => DeploymentTargetLinkCreateIntentInputV1Schema.parse({
            serverId: home.serverId, environmentId: environment.environmentId, expectedRevision: environment.revision,
            requestKey: name, targetId: 'pages', targetKind: 'cloudflare-pages', role: 'runtime', machines: [],
            ...(predecessor ? { replacesLinkId: predecessor.id, expectedTargetLinkRevision: predecessor.revision } : {}),
            source: { kind: 'plugin', contribution: { pluginId, localId: 'pages' } },
            providerCreate: { credentialRef, providerAccountId: 'native-account', resourceName: name,
                sourceMethod: 'upload', productionBranch: 'main', providerEnvironment: { kind: 'native', selection: { kind: 'production' } },
                credentialPrincipal: { kind: 'account', accountId: home.accountId, purpose: {
                    consumer: { pluginId, localId: 'pages-create' }, purpose: 'deploy.manage',
                }, target: { kind: 'account', account: credentialRef } },
            },
        });
        const runCreate = async (input: ReturnType<typeof createIntent>, transportRequestId = `transport-${input.requestKey}`) => {
            const plan = await deps.prepareHostReviewedChildren!({ actionId, input, context: {} });
            if (!plan || 'ok' in plan) throw new Error('Expected a reviewed Create');
            const context = { actionRequestId: transportRequestId,
                hostReviewedChild: createHostReviewedChildPortV1({ actionId, input, plan, context: {},
                    async execute(child) {
                        const invocation = getActionSpec('action.invoke').inputSchema.parse(child);
                        return { ok: true, result: await kit.invokeAction(invocation.action.localId, StrictJsonValueSchema.parse(invocation.input)) };
                    },
                }),
            };
            return operations.runActionOperation({ actionId, input, context,
                execute: active => executeDeploymentAction(actionId, input, active, deps),
            });
        };

        const invalid = createIntent(occupied, 'must-not-create');
        expect.soft(await runCreate(invalid)).toMatchObject({ ok: false, errorCode: 'deployment_conflict', effectAttempted: false });
        expect.soft(nativePosts).toEqual([]);

        expect(await runCreate(createIntent(stable, 'create-and-link'))).toMatchObject({
            ok: true, result: { ok: true, targetLinkId: expect.any(String) },
        });

        const readOccupied = async () => {
            const url = new URL(`/v1/deployments/environments/${occupied.environmentId}`, home.baseUrl);
            url.searchParams.set('serverId', home.serverId);
            const response = await fetch(url, { headers: { Authorization: `Bearer ${home.token}` } });
            const detail = DeploymentEnvironmentGetResultV1Schema.parse(await response.json());
            if (!detail.ok) throw new Error(detail.error);
            return detail;
        };
        const selected = await readOccupied();
        const predecessor = selected.targetLinks.find(link => link.id === selected.environment.runtimeTargetLinkId);
        if (!predecessor) throw new Error('Missing the reviewed predecessor Link');
        const replacement = createIntent({
            environmentId: occupied.environmentId, revision: selected.environment.revision,
        }, 'replace-and-link', predecessor);
        const replaced = await runCreate(replacement);
        expect(replaced).toMatchObject({ ok: true, result: { ok: true, targetLinkId: expect.any(String) } });
        const updated = await readOccupied();
        expect(updated.environment.runtimeTargetLinkId).not.toBe(predecessor.id);
        expect(updated.targetLinks.find(link => link.id === updated.environment.runtimeTargetLinkId)?.targetKind).toBe('cloudflare-pages');

        const input = createIntent(free, 'needs-finish-linking');
        const result = await runCreate(input);
        expect.soft(result).toMatchObject({ ok: false, errorCode: 'deployment_link_incomplete', effectAttempted: true,
            failureCause: { errorCode: 'deployment_conflict' } });
        if (result.ok) throw new Error('Expected an acknowledged but unassociated Pages project');
        const partial = DeploymentTargetLinkProvisionedResultV1Schema.parse(result.details);
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
            decision: { kind: 'approve', decidedAtMs: 2 },
            createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId, actionArgs: input, summary: 'Create Pages project',
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                serverId: home.serverId, accountId: home.accountId, machineId: home.machineId, actionId, requestId: 'transport-needs-finish-linking' },
        });
        const settled = projectSettledApprovalExecution({ request, actionId, exec: result, dispatchEffectAttempted: true, executedAtMs: 3 });
        const observedApproval = projectApprovalRequestForPublicRead(StoredApprovalRequestSchema.parse(settled.request));
        expect.soft(observedApproval).toMatchObject({ execution: { errorCode: 'deployment_link_incomplete', effectAttempted: true,
            failureCause: { errorCode: 'deployment_conflict' } } });
        expect(observedApproval).not.toHaveProperty('execution.details');
        expect(partial.recovery.provider.providerIdentity.providerResourceId).toBe('native-needs-finish-linking');
        const operationRequestId = readDeploymentActionOperationRequestIdV1(actionId, input);
        expect(operationRequestId).toBeDefined();
        expect(operations.store.findByRequestIdentity({ accountId: home.accountId, machineId: home.machineId },
            actionId, operationRequestId!)).toMatchObject({ requestId: operationRequestId, result: partial });

        expect(await runCreate(input, 'transport-retry')).toMatchObject({
            ok: false, errorCode: 'deployment_link_incomplete', details: partial,
        });
        const finish = { ...partial.recovery, expectedRevision: currentRevision };
        expect(await executeDeploymentAction(actionId, finish, {}, deps)).toMatchObject({ ok: true, result: { ok: true } });
        expect(nativePosts).toEqual(['create-and-link', 'replace-and-link', 'needs-finish-linking']);
    } finally {
        for (const dispose of cleanup.reverse()) await dispose();
    }
});
