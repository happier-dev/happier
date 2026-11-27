import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentTeardownInputV1Schema, encodeBase64, type ActionExecutorContext } from '@happier-dev/protocol';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentProviderTeardownContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as installationStore from '@/daemon/identity/store';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import * as railway from '../../../../../packages/plugins/deployment-railway/src/index';
import { actionIds, deleteActionId, observeRemovalActionId } from '../../../../../packages/plugins/deployment-railway/src/actions';
import { createDataProjectTeardownForHost } from './dataProjectTeardown';
import type { DataTeardownHost } from './dataTeardown';

afterEach(() => vi.restoreAllMocks());

it('carries the provider scope from the linked database preview into the Delete review', async () => {
    const mounted = await createAdmittedPluginRuntimeFixture({
        runtimeOptions: { pluginIds: [railway.manifest.id, 'happier.machine.railway'] },
    });
    try {
        const accountId = 'account-owner';
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const base = createDeploymentEnvironmentDetailV1();
        const serverId = base.environment.serverId;
        const machineId = base.environment.controllerMachineId;
        if (!machineId) throw new Error('Expected a controller');
        const targetLink = createDeploymentTargetLinkHeaderV1({
            environmentId: base.environment.id, role: 'data', targetKind: 'railway-postgresql',
            source: { kind: 'plugin', contribution: { pluginId: railway.manifest.id, localId: 'postgresql' } },
            machines: [], members: [], createdByAccountId: accountId,
        });
        const environment = createDeploymentEnvironmentDetailV1({ ...base, targetLinks: [{
            targetLink, content: {
                providerResourceOrigin: 'created',
                credentialPrincipal: { kind: 'account', accountId,
                    purpose: { consumer: { pluginId: railway.manifest.id, localId: actionIds('postgresql').link }, purpose: 'cloud-api' },
                    target: { kind: 'account', account: {
                        service: { pluginId: 'happier.machine.railway', localId: 'railway-account' }, accountId: 'connected',
                    } },
                },
                providerIdentity: { providerAccountId: 'provider-project-id', providerResourceId: 'database-id', providerEnvironment: 'provider-environment-id' },
                providerEnvironment: { kind: 'native', selection: { projectId: 'provider-project-id', environmentId: 'provider-environment-id', serviceId: 'database-id' } },
            },
        }] });
        const unexpected = async (): Promise<never> => { throw new Error('Unexpected host operation'); };
        const owner = createDataProjectTeardownForHost({ machineId, serverId, serverHttpBaseUrl: 'https://home.example',
            credentials: { token, encryption: null }, resolveRequesterIdentity: unexpected, assertCurrent: async () => {},
            readEnvironment: async () => environment, readReceipt: unexpected, findReceipt: async () => null,
            readContent: unexpected, writeTransition: unexpected,
            createCandidate: async () => ({ contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 }),
            acquirePluginRuntimeRegistryLease: () => mounted.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => mounted.registry }),
        });
        const providerScope = { projectName: 'Billing', environmentName: 'EU staging' };
        const prepared = await owner.prepareProject({
            input: { serverId, environmentId: environment.environment.id, targetLinkId: targetLink.id, reason: 'manual', providerRemoval: 'delete' },
            context: { surface: 'cli', serverId },
            invokePreview: async () => ({ ok: true, result: { volumeRemoval: { kind: 'removed' }, providerScope } }),
        }, environment);
        expect(prepared).toMatchObject({ preview: { removal: { providerScope, environment: base.content.name, volumeRemoval: { kind: 'removed' } } } });
    } finally { await mounted.dispose(); }
});

describe('Railway teardown receipt observation', () => {
    it.each([
        { description: 'when observing the database absent', serviceDeleteConfirmed: true, observeFails: false },
        { description: 'after a failed observation followed by confirmed service absence', serviceDeleteConfirmed: true, observeFails: true },
        { description: 'after an unconfirmed service delete followed by confirmed service absence', serviceDeleteConfirmed: false, observeFails: false },
    ])('retains the kept-unchecked volume line $description', async ({ serviceDeleteConfirmed, observeFails }) => {
        const installationId = 'fixture-installation';
        const machineId = 'fixture-machine';
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
            version: 1, installationId, createdAt: 1,
            publicKey: encodeBase64(new Uint8Array(32), 'base64url'),
            privateKey: encodeBase64(new Uint8Array(64), 'base64url'),
        });
        const credentialRef = { service: { pluginId: 'happier.machine.railway', localId: 'railway-account' }, accountId: 'connected' };
        const content = DeploymentProviderTeardownContentV1Schema.parse({
            machines: [], images: [], machineResults: [], steps: [],
            teardown: { reason: 'manual', targetLinkRevision: 1, machines: [], resources: [], proofs: [] },
            platform: { targetLinkRevision: 1, providerResourceOrigin: 'created',
                credentialPrincipal: { kind: 'account', accountId: 'account-owner',
                    purpose: { consumer: { pluginId: railway.manifest.id, localId: actionIds('postgresql').link }, purpose: 'cloud-api' },
                    target: { kind: 'account', account: credentialRef } },
                providerIdentity: { providerAccountId: 'project-one', providerResourceId: 'database-one', providerEnvironment: 'production' },
                providerEnvironment: { kind: 'native', selection: { projectId: 'project-one', environmentId: 'production', serviceId: 'database-one' } },
                observation: { v: 1, state: 'queued', observedAtMs: 1000 } },
        });
        const deployment = createDeploymentReceiptHeaderV1({ operation: 'teardown', state: 'queued',
            acceptedExecution: { v: 1, controller: { machineId, installationId } } });
        const receipt = createDeploymentReceiptDetailV1({ deployment, content });
        const input = DeploymentTeardownInputV1Schema.parse({ serverId: 'home', environmentId: deployment.environmentId,
            expectedRevision: 1, targetLinkId: deployment.targetLinkId, expectedTargetLinkRevision: 1,
            requestKey: deployment.requestKey, reason: 'manual', contentArtifactId: deployment.contentArtifactId,
            contentHeaderVersion: deployment.contentHeaderVersion, contentBodyVersion: deployment.contentBodyVersion });
        const result = { ok: true, environmentId: deployment.environmentId, revision: 2, deploymentId: deployment.id,
            deploymentRevision: 2, state: 'succeeded' } as const;
        let observations = 0;
        const provider = await createPluginTestkit({ manifest: railway.manifest, module: railway, services: {
            http: createPluginHttpFixture({ async request(request) {
                const { query } = JSON.parse(new TextDecoder().decode(request.body));
                const reply = (data: unknown) => ({ status: 200, headers: {},
                    body: new TextEncoder().encode(JSON.stringify({ data })) });
                const pageInfo = { endCursor: null, hasNextPage: false };
                if (query.includes('volumeInstances')) return reply({ project: { id: 'project-one', environments: {
                    edges: [{ node: { id: 'production', volumeInstances: { edges: [{ node: {
                        environmentId: 'production', serviceId: 'database-one', volumeId: 'volume-one',
                        isPendingDeletion: false, deletedAt: null,
                    } }], pageInfo } } }], pageInfo,
                } } });
                if (query.includes('serviceDelete')) return reply({ serviceDelete: serviceDeleteConfirmed });
                if (query.includes('volumeDelete')) throw new TypeError('volume response lost');
                if (!query.includes('serviceInstances')) throw new Error('Unexpected Railway query');
                const edges = ++observations === 1 && (!serviceDeleteConfirmed || observeFails)
                    ? [{ node: { serviceId: 'database-one', serviceName: 'Database', deletedAt: null, service: { templateId: 'pg-template' } } }]
                    : [];
                return reply({ environment: { id: 'production', projectId: 'project-one',
                    serviceInstances: { edges, pageInfo } } });
            } }),
        } });
        const mounted = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: { pluginIds: [railway.manifest.id, 'happier.machine.railway'] },
        });
        try {
            const remove = { pluginId: railway.manifest.id, localId: deleteActionId };
            const observe = { pluginId: railway.manifest.id, localId: observeRemovalActionId };
            const context: ActionExecutorContext = { surface: 'cli', serverId: 'home',
                operationAcceptance: { operationId: deployment.actionOperationId, accept() {} } };
            const hostReviewedChild = createHostReviewedChildPortV1({ actionId: 'deployments.teardown', input, context,
                reviewAdmitted: true, plan: { children: [
                    { action: remove, role: 'projects.delete' }, { action: observe, role: 'projects.observe' },
                ] },
                execute: async (envelope) => {
                    const { input: child, action } = envelope as { input: unknown; action: typeof remove };
                    try {
                        return { ok: true, result: normalizeStrictJsonValue(await provider.invokeAction(action.localId, child)) };
                    } catch (error) {
                        return { ok: false, ...normalizeActionExecutorThrownError(error) };
                    }
                },
            });
            const writeTransition = vi.fn<DataTeardownHost['writeTransition']>().mockResolvedValue(result);
            const unexpected = async (): Promise<never> => { throw new Error('Observation should only write the retained receipt'); };
            const owner = createDataProjectTeardownForHost({ machineId, serverId: 'home', serverHttpBaseUrl: 'https://home.example',
                credentials: { token: 'fixture', encryption: null }, resolveRequesterIdentity: unexpected, assertCurrent: unexpected,
                readEnvironment: unexpected, readReceipt: unexpected, findReceipt: unexpected, readContent: unexpected, createCandidate: unexpected,
                writeTransition, acquirePluginRuntimeRegistryLease: () => mounted.controller.acquireRuntimeRegistry({
                    resolveRuntimeRegistry: async () => mounted.registry,
                }),
            });
            const execute = (current: typeof receipt) => owner.executeProject({
                actionId: 'deployments.teardown', input, receipt: result, context: { ...context, hostReviewedChild },
            }, current, { role: 'data', targetKind: 'railway-postgresql',
                source: { kind: 'plugin', contribution: { pluginId: railway.manifest.id, localId: 'postgresql' } } });
            function stored() {
                const transition = writeTransition.mock.lastCall?.[0];
                if (!transition) throw new Error('Expected a receipt transition');
                return createDeploymentReceiptDetailV1({
                    deployment: { ...deployment, state: transition.state },
                    content: DeploymentProviderTeardownContentV1Schema.parse(transition.content),
                });
            }

            const deletion = await execute(receipt);
            expect(deletion).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
            if (serviceDeleteConfirmed) {
                expect(deletion).toMatchObject({ failureCause: { phase: 'deployment.railway.data.volume_delete' } });
            }
            const deleteFailure = stored();
            let resumed = deleteFailure;
            if (observeFails) {
                await expect(execute(resumed)).resolves.toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
                resumed = stored();
                expect(resumed.deployment.state).toBe('outcome_unknown');
                expect(resumed.content).not.toHaveProperty('failure.failureCause.phase', 'deployment.railway.data.volume_delete');
            }
            await expect(execute(resumed)).resolves.toEqual(result);
            const settledReceipt = stored();
            expect(settledReceipt.deployment.state).toBe('succeeded');
            const settled = settledReceipt.content;
            expect(settled).toHaveProperty('platform.observation.volumeRemoval', { kind: 'kept-unchecked' });
            if (observeFails) expect(settled).not.toHaveProperty('failure');
            else expect(settled).toHaveProperty('failure', DeploymentProviderTeardownContentV1Schema.parse(deleteFailure.content).failure);
        } finally {
            await mounted.dispose();
            await provider.dispose();
        }
    });
});
