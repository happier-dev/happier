import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { DeploymentBackupActionResultSchemasV1, type DeploymentBackupActionResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { createActionExecutorBoundaryFixture } from '../../../../../packages/tests/src/testkit/actionExecutorBoundary';
import { createNightlyBackupsWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/backupExamples';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { type DeploymentBackupConfigurationV1 } from '@happier-dev/deployments/contracts/v1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { createInMemoryWorkflowCoordinatorStore, createTestWorkflowCoordinator } from './workflowCoordinator.testkit';

const workspace = { machineId: 'controller', directory: '/repo', checkoutRootPath: '/repo' };
afterEach(() => { vi.restoreAllMocks(); });

describe('Nightly backup occurrences', () => {
    it.each([false, true])('resolves a new serving capture on the next occurrence (no Target=%s)', async noTarget => {
        const detail = createDeploymentEnvironmentDetailV1();
        detail.environment.revision = 4;
        const configuration: DeploymentBackupConfigurationV1 = {
            configRevision: 2, destinationRef: { pluginId: 'example.backups', localId: 'repository' }, occurrenceId: 'installed',
            config: { path: '/backups/app' }, credentialBindings: [],
            sources: [{ kind: 'volume', sourceId: 'data', service: 'app', volume: 'data', consistency: 'stopDuringCopy' }],
            ownership: { environmentId: detail.environment.id, prefix: 'app' }, retention: { kind: 'keepEverything' },
        };
        detail.content.backup = configuration;
        const { configRevision: _configRevision, ...backupPolicy } = configuration;
        let targetLinks = [createDeploymentTargetLinkHeaderV1({ activeDeploymentId: 'capture-a' })];
        detail.environment.runtimeTargetLinkId = targetLinks[0]!.id;
        const effects: { actionId: string; input: unknown }[] = [];
        const artifacts = createPlainAccountArtifactHttpBoundary();
        artifacts.rows.set(detail.environment.contentArtifactId, {
            id: detail.environment.contentArtifactId, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
            encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(detail.content) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        });
        // Only Home/Artifact HTTP and native backup effects are substituted.
        // The daemon dispatcher, private opener, binding and coordinator stay real.
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            expect(request.method?.toUpperCase()).toBe('GET');
            expect(new URL(request.url!).pathname).toBe(`/v1/deployments/environments/${detail.environment.id}`);
            return { status: 200, data: DeploymentEnvironmentGetResultV1Schema.parse({ ok: true,
                environment: detail.environment, targetLinks }) };
        });
        const { deploymentAction } = createDaemonDeploymentActionDeps({ credentials: artifacts.credentials,
            serverId: detail.environment.serverId, serverHttpBaseUrl: 'https://nightly.test', machineId: 'controller',
            resolveRequesterIdentity: async () => { throw new Error('Environment reads need no native requester'); },
            runtime: { async acquire() { throw new Error('Environment reads acquire no native runtime'); } },
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ deploymentAction,
            resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction),
            deploymentBackupAction: async (actionId, raw) => {
                effects.push({ actionId, input: raw });
                const result = actionId === 'deployments.backups.run' ? { kind: 'verified', operationId: 'backup-operation', manifests: [{
                    schemaVersion: 1, environmentId: detail.environment.id, sourceId: 'data', kind: 'volume', configRevision: 2,
                    repositoryId: 'a'.repeat(64), snapshot: { snapshotId: 'b'.repeat(64), treeId: 'c'.repeat(64),
                        hostname: 'target', time: '2026-11-10T00:00:00Z', paths: ['/data'], tags: [] },
                    totalBytesProcessed: 1, totalFilesProcessed: 1,
                }] } : actionId === 'deployments.backups.verify' ? { kind: 'verified', operationId: 'verify-operation',
                    backupOperationId: 'backup-operation', environmentId: detail.environment.id, configRevision: 2,
                    repositoryId: 'a'.repeat(64), snapshotId: 'b'.repeat(64), level: 'manifestReadBack', verified: true }
                    : { kind: 'noop', environmentId: detail.environment.id, configRevision: 2, forgottenSnapshotIds: [] };
                // The native boundary is dispatched by a generic Action id;
                // its owning schema validates the corresponding output.
                return DeploymentBackupActionResultSchemasV1[actionId].parse(result) as DeploymentBackupActionResultV1<typeof actionId>;
            },
        }));
        const run = (runId: string) => createTestWorkflowCoordinator({ store: createInMemoryWorkflowCoordinatorStore(),
            executeStep: async () => { throw new Error('Nightly backups launch no Agent'); },
            resolveWorkspace: async () => ({ ok: true, workspace }),
            action: { executor, buildContext: async () => ({ surface: 'cli', authority: 'account_automation', bypassApprovals: true,
                serverId: detail.environment.serverId, runtimeAccountId: 'account-owner' }),
                observeRun: async () => { throw new Error('Backup Actions have no child Run'); } },
        }).run({ runId, definition: createNightlyBackupsWorkflowV1(), inputs: {
            backupEnvironment: { serverId: detail.environment.serverId, environmentId: detail.environment.id },
            backupPolicy, verificationLevel: 'manifestReadBack',
        }, executionTarget: { kind: 'detached_run' }, authorization: {
            principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
        });
        const first = await run('nightly-a');
        expect(first, JSON.stringify(first)).toMatchObject({ state: 'succeeded' });
        expect(effects.map(effect => effect.actionId)).toEqual([
            'deployments.backups.run', 'deployments.backups.verify', 'deployments.backups.prune',
        ]);
        for (const effect of effects) expect(effect.input).toMatchObject({ expectedRevision: 4, deploymentId: 'capture-a' });
        detail.environment.revision = 5;
        targetLinks = noTarget ? [] : [createDeploymentTargetLinkHeaderV1({ activeDeploymentId: 'capture-b' })];
        if (noTarget) delete detail.environment.runtimeTargetLinkId;
        effects.length = 0;
        await expect(run('nightly-b')).resolves.toMatchObject(noTarget
            ? { state: 'interrupted', reason: 'deployment_unavailable' } : { state: 'succeeded' });
        if (noTarget) expect(effects).toEqual([]);
        else for (const effect of effects) expect(effect.input).toMatchObject({ expectedRevision: 5,
            deploymentId: 'capture-b', configRevision: 2 });
    });
});
