import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import type { ActionConfirmationReviewInput } from './ActionConfirmationReview';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { LocalServiceStartApprovalReviewV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { DeploymentTemplateInstantiationReviewV1Schema } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { DeploymentEnvironmentCreationReviewV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentApprovalReviewV1Schema } from '@happier-dev/protocol/deployments/deploymentReviewV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { prepareApprovalRequest } from '@happier-dev/protocol/actions/executor/approvalPreparation';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installApprovalCommonModuleMocks({
  modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module,
  storage: () =>
    vi.importActual<typeof import('@/sync/domains/state/storage')>(
      '@/sync/domains/state/storage',
    ),
  text: () => vi.importActual<typeof import('@/text')>('@/text'),
});
const { confirmActionReview } =
  await import('./ActionConfirmationReview');
const { presentActionApproval } = await import('./actionApprovalPresentation');
const { ModalProvider } = await import('@/modal');

afterEach(() => standardCleanup());

const workspace = {
  serverId: 'home',
  machineId: 'devbox',
  workspaceId: 'checkout',
  rootPath: '/src/app',
};
const start = {
  machineId: 'devbox',
  targetId: 'web',
  workspace,
  declaration: {
    workspaceRefId: 'checkout',
    selection: { kind: 'manifest', name: 'web' },
  },
  expectedEffectDigest: 'a'.repeat(64),
};
/** What a receiving Machine carries back for a Restart it cannot present: the exact child it would start. */
const restart = {
  actionId: 'localServices.actions.restartManaged',
  actionArgs: {
    requestId: 'restart',
    action: 'restart_managed',
    target: {
      kind: 'managed_service',
      machineId: 'devbox',
      managedServiceId: 'old',
    },
  },
  preview: {
    hostReviewedChildren: {
      children: [
        {
          action: 'localServices.launcher.start',
          role: 'service.restart.start',
          input: start,
        },
      ],
    },
    hostReviewedContent: {
      serviceStartReview: LocalServiceStartApprovalReviewV1Schema.parse({
        request: start,
        target: workspace,
        reviewedEffectDigest: start.expectedEffectDigest,
        setup: {
          required: false,
          project: { serverId: 'home', projectId: 'project' },
          reviewedEffectDigest: 'b'.repeat(64),
          reviewedEffect: {},
        },
        reviewedEffect: {
          command: { source: { kind: 'command', command: 'serve web' } },
        },
      }),
    },
  },
} as const;

describe('native confirmation of a carried executor review', () => {
  it.each([
    { source: { kind: 'installed', pluginId: 'acme.example' } },
    { source: { kind: 'marketplace', sourceId: 'marketplace:fixture', pluginId: 'acme.example', version: '1.1.0', packageName: 'acme-example' } },
    { path: '/plugins/acme.example', kind: 'path' },
  ])('shows the evaluated plugin version and added authority before confirming $source.kind', async (actionArgs) => {
    const { preloadTranslations, setPreferredLanguageFromSettings } = await import('@/text');
    await preloadTranslations('en');
    setPreferredLanguageFromSettings('en');
    const { ActionConfirmationReviewFacts } = await import('./ActionConfirmationReview');
    const preview = { pluginInstall: { permissionsDisclosure: 'daemonEvaluated', pendingReview: {
      kind: 'reviewRequired', reviewKind: 'installation', pendingChangeId: 'reviewed-candidate',
      reason: 'authorityExpansion', currentVersion: '1.0.0', authorityExpansion: ['requiredHostAccess'],
      review: createPluginInstallationReviewFixture({ version: '1.1.0', requiredHostAccess: [{
        id: 'account-storage', capability: 'storage.account', reason: 'Store plugin records',
        normalizedScope: { enabled: true }, authorizationClass: 'hostResourceSelection',
      }] }),
    } } };
    const screen = await renderScreen(<ActionConfirmationReviewFacts actionId="plugins.install"
      actionArgs={actionArgs} preview={preview} serverId={null} testID="review" />);
    try {
      expect(screen.getTextContent()).toContain('1.0.0 → 1.1.0');
      expect(screen.getTextContent()).toContain('Storage account');
      expect(screen.getTextContent()).not.toContain('acme.example');
    } finally {
      await screen.unmount();
    }
  });

  it('shows the prepared Deployment family review when creation defaults and copy consequences are carried into native confirmation', async () => {
    const { preloadTranslations, setPreferredLanguageFromSettings } = await import('@/text');
    await preloadTranslations('en');
    setPreferredLanguageFromSettings('en');
    const { Modal } = await import('@/modal');
    const actionId = 'deployments.environments.create';
    const spec = getActionSpec(actionId);
    const actionArgs = spec.inputSchema.parse({ serverId: 'home', projectSourceId: 'source-app', requestKey: 'save-environment',
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'controller',
      contentArtifactId: 'reviewed-content', contentHeaderVersion: 1, contentBodyVersion: 1 });
    const deploymentReview = DeploymentEnvironmentCreationReviewV1Schema.parse({
      creationDefaults: { values: { controllerMachineId: 'controller', buildMachineId: 'builder', retainPreviousDeployments: 0 },
        sources: { controllerMachineId: 'project', buildMachineId: 'account', retainPreviousDeployments: 'project' } },
      creationDefaultsBasis: { projectSourceId: 'source-app', sourceRevision: 7, projectDefaultsRevision: 3, content: null },
      copy: { sourceEnvironmentId: 'staging', sourceRevision: 3, included: ['app settings'], omitted: ['production database'] },
    });
    const prepared = await prepareApprovalRequest({ actionId, input: actionArgs, actionArgs, deploymentReview,
      context: { surface: 'ui' }, deps: {} });
    if (!prepared || 'errorCode' in prepared) throw new Error('fixture_preparation_failed');
    const presentation = presentActionApproval({ actionId, actionArgs: prepared.actionArgs,
      preview: prepared.preview, kind: 'confirmation' });
    const screen = await renderScreen(<ModalProvider />);
    const answer = confirmActionReview({ actionId, actionArgs: prepared.actionArgs, preview: prepared.preview,
      title: presentation.title ?? '', summary: presentation.summary, summaryPlacement: 'host',
      confirmLabel: presentation.confirmLabel ?? '', irreversible: false, serverId: null });
    try {
      await vi.waitFor(() => expect(screen.findByTestId('actions.confirmation-review.decision-reject')).not.toBeNull());
      expect(screen.findByTestId('actions.confirmation-review.creation-review.defaults.retention')).not.toBeNull();
      expect(screen.getTextContent()).toContain('app settings');
      expect(screen.getTextContent()).toContain('production database');
      const chrome = vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.chrome;
      const visible = `${chrome?.kind === 'card' ? chrome.subtitle ?? '' : ''} ${screen.getTextContent()}`;
      if (spec.inputHints?.description) expect(visible).not.toContain(spec.inputHints.description);
      await screen.pressByTestIdAsync('actions.confirmation-review.decision-reject');
      await expect(answer).resolves.toBe(false);
    } finally {
      if (screen.findByTestId('actions.confirmation-review.decision-reject')) {
        await screen.pressByTestIdAsync('actions.confirmation-review.decision-reject');
        await answer;
      }
      await screen.unmount();
    }
  });

  it('shows the prepared Deployment family review without the Action API instructions in native chrome', async () => {
    const { preloadTranslations, setPreferredLanguageFromSettings, t } = await import('@/text');
    await preloadTranslations('en');
    setPreferredLanguageFromSettings('en');
    const { Modal } = await import('@/modal');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const serverId = getActiveServerSnapshot().serverId;
    const actionId = 'deployments.deploy';
    const spec = getActionSpec(actionId);
    const actionArgs = spec.inputSchema.parse({ serverId, environmentId: 'production', targetLinkId: 'runtime' });
    const deploymentReview = DeploymentApprovalReviewV1Schema.parse({ inspection: 'complete',
      environment: { id: 'production', name: 'Production website' },
      revision: { kind: 'stored', contentRevision: 2, composeDigest: `sha256:${'c'.repeat(64)}` },
      machineId: 'reviewed-runtime',
      services: [{ name: 'reviewed-website', replicas: 1, resources: { cpus: null, memory: null },
        restartPolicy: 'unless-stopped', healthcheck: 'configured', ports: [], mounts: [] }],
      risks: [{ kind: 'privileged', service: 'reviewed-website' }],
      target: { engine: 'native', requiresAwakeComputerAndDockerDesktop: false, domains: 'notDetermined' } });
    const prepared = await prepareApprovalRequest({ actionId, input: actionArgs, actionArgs, deploymentReview,
      context: { surface: 'ui' }, deps: {} });
    if (!prepared || 'errorCode' in prepared) throw new Error('fixture_preparation_failed');
    const agentInstructions = spec.inputHints?.description;
    if (!agentInstructions) throw new Error('fixture_requires_action_api_instructions');
    const presentation = presentActionApproval({ actionId, actionArgs: prepared.actionArgs,
      preview: prepared.preview, kind: 'confirmation' });
    const screen = await renderScreen(<ModalProvider />);
    const previousState = storage.getState();
    const machine = createMachineFixture({ id: 'reviewed-runtime', metadata: { displayName: 'Reviewed runtime host', host: 'runtime.local',
      platform: 'linux', happyCliVersion: '0.0.0-test', happyHomeDir: '/h', homeDir: '/h' } });
    await act(async () => storage.setState({ machines: { [machine.id]: machine },
      machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } }));
    const answer = confirmActionReview({ actionId, actionArgs: prepared.actionArgs, preview: prepared.preview,
      title: presentation.title ?? '', summary: presentation.summary, summaryPlacement: 'host',
      confirmLabel: presentation.confirmLabel ?? '', irreversible: false, serverId });
    try {
      await vi.waitFor(() => expect(screen.findByTestId('actions.confirmation-review.decision-reject')).not.toBeNull());
      const chrome = vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.chrome;
      const visible = `${chrome?.kind === 'card' ? chrome.subtitle ?? '' : ''} ${screen.getTextContent()}`;
      expect(visible).toContain('Production website');
      expect(screen.getTextContent().replace(/\s+/g, ' ').trim().startsWith([
        t('projects.deployments.review.whatTitle'), t('projects.deployments.review.environment'), 'Production website',
      ].join(' '))).toBe(true);
      expect(visible).toContain('Reviewed runtime host');
      expect(visible).toContain('reviewed-website');
      expect(visible).not.toContain(agentInstructions);
      await screen.pressByTestIdAsync('actions.confirmation-review.decision-reject');
      await expect(answer).resolves.toBe(false);
    } finally {
      if (screen.findByTestId('actions.confirmation-review.decision-reject')) {
        await screen.pressByTestIdAsync('actions.confirmation-review.decision-reject');
        await answer;
      }
      await screen.unmount();
      storage.setState(previousState, true);
    }
  });

  it('renders safe declared fields and keeps write-only secret input confidential', async () => {
    const { ActionConfirmationReviewFacts } = await import('./ActionConfirmationReview');
    const actionArgs = getActionSpec('notifications.webhooks.add').inputSchema.parse({ url: 'https://alerts.example.test/incoming' });
    const screen = await renderScreen(<ActionConfirmationReviewFacts actionId="notifications.webhooks.add"
      actionArgs={actionArgs} preview={{ actionId: 'notifications.webhooks.add', actionArgs }} serverId={null} testID="review" />);
    expect(screen.getTextContent()).toContain('https://alerts.example.test/incoming');
    const secretInput = getActionSpec('notifications.webhooks.signingSecret.set').inputSchema.parse({ channelId: 'alerts', secret: 'never-render-this-value' });
    await screen.update(<ActionConfirmationReviewFacts actionId="notifications.webhooks.signingSecret.set"
      actionArgs={secretInput} preview={{ actionId: 'notifications.webhooks.signingSecret.set', actionArgs: { channelId: 'alerts' } }}
      serverId={null} testID="review" />);
    expect(screen.getTextContent()).not.toContain('never-render-this-value');
    await screen.unmount();
  });

  it('shows the prepared notification destination and disclosure without rebuilding a spec summary', async () => {
    const { ActionConfirmationReviewFacts } = await import('./ActionConfirmationReview');
    const { SAVED_HEALTH_ALERT_TEST_ACTION_ID } = await import('@happier-dev/protocol/actions/notificationConfigurationActionIds');
    const actionArgs = getActionSpec(SAVED_HEALTH_ALERT_TEST_ACTION_ID).inputSchema.parse({ serverId: 'home', machineId: 'controller',
      sourceInstanceId: 'source', channelId: 'alerts', channelIndex: 0, expectedSourceRevision: 'revision' });
    const prepared = await prepareApprovalRequest({ actionId: SAVED_HEALTH_ALERT_TEST_ACTION_ID, input: actionArgs, actionArgs,
      context: { surface: 'ui' }, deps: { prepareNotificationTestApproval: async ({ input }) => ({ request: input,
        controllerMachineId: 'controller', destination: { room: 'operations-alerts' }, disclosure: 'Diagnostic content leaves this Home.' }) } });
    if (!prepared || 'errorCode' in prepared) throw new Error('fixture_preparation_failed');
    const screen = await renderScreen(<ActionConfirmationReviewFacts actionId={SAVED_HEALTH_ALERT_TEST_ACTION_ID}
      actionArgs={prepared.actionArgs} preview={prepared.preview} serverId={null} testID="review" />);
    expect(screen.getTextContent()).toContain('operations-alerts');
    expect(screen.getTextContent()).toContain('Diagnostic content leaves this Home.');
    await screen.unmount();
  });

  it('shows owner-prepared reboot deployment roles even when service discovery is unavailable', async () => {
    const { ActionConfirmationReviewFacts } = await import('./ActionConfirmationReview');
    const actionArgs = getActionSpec('machines.reboot').inputSchema.parse({ serverId: 'home', machineId: 'devbox', expectedInstallationId: 'installation' });
    const prepared = await prepareApprovalRequest({ actionId: 'machines.reboot', input: actionArgs, actionArgs,
      context: { surface: 'ui' }, deps: { machineRebootReferences: async () => ({ homeId: 'home', machineId: 'devbox', coverage: 'partial',
        references: [{ kind: 'deployment_environment', id: 'environment', name: 'Production status', deploymentRoles: ['edge'] }], nextCursor: null }),
      machineServiceAction: async () => ({ kind: 'unavailable', reason: 'unavailable' }) } });
    if (!prepared || 'errorCode' in prepared) throw new Error('fixture_preparation_failed');
    const screen = await renderScreen(<ActionConfirmationReviewFacts actionId="machines.reboot"
      actionArgs={prepared.actionArgs} preview={prepared.preview} serverId={null} testID="review" />);
    expect(screen.getTextContent()).toContain('Production status');
    expect(screen.findByTestId('review.reboot.roles-unavailable')).not.toBeNull();
    expect(screen.findByTestId('review.reboot.services-unavailable')).not.toBeNull();
    await screen.unmount();
  });
  it('shows the receiving target replacement consequences without exposing its private receipt', async () => {
    const { ActionConfirmationReviewFacts } = await import('./ActionConfirmationReview');
    const { HandoffTargetReplacementApprovalV1Schema } = await import('@happier-dev/protocol/sessions/control/handoff/handoffTargetReplacementApprovalV1');
    const approval = HandoffTargetReplacementApprovalV1Schema.parse({ v: 1,
      consequences: ['replace_nonempty_workspace_target', 'delete_target_only_files_during_exact_mirror'],
      serverId: 'home', machineId: 'target', canonicalRoot: '/srv/status', rootFingerprint: 'f'.repeat(64), operationId: 'private-operation-receipt' });
    const screen = await renderScreen(<ActionConfirmationReviewFacts actionId="workspace.sync.relationship.create" actionArgs={{}}
      preview={{ handoffTargetReplacementApproval: approval }} serverId={null} testID="review" />);
    expect(screen.findByTestId('approvals.handoff-target-consequences')).not.toBeNull();
    expect(screen.getTextContent()).toContain('/srv/status');
    expect(screen.getTextContent()).not.toContain(approval.rootFingerprint);
    expect(screen.getTextContent()).not.toContain(approval.operationId);
    await screen.unmount();
  });
  it('shows carried storage operands with the same resource family rows and no selection controls', async () => {
    const { ActionConfirmationReviewFacts } = await import('./ActionConfirmationReview');
    const actionArgs = getActionSpec('machines.storage.trash.move').inputSchema.parse({ machineId: 'devbox', emptyAfter: true,
      items: [{ ref: { itemId: 'cache', path: '/cache/old-build', identity: { dev: '1', ino: 'cache', kind: 'directory' },
        collectedAt: 1, collectedBy: { accountId: 'account', kind: 'person' } }, expect: 'claimed', claimedVerdict: 'safe' }] });
    const screen = await renderScreen(<ActionConfirmationReviewFacts actionId="machines.storage.trash.move" actionArgs={actionArgs}
      preview={{ actionArgs }} serverId={null} testID="review" />);
    expect(screen.findByTestId('resource-proposal-item-cache')).not.toBeNull();
    expect(screen.getTextContent()).toContain('/cache/old-build');
    expect(screen.findByTestId('resource-proposal-select-all')).toBeNull();
    expect(screen.findByTestId('resource-proposal-check-again')).toBeNull();
    await screen.unmount();
  });
  it('shows the carried Store installation document and first-run consequences', async () => {
    const review = DeploymentTemplateInstantiationReviewV1Schema.parse({
      templateRef: { sourceId: 'catalog', itemId: 'status', version: '1', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      services: ['status-web'], profiles: [], document: 'services:\n  status-web:\n    image: example/status:1',
      publicFiles: [{ path: 'config/status.conf', content: 'listen 8080' }],
      bindings: [], generatedSecrets: [], domains: [], firstRunSetup: true,
    });
    const agentSummary = getActionSpec('deployments.templates.instantiate').inputHints?.description;
    const input = { actionId: 'deployments.templates.instantiate', actionArgs: {}, preview: { summary: agentSummary, deploymentReview: review } } satisfies ActionConfirmationReviewInput;
    const screen = await renderScreen(<ModalProvider />);
    const answer = confirmActionReview({ ...input, title: 'Install status?', summary: null,
      confirmLabel: 'Install', irreversible: false, serverId: 'home' });
    await vi.waitFor(() => expect(screen.getTextContent().replace(/\s/g, '')).toContain('example/status:1'));
    expect(screen.getTextContent()).toContain('listen 8080');
    expect(screen.getTextContent()).toContain('Whoever opens it first creates the admin');
    if (agentSummary) expect(screen.getTextContent()).not.toContain(agentSummary);
    await vi.waitFor(() => expect(screen.findByTestId('actions.confirmation-review.decision-reject')).not.toBeNull());
    await screen.pressByTestIdAsync('actions.confirmation-review.decision-reject');
    await expect(answer).resolves.toBe(false);
    await screen.unmount();
  });
  it.each([true, false])(
    'shows the Machine-reviewed start command of a Restart and answers %s from its own decision',
    async (confirms) => {
      const screen = await renderScreen(<ModalProvider />);
      const answer = confirmActionReview({
        ...restart,
        title: 'Restart web?',
        summary: 'Anything using its address disconnects.',
        confirmLabel: 'Restart',
        irreversible: false,
        serverId: 'home',
      });
      await vi.waitFor(() => expect(screen.getTextContent()).toContain('serve web'));
    await vi.waitFor(() => expect(screen.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      await screen.pressByTestIdAsync(
        confirms
          ? 'actions.confirmation-review.decision-approve'
          : 'actions.confirmation-review.decision-reject',
      );
      await expect(answer).resolves.toBe(confirms);
      await screen.unmount();
    },
  );

  it('shows a carried summary through the shared facts renderer', async () => {
    const { ActionConfirmationReviewFacts } = await import('./ActionConfirmationReview');
    const screen = await renderScreen(<ActionConfirmationReviewFacts actionId="machines.setup.updates.apply" actionArgs={{}}
      preview={{ summary: 'Install 53 updates' }} serverId={null} testID="review" />);
    expect(screen.getTextContent()).toContain('Install 53 updates');
    await screen.unmount();
  });
  it.each([{ typed: 'delete', confirmed: false }, { typed: 'DELETE', confirmed: true }])(
    'requires the exact typed account deletion challenge ($typed) in the same carried review', async ({ typed, confirmed }) => {
      const { Modal } = await import('@/modal');
      const screen = await renderScreen(<ModalProvider />);
      const callsBefore = vi.mocked(Modal.show).mock.calls.length;
      const input = { actionId: 'account.delete', actionArgs: {}, preview: { summary: 'Delete the receiving Account and its saved data.' },
        title: 'Delete Account?', summary: null, confirmLabel: 'Delete Account', irreversible: true, serverId: null,
        typedConfirmation: { text: 'DELETE', placeholder: 'DELETE' } } satisfies Parameters<typeof confirmActionReview>[0];
      const answer = confirmActionReview(input);
      try {
        await vi.waitFor(() => expect(screen.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
        expect(screen.getTextContent()).toContain('Delete the receiving Account and its saved data.');
        expect(screen.findByTestId('actions.confirmation-review.typed-confirmation')).not.toBeNull();
        await act(async () => {
          screen.changeTextByTestId('actions.confirmation-review.typed-confirmation', typed);
        });
        await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
        await expect(answer).resolves.toBe(confirmed);
        expect(vi.mocked(Modal.show).mock.calls.length - callsBefore).toBe(1);
      } finally {
        if (screen.findByTestId('actions.confirmation-review.decision-reject')) {
          await screen.pressByTestIdAsync('actions.confirmation-review.decision-reject');
          await answer;
        }
        await screen.unmount();
      }
    },
  );
  it('draws a destructive confirm for a recoverable removal without promising it cannot be undone', async () => {
    const screen = await renderScreen(<ModalProvider />);
    const answer = confirmActionReview({ actionId: 'teams.groups.members.remove',
      actionArgs: { v: 1, teamId: 'team-1', groupId: 'group-1', accountId: 'account-1' }, preview: {},
      title: 'Remove Grace from this Group?', summary: null, confirmLabel: 'Remove', irreversible: false, destructive: true,
      serverId: null });
    try {
      await vi.waitFor(() => expect(screen.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      expect(screen.tree.root.findAllByProps({ testID: 'actions.confirmation-review.decision-approve' })
        .map(node => node.props.display)).toContain('destructive');
      expect(screen.findByTestId('approvals.irreversible-note')).toBeNull();
    } finally {
      await screen.pressByTestIdAsync('actions.confirmation-review.decision-reject');
      await answer;
      await screen.unmount();
    }
  });
  it('shows a carried consequence once when native chrome already presents its summary', async () => {
    const { Modal } = await import('@/modal');
    const summary = 'This allows unattended administrator access.';
    const actionArgs = getActionSpec('machines.setup.adminAccess.set').inputSchema.parse({ machineId: 'devbox',
      expectedMetadataVersion: 3, expectedAdminAccess: { version: 1, mode: 'none' },
      adminAccess: { version: 1, mode: 'preauthorized' }, comparison: 'field' });
    const screen = await renderScreen(<ModalProvider />);
    const answer = confirmActionReview({ actionId: 'machines.setup.adminAccess.set', actionArgs, preview: { summary },
      title: 'Allow administrator access?', summary, summaryPlacement: 'host', confirmLabel: 'Allow', irreversible: false, serverId: null });
    await vi.waitFor(() => expect(screen.findByTestId('actions.confirmation-review.decision-reject')).not.toBeNull());
    // The native modal boundary mounts the real body/footer; its emitted card chrome is rendered by the platform host.
    const config = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
    const subtitle = config?.chrome?.kind === 'card' ? config.chrome.subtitle : null;
    expect(subtitle).toBe(summary);
    expect(`${subtitle ?? ''} ${screen.getTextContent()}`.split(summary)).toHaveLength(2);
    expect(screen.findByTestId('approvals.preview.permission')).not.toBeNull();
    await screen.pressByTestIdAsync('actions.confirmation-review.decision-reject');
    await expect(answer).resolves.toBe(false);
    await screen.unmount();
  });
});
