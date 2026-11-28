import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1, createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';
import { DEPLOYMENT_PROMOTE_ACTION_ID_V1 as actionId } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentPromoteIntentInputV1Schema, type DeploymentPromoteIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentPromoteIntentV1';
import { act, createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const router = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => router.module);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
const { createDeploymentActions } = await import('./deploymentActions');
const { showDeploymentPromotionSheet } = await import('./DeploymentPromotionSheet');
const { Modal, ModalProvider } = await import('@/modal');
const { View } = await import('react-native');

afterEach(async () => {
  await act(async () => { Modal.hideAll(); });
  await homes.reset();
  await standardCleanup();
});

const homeIdentity = `srv_${'8'.repeat(32)}`;
const projectSourceId = 'source-app';
const sourceDeploymentId = 'receipt-61';
const confirm = 'project-deployments.promote.confirm';
const destinationRow = 'project-deployments.promote.destination:production';

async function renderPromotion(options: Readonly<{ sourceHasToken?: boolean; preview?: boolean }> = {}) {
  const serverId = await homes.addHome({
    name: 'Promotion', serverUrl: 'https://promotion-sheet.test', serverIdentityId: homeIdentity,
    accountId: 'account-owner', currentAccount: true,
  });
  const account = await captureLazyActionAccountContext(serverId);
  const scope = { ...account.accountLifetime.scope, projectSourceId };
  const sourceId = options.preview ? 'preview-12' : 'staging';
  const previewLink = options.preview ? createDeploymentTargetLinkHeaderV1({
    environmentId: sourceId, activeDeploymentId: undefined,
  }) : null;
  const source = createDeploymentEnvironmentHeaderV1({
    serverId: homeIdentity, projectSourceId, id: sourceId, contentArtifactId: 'artifact-promotion-source',
    runtimeTargetLinkId: previewLink?.id,
    ...(previewLink ? { purpose: 'preview', previewTemplateEnvironmentId: 'production',
      previewRepositoryId: projectSourceId, previewPullRequestId: 'pr:12', previewTargetLinkId: previewLink.id } : {}),
  });
  const destination = createDeploymentEnvironmentHeaderV1({
    serverId: homeIdentity, projectSourceId, id: 'production', contentArtifactId: 'artifact-promotion-destination',
    runtimeTargetLinkId: undefined, ...(options.preview ? { protection: 'production' } : {}),
  });
  const sourceBindings = options.sourceHasToken ? [createDeploymentSecretVariableBindingV1({
    name: 'TOKEN', phase: 'runtime', resourceId: 'token', resourceRevision: 1,
  })] : [];
  const fixture = createDeploymentEnvironmentV1();
  if (fixture.content.t !== 'plain') throw new Error('Expected a plaintext Environment fixture');
  for (const [environment, name, bindings] of [
    [source, options.preview ? 'Preview 12' : 'Staging', sourceBindings],
    [destination, 'Production', []],
  ] as const) {
    await account.createArtifactDocument({
      artifactId: environment.contentArtifactId,
      header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: name },
      body: JSON.stringify({ ...fixture.content.v, name, bindings }),
    });
    homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, {
      body: { ok: true, environment, targetLinks: environment === source && previewLink ? [previewLink] : [] },
    });
  }
  homes.answer(serverId, 'GET /v1/deployments/environments', {
    body: { ok: true, items: [destination], nextCursor: null },
  });

  const controller = createDeploymentReadControllerV1({
    scope, transport: createDeploymentReadTransport(account.accountLifetime),
  });
  const actions = createDeploymentActions(account.accountLifetime, projectSourceId);
  const screen = await renderScreen(<ModalProvider><View testID="host" /></ModalProvider>);
  const review = { pendingId: null, request: vi.fn(), open() {} };
  const onOpenReceipt = vi.fn();
  const open = (overrides: Partial<Parameters<typeof showDeploymentPromotionSheet>[0]> = {}) => act(async () => {
    showDeploymentPromotionSheet({
      controller, serverId, sourceEnvironmentId: source.id, sourceDeploymentId, target: { kind: 'ownServer' },
      ...(options.preview ? { production: { source } } : {}),
      name: options.preview ? 'Preview 12' : 'Staging', version: '7f3e2b1', promote: actions.promote, review, onOpenReceipt,
      ...overrides,
    });
  });
  return { screen, open, actions, review, onOpenReceipt, serverId, destination,
    dispose: async () => { await screen.unmount(); controller.retire(); account.dispose(); } };
}

type PromotionBoundary = Parameters<typeof answerExternalActionAccountForHome>[2];

async function answerPromotion(
  mounted: Awaited<ReturnType<typeof renderPromotion>>,
  execute: (input: DeploymentPromoteIntentInputV1) => unknown,
  failure?: PromotionBoundary['failure'],
) {
  const inputs: DeploymentPromoteIntentInputV1[] = [];
  await answerExternalActionAccountForHome(homes, mounted.serverId, {
    actionId, machineId: mounted.destination.controllerMachineId, tokenEpoch: 0, requesterInvocation: 'required',
    deploymentSource: { id: projectSourceId, revision: 1 },
    execute: raw => {
      const input = DeploymentPromoteIntentInputV1Schema.parse(raw);
      inputs.push(input);
      return execute(input);
    },
    failure,
  });
  return inputs;
}

const intent = (artifact: 'image' | 'rebuild') => ({
  serverId: homeIdentity, environmentId: 'production', sourceEnvironmentId: 'staging', sourceDeploymentId, artifact,
});

async function waitForRow(screen: Awaited<ReturnType<typeof renderScreen>>, id: string) {
  await waitForHomeGovernance(async () => {
    await act(async () => {});
    expect(screen.findByTestId(id), screen.getTextContent()).not.toBeNull();
  });
}

describe('Promote', () => {
  it('asks for the exact images first and offers a reviewed rebuild only after they cannot reach the destination', async () => {
    const mounted = await renderPromotion();
    const { screen, open, review } = mounted;
    const imageUnavailable = { errorCode: 'rollback_image_unavailable', error: 'rollback_image_unavailable', effectAttempted: false };
    try {
      const inputs = await answerPromotion(mounted, ({ artifact }) => artifact === 'image'
        ? imageUnavailable
        : { kind: 'approval_request_created', actionId, artifactId: 'rebuild-review' },
      result => result === imageUnavailable ? imageUnavailable : null);
      await open();
      await waitForRow(screen, destinationRow);
      expect(screen.findByTestId('project-deployments.promote.rebuild')).toBeNull();
      await screen.pressByTestIdAsync(destinationRow);
      await screen.pressByTestIdAsync(confirm);
      await waitForRow(screen, 'project-deployments.promote.rebuild');
      expect(inputs).toEqual([intent('image')]);
      await screen.pressByTestIdAsync('project-deployments.promote.rebuild.confirm');
      await waitForHomeGovernance(() => expect(review.request).toHaveBeenCalledWith('rebuild-review'));
      expect(inputs).toEqual([intent('image'), intent('rebuild')]);
    } finally { await mounted.dispose(); }
  });

  it('cancels a pending review and ignores a late receipt', async () => {
    const mounted = await renderPromotion();
    const { screen, open, onOpenReceipt } = mounted;
    // The sheet cancels its local review. The admitted Machine request can still return.
    const promote = vi.spyOn(mounted.actions, 'promote');
    const response = createDeferred();
    const receipt = { ok: true, deploymentId: 'late', environmentId: 'production', revision: 1,
      deploymentRevision: 1, state: 'succeeded' };
    try {
      const inputs = await answerPromotion(mounted, () => response.promise);
      await open({ initialDestination: { environmentId: 'production', projectSourceId, title: 'Production' } });
      await screen.pressByTestIdAsync(confirm);
      await waitForHomeGovernance(() => expect(inputs).toEqual([intent('image')]));
      const signal = promote.mock.calls[0]?.[1]?.signal;
      expect(signal?.aborted).toBe(false);
      await screen.pressByTestIdAsync('project-deployments.promote.cancel');
      expect(screen.findByTestId(confirm)).toBeNull();
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        response.resolve(receipt);
        await Promise.allSettled([promote.mock.results[0]?.value]);
      });
      expect(onOpenReceipt).not.toHaveBeenCalled();
    } finally {
      response.resolve(receipt);
      await mounted.dispose();
    }
  });

  it('sends Promote to admission and explains a typed Machine refusal with one next action', async () => {
    const mounted = await renderPromotion();
    const { screen, open } = mounted;
    try {
      const inputs = await answerPromotion(mounted, () => null, () => ({
        errorCode: 'target_unavailable', error: 'target_unavailable',
        details: { diagnostic: { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' } },
      }));
      await open();
      await waitForRow(screen, destinationRow);
      await screen.pressByTestIdAsync(destinationRow);
      await screen.pressByTestIdAsync(confirm);
      const { t } = await import('@/text');
      await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('errors.machineNotAnswering')));
      expect(inputs).toEqual([intent('image')]);
      expect(screen.getTextContent()).not.toContain('reconnect_machine');
      expect(screen.getTextContent()).toContain('Open targets');
    } finally { await mounted.dispose(); }
  });

  it('says which source variables the chosen destination lacks, links to its Variables and keeps the choice on return (#3)', async () => {
    const mounted = await renderPromotion({ sourceHasToken: true });
    const { screen, open } = mounted;
    const notice = 'project-deployments.promote.missingVariables';
    type Destination = NonNullable<Parameters<typeof showDeploymentPromotionSheet>[0]['initialDestination']>;
    let remembered: Destination | null = null;
    const openWithRememberedDestination = () => open({
      initialDestination: remembered,
      onChooseDestination: chosen => { remembered = chosen; },
    });
    try {
      await openWithRememberedDestination();
      await waitForRow(screen, destinationRow);
      expect(screen.findByTestId(notice)).toBeNull();
      await screen.pressByTestIdAsync(destinationRow);
      await waitForRow(screen, notice);
      expect(screen.getTextContent()).toContain('TOKEN');
      expect(screen.findByTestId(confirm)?.props.disabled).not.toBe(true);
      router.spies.push.mockClear();
      await screen.pressByTestIdAsync(`${notice}.action`);
      expect(router.spies.push).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ deploymentEnvironment: 'production', projectSourceId, deploymentTab: 'variables' }),
      }));
      expect(screen.findByTestId('project-deployments.promote')).toBeNull();
      await openWithRememberedDestination();
      await waitForRow(screen, notice);
      expect(screen.getTextContent()).toContain('TOKEN');
    } finally { await mounted.dispose(); }
  });

  it('promoting a build preview shows its address and health above the destinations (deploy auto-mode U9)', async () => {
    const mounted = await renderPromotion({ preview: true });
    const { screen, open } = mounted;
    try {
      await open();
      await waitForRow(screen, 'project-deployments.review.preview.health');
      expect(screen.findByTestId('project-deployments.review.preview.address')).not.toBeNull();
    } finally { await mounted.dispose(); }
  });
});
