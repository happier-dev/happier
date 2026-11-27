import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentTeardownInputV1Schema, encodeBase64, type ActionExecutorContext } from '@happier-dev/protocol';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentProviderTeardownContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as installationStore from '@/daemon/identity/store';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import * as railway from '../../../../../packages/plugins/deployment-railway/src/index';
import { actionIds, observeRemovalActionId } from '../../../../../packages/plugins/deployment-railway/src/actions';
import { createDataProjectTeardownForHost } from './dataProjectTeardown';
import type { DataTeardownHost } from './dataTeardown';

afterEach(() => vi.restoreAllMocks());

describe('Railway teardown receipt observation', () => {
    it('retains the unconfirmed volume deletion when observing the database absent', async () => {
        const installationId = 'fixture-installation';
        const machineId = 'fixture-machine';
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
            version: 1, installationId, createdAt: 1,
            publicKey: encodeBase64(new Uint8Array(32), 'base64url'),
            privateKey: encodeBase64(new Uint8Array(64), 'base64url'),
        });
        const previousFailure = { code: 'outcome_unknown', phase: 'teardown', effectAttempted: true,
            failureCause: { phase: 'deployment.railway.data.volume_delete', errorClass: 'TypeError', errorCode: null, httpStatus: null } } as const;
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
            failure: previousFailure,
        });
        const deployment = createDeploymentReceiptHeaderV1({ operation: 'teardown', state: 'outcome_unknown',
            acceptedExecution: { v: 1, controller: { machineId, installationId } } });
        const receipt = createDeploymentReceiptDetailV1({ deployment, content });
        const input = DeploymentTeardownInputV1Schema.parse({ serverId: 'home', environmentId: deployment.environmentId,
            expectedRevision: 1, targetLinkId: deployment.targetLinkId, expectedTargetLinkRevision: 1,
            requestKey: deployment.requestKey, reason: 'manual', contentArtifactId: deployment.contentArtifactId,
            contentHeaderVersion: deployment.contentHeaderVersion, contentBodyVersion: deployment.contentBodyVersion });
        const result = { ok: true, environmentId: deployment.environmentId, revision: 2, deploymentId: deployment.id,
            deploymentRevision: 2, state: 'succeeded' } as const;
        const queries: string[] = [];
        const provider = await createPluginTestkit({ manifest: railway.manifest, module: railway, services: {
            http: createPluginHttpFixture({ async request(request) {
                const { query } = JSON.parse(new TextDecoder().decode(request.body));
                queries.push(query);
                return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ data: {
                    environment: { id: 'production', projectId: 'project-one',
                        serviceInstances: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } } },
                } })) };
            } }),
        } });
        const mounted = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: { pluginIds: [railway.manifest.id, 'happier.machine.railway'] },
        });
        try {
            const observe = { pluginId: railway.manifest.id, localId: observeRemovalActionId };
            const context: ActionExecutorContext = { surface: 'cli', serverId: 'home',
                operationAcceptance: { operationId: deployment.actionOperationId, accept() {} } };
            const hostReviewedChild = createHostReviewedChildPortV1({ actionId: 'deployments.teardown', input, context,
                reviewAdmitted: true, plan: { children: [{ action: observe, role: 'projects.observe' }] },
                execute: async (envelope) => {
                    const { input: child } = envelope as { input: unknown };
                    return { ok: true, result: normalizeStrictJsonValue(await provider.invokeAction(observe.localId, child)) };
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
            await expect(owner.executeProject({ actionId: 'deployments.teardown', input, receipt: result,
                context: { ...context, hostReviewedChild } }, receipt, { role: 'data', targetKind: 'railway-postgresql',
                source: { kind: 'plugin', contribution: { pluginId: railway.manifest.id, localId: 'postgresql' } } })).resolves.toEqual(result);
            expect(queries).toEqual([expect.stringContaining('serviceInstances')]);
            expect(writeTransition).toHaveBeenCalledWith(expect.objectContaining({ state: 'succeeded', content: expect.objectContaining({
                failure: previousFailure,
                platform: expect.objectContaining({ observation: expect.objectContaining({ volumeRemoval: { kind: 'kept-unchecked' } }) }),
            }) }));
        } finally {
            await mounted.dispose();
            await provider.dispose();
        }
    });
});
