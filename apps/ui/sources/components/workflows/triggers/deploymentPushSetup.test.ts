import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { GITHUB_EVENT_SETUP_ACTIONS_V1, GITHUB_MANAGED_PUSH_EVENT_LOCAL_ID_V1 } from '@happier-dev/protocol/automations/event-setup-result';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import { WorkflowTriggerAddRequestV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { buildDeploymentPushFilter, buildDeploymentPushRequest } from './deploymentPushSetup';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const { Modal } = await import('@/modal');
const { DeploymentPushTriggerFields, showDeploymentPushDeliveryResult } = await import('./DeploymentPushTriggerFields');

afterEach(() => {
    vi.clearAllMocks();
    return standardCleanup();
});

const config = {
  environment: { serverId: 'home', environmentId: 'staging', projectSourceId: 'source' },
  targetLinkId: 'runtime', project: { machineId: 'controller', directory: '~' },
};
const trigger = { kind: 'pluginEvent' as const, enabled: true,
  eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/repository-pushed-v1' },
  sourceInstanceId: 'repository', sourceContractVersion: 1, sourceConfig: {}, displayLabel: 'Repository',
  observationTransport: { kind: 'checkpointedPull' as const, watcherMaterializationRef: {
    machineId: 'controller', materializationId: 'github', pluginId: 'happier.scm.forge.github' } },
  filter: null, maximumObservationAgeMs: null };

describe('Environment push setup', () => {
  it('clears a saved branch while retaining its path filter and excluding trigger identity', () => {
    expect(buildDeploymentPushFilter('  ', { triggerId: AutomationTriggerIdSchema.parse('retained'), branch: 'main', paths: ['apps/web/**'] }))
      .toEqual({ paths: ['apps/web/**'] });
  });
  it('binds the destination while leaving SHA and request identity to the admitted event', () => {
    const request = buildDeploymentPushRequest(config, trigger, undefined, 'main');
    expect(WorkflowTriggerAddRequestV1Schema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({ project: config.project, deployment: { branch: 'main' },
      executionTarget: { kind: 'detached_run' }, inputs: { serverId: 'home', environmentId: 'staging', targetLinkId: 'runtime' } });
    expect(request.inputs).not.toHaveProperty('sha');
    expect(request.inputs).not.toHaveProperty('requestKey');
    expect(request).not.toHaveProperty('actionApproval'); // owner prepares non-production/Production default
    expect(request.target.definition.blocks).toMatchObject([{ actionId: 'deployments.deploy', input: {
      sha: { kind: 'input', name: 'sha' }, requestKey: { kind: 'input', name: 'requestKey' } } }]);
  });
  it.each(['automatic', 'ask'] as const)('saves explicit %s through the existing trigger Action', choice => {
    const request = buildDeploymentPushRequest(config, trigger, choice);
    expect(request.actionApproval).toBe(choice);
    expect(request).not.toHaveProperty('actionApprovals');
    expect(request.deployment).toEqual({});
  });
});

const managedPushSource = {
    ...trigger,
    eventRef: { pluginId: GITHUB_EVENT_SETUP_ACTIONS_V1.pluginId, localId: GITHUB_MANAGED_PUSH_EVENT_LOCAL_ID_V1 },
    sourceInstanceId: 'github:repository:123',
};

describe('Deploy on push consent', () => {
    it('lets the person choose per-push approval and explains delivery before saving', async () => {
        const changeApproval = vi.fn();
        const screen = await renderScreen(React.createElement(DeploymentPushTriggerFields, {
            branch: 'main',
            onBranchChange: vi.fn(),
            approval: 'automatic',
            onApprovalChange: changeApproval,
            source: managedPushSource,
        }));

        expect(screen.getTextContent()).toContain(t('projects.deployments.pushDelivery.managedOnSave'));
        expect(screen.getTextContent()).toContain(t('settingsApiTokens.grant.deployApproval.automatic'));
        expect(screen.getTextContent()).toContain(t('settingsApiTokens.grant.deployApproval.ask'));
        await screen.pressByTestIdAsync('deployment-push-approval:ask');
        expect(changeApproval).toHaveBeenCalledWith('ask');
    });

    it('shows the reconnect remedy while preserving polling after a GitHub scope refusal', () => {
        showDeploymentPushDeliveryResult({
            kind: 'polling',
            code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialScopeMissing,
        });

        expect(Modal.alert).toHaveBeenCalledWith(
            t('projects.deployments.pushDelivery.saved'),
            t('projects.deployments.pushDelivery.reconnect'),
        );
    });
});
