// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  projectDeploymentReceiptFactsV1,
  projectDeploymentReceiptHistoryEntryV1,
  type DeploymentEnvironmentTabV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import {
  createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptHeaderV1,
  createDeploymentSecretVariableBindingV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { act, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { renderAccountScreen as renderScreen } from '@/dev/testkit/render/renderAccountScreen';
import type { DeploymentReadLogs } from './useDeploymentStepLog';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

// The log viewport's recycler depends on native layout; render its rows deterministically at that boundary.
vi.mock('@legendapp/list/react-native', async () =>
    (await import('@/dev/testkit/mocks/legendList')).createLegendListModuleMock({ renderItems: true }));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
// Test Renderer keeps the real menus while substituting browser portal and focus primitives.
vi.mock('@/utils/web/reactDomCjs', async () =>
  (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());
vi.mock('@/utils/web/radixCjs', async () =>
  (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);
const device = vi.hoisted(() => ({ current: null as 'phone' | 'tablet' | null }));
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
  return { ...actual, useDeviceType: () => device.current ?? actual.useDeviceType() };
});
afterEach(() => { device.current = null; });
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ renderCustomModals: true }).module;
});
afterEach(() => { routerMock.resetParams(); routerMock.spies.setParams.mockClear(); });
afterEach(async () => {
  const { Modal } = await import('@/modal');
  await act(async () => { Modal.hideAll(); });
  await standardCleanup();
});

// Navigation now uses the real mounted Action front door and its captured Home binding.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const contributedFailureRead = vi.hoisted(() => ({ answer: null as (() => Promise<ActionExecuteResult>) | null }));
// Adapt Metro's synchronous loading boundary; the Action executor remains real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  const { createTriageFailureFrontDoorForTest } = await import('@/dev/testkit/harness/triageFailureActionBoundary');
  const adapted = { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
  return { ...original, createFrontDoorActionExecute: createTriageFailureFrontDoorForTest(adapted, {
    invoke: request => request.action.localId === 'actions/read-v1' && contributedFailureRead.answer
      ? contributedFailureRead.answer()
      : adapted.createFrontDoorActionExecute()('action.invoke', { action: request.action, input: request.input }, request.context),
  }) };
});

const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
const { ProjectDeploymentsView } = await import('./ProjectDeploymentsBody');
const { DeploymentEnvironmentDetail } =
  await import('./DeploymentEnvironmentDetail');
const { DeploymentReceiptDetail } = await import('./DeploymentReceiptDetail');
const { DeployOutcomeBanner } = await import('./DeploymentEnvironmentDetail');
const { useDeploymentChangePress } = await import('./deploymentActionOutcome');
const { SectionActionButton } = await import('@/components/ui/lists/SectionActionButton');
const { HappyError } = await import('@/utils/errors/errors');

it('lets a refused backup press request a fresh review from its failure banner', async () => {
  let attempts = 0;
  const reviews: string[] = [];
  const review = { pendingId: 'fresh-backup-review', open() {}, request: (id: string) => { reviews.push(id); } };
  const settled = () => {};
  // The caller's Action boundary settles stale first, then returns a newly minted review.
  const run = async () => {
    attempts += 1;
    if (attempts === 1) return { ok: false as const, error: 'approval_stale' };
    throw new HappyError('approval_request_created', false, { code: 'approval_request_created', details: {
      kind: 'approval_request_created', artifactId: 'fresh-backup-review', actionId: 'deployments.backups.run',
    } });
  };
  function BackupRecovery() {
    const change = useDeploymentChangePress(review, settled);
    return <>
      <SectionActionButton testID="backup.run" title="Back up now" destination onPress={() => change.press(run)} />
      {change.outcome ? <DeployOutcomeBanner controller={change.banner}
        machine="Backup machine" copy="setting" /> : null}
    </>;
  }
  const screen = await renderScreen(<BackupRecovery />);
  await screen.pressByTestIdAsync('backup.run');
  expect(attempts).toBe(1);
  expect(reviews).toEqual([]);
  await screen.pressByTestIdAsync('project-deployments.outcome.refused.other.action');
  expect(attempts).toBe(2);
  expect(reviews).toEqual(['fresh-backup-review']);
  expect(screen.findByTestId('project-deployments.outcome.approval')).not.toBeNull();
});

async function waitForContent(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
  await waitForHomeGovernance(async () => {
    await act(async () => {});
    const visibleIds = [...new Set(screen.root.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string')
      .map(node => node.props.testID))];
    expect(screen.findByTestId(testID), visibleIds.join(', ')).not.toBeNull();
  });
}
async function selectEnvironmentTab(screen: Awaited<ReturnType<typeof renderScreen>>, tab: DeploymentEnvironmentTabV1) {
  await act(async () => {});
  const testID = `project-deployments.environment.tab:${tab}`;
  await screen.pressByTestIdAsync(testID);
  await waitForHomeGovernance(async () => {
    await act(async () => {});
    expect(screen.findHostByTestId(testID)?.props.accessibilityState?.selected).toBe(true);
  });
}

const scope = {
  serverId: 'home',
  accountId: 'account-owner',
  projectSourceId: 'source-app',
};
// The HTTP fixtures belong to the same Home as the real captured Action credential.
function environmentHeaderForHome(overrides: Parameters<typeof createDeploymentEnvironmentHeaderV1>[0] = {}) {
  return createDeploymentEnvironmentHeaderV1({ ...overrides, serverId: scope.serverId });
}
function environmentDetailForHome(overrides: Parameters<typeof createDeploymentEnvironmentDetailV1>[0] = {}) {
  const detail = createDeploymentEnvironmentDetailV1(overrides);
  return { ...detail, environment: environmentHeaderForHome(detail.environment) };
}
type TeardownControllerBoundary = Extract<Parameters<typeof import('@/dev/testkit/harness/externalActionAccountHttpBoundary').createExternalActionAccountHttpBoundary>[0],
  { requesterInvocation?: 'required' }>;

/** Home's HTTP boundary keeps requester custody, authorization and crypto real. */
async function answerTeardownController(machineId: string, execute: TeardownControllerBoundary['execute'],
  failure?: TeardownControllerBoundary['failure']) {
  const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
  return answerExternalActionAccountForHome(homes, scope.serverId, { machineId, actionId: 'deployments.teardown',
    tokenEpoch: 0, requesterInvocation: 'required', ...(failure ? { failure } : {}), execute });
}

const shown = { mounted: true, visible: true, focused: true };

it.each([{ phone: false, receiptPage: false, stored: false }, { phone: true, receiptPage: false, stored: false },
  { phone: false, receiptPage: true, stored: false }, { phone: true, receiptPage: true, stored: false },
  { phone: true, receiptPage: true, stored: true }])(
  'shows the exact latest pending deployment and its operation with %o', async ({ phone, receiptPage, stored }) => {
  const { DeploymentPendingDeployIntentV1Schema } = await import('@happier-dev/protocol/deployments/storedAppInputV1');
  const { deriveAutomationManualOccurrenceKeyV1 } = await import('@happier-dev/protocol/automations/automationOccurrenceV1');
  const { Modal } = await import('@/modal');
  const base = environmentDetailForHome();
  const intent = DeploymentPendingDeployIntentV1Schema.parse({ sourceIntent: stored
    ? { kind: 'stored', contentRevision: 7, composeDigest: `sha256:${'b'.repeat(64)}`,
        document: 'services: { web: { image: nginx } }', profiles: [], services: ['web'] }
    : { kind: 'repository', projectSourceId: base.environment.projectSourceId, sourceRevision: 1, sha: 'b'.repeat(40) },
    requestKey: 'latest-request', targetLinkId: base.environment.runtimeTargetLinkId, actionOperationId: 'latest-operation',
    ...(stored ? {} : { triggerOccurrence: { automationId: 'push-automation', triggerId: 'push', triggerRevision: 1,
      occurrenceKey: deriveAutomationManualOccurrenceKeyV1({ automationId: 'push-automation', idempotencyKey: 'latest-push' }) } }) });
  const admission = { requesterAccountId: scope.accountId, serverId: scope.serverId, requestKey: intent.requestKey,
    actionOperationId: intent.actionOperationId, environmentRevision: 1,
    controller: { machineId: base.environment.controllerMachineId, installationId: 'installation-a' } };
  const detail = { ...base, pendingDeployment: { status: 'ready' as const, intent, admission } };
  const receipt = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ state: 'running' }) });
  const { controller } = controllerFor({ detail, receipt });
  const screen = await renderScreen(receiptPage
    ? <DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id} deploymentId={receipt.deployment.id}
        environmentName={detail.content.name} demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={phone}
        rollback={null} cancel={null} deploy={null} readLogs={null} linkPath={null}
        onBack={() => {}} review={noReview} onOpenReceipt={() => {}} />
    : <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={phone} deploy={null}
        review={noReview} onOpenReceipt={() => {}} />);
  try {
    await waitForContent(screen, 'project-deployments.environment.pending');
    const text = screen.getTextContent();
    if (intent.sourceIntent.kind === 'repository') expect(text).toContain(intent.sourceIntent.sha);
    else {
      expect(text).toContain(String(intent.sourceIntent.contentRevision));
      expect(text).toContain(intent.sourceIntent.composeDigest);
    }
    const show = vi.spyOn(Modal, 'show');
    await screen.pressByTestIdAsync('project-deployments.environment.pending');
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ props: { serverId: scope.serverId, operationId: intent.actionOperationId } }));
    show.mockRestore();
  } finally { await act(async () => { controller.retire(); }); }
});
const noReview = { pendingId: null, request: () => {}, open: () => {} };

async function answerDeploymentSource(detail: ReturnType<typeof environmentDetailForHome>, respondAfter?: Promise<void>) {
  const { ProjectSourcesReadOutputV1Schema } = await import('@happier-dev/protocol/projects/sources/projectSourceV1');
  const sourceId = detail.environment.projectSourceId;
  homes.answer(scope.serverId, `GET /v1/projects/sources/${encodeURIComponent(sourceId)}`, {
    respondAfter,
    body: ProjectSourcesReadOutputV1Schema.parse({ ok: true, source: { id: sourceId, revision: 1, name: 'My app', audience: [], createdByAccountId: scope.accountId,
      repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'owner/app' }, protocol: 'https' } }, canManage: true }) });
}

// These neighboring flows start with an existing checkout; only the fresh-deploy cases below need Open.
async function answerExistingDeploymentCheckout(detail: ReturnType<typeof environmentDetailForHome>, respondAfter?: Promise<void>) {
  const { createPlainProjectAccountRowListFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
  const sourceId = detail.environment.projectSourceId;
  await answerDeploymentSource(detail, respondAfter);
  homes.answer(scope.serverId, 'POST /v1/account/project-rows/list', { body: createPlainProjectAccountRowListFixture({
    workspaceRefs: [{ id: 'existing-checkout', serverId: scope.serverId, machineId: detail.environment.controllerMachineId,
      rootPath: '/workspace/app', label: null, createdAtMs: 1, lastOpenedAtMs: null, source: { sourceId, revision: 1 } }],
  }) });
}

it.each(['opened', 'refused', 'declined'] as const)('prepares a fresh first deploy through reviewed Open checkout (%s)', async openResult => {
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
  const { createPlainProjectAccountRowListFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
  const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
  const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
  const { OpenProjectInputV1Schema } = await import('@happier-dev/protocol/projects/openProjectV1');
  const { createDeploymentActions } = await import('./deploymentActions');
  const { Modal, ModalProvider } = await import('@/modal');
  const account = await captureLazyActionAccountContext(scope.serverId);
  const base = environmentDetailForHome();
  const detail = { ...base,
    targetLinks: base.targetLinks.map(row => ({ ...row, targetLink: { ...row.targetLink, state: 'configured' as const, activeDeploymentId: undefined } })) };
  const machineId = detail.environment.controllerMachineId;
  const installationId = detail.targetLinks[0]!.targetLink.members[0]!.installationId;
  await publishMachineInventoryForTest(scope, [createMachineFixture({ id: machineId, installationId, activeAt: Date.now(),
    metadata: { host: 'devbox', platform: 'linux', homeDir: '/home/me', happyHomeDir: '/home/me/.happier', happyCliVersion: '0.0.0' } })]);
  const source = { id: detail.environment.projectSourceId, revision: 1, name: 'My app', audience: [], createdByAccountId: scope.accountId,
    repository: { provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'owner/app' }, protocol: 'https' as const } };
  homes.answer(scope.serverId, 'POST /v1/account/project-rows/list', { body: createPlainProjectAccountRowListFixture() });
  // First deploy reads the current Source from the Home, through the real Source controller.
  homes.answer(scope.serverId, `GET /v1/projects/sources/${source.id}?serverId=${encodeURIComponent(scope.serverId)}`, {
    body: { ok: true, source: { ...source, revision: 2 }, canManage: true } });
  const effects: string[] = [];
  const sourceRevisions: number[] = [];
  const reviewDigest = 'R'.repeat(43);
  await answerExternalActionAccountForHome(homes, scope.serverId, { machineId, installationId, actionId: 'projects.open', tokenEpoch: 0, requesterInvocation: 'optional',
    failure: result => typeof result === 'object' && result !== null && 'reviewRequired' in result
      ? { errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required',
          details: { review: { actionArgs: result.reviewRequired, preview: { summary: `Clone /home/me/src/app on ${machineId}` } }, reviewDigest } } : null,
    execute: (raw, context) => {
      const input = OpenProjectInputV1Schema.parse(raw);
      if (input.source.kind === 'source') sourceRevisions.push(input.source.revision);
      expect(input).toMatchObject({ machineId, source: { kind: 'source', id: source.id },
        materialization: { kind: 'clone', destinationParentPath: '/home/me/src', destinationDirectoryName: 'app' } });
      // The native receiver requires its destination review, exactly as manual Open does.
      if (context.invocation?.presentUserConfirmation?.reviewDigest !== reviewDigest) return { reviewRequired: input };
      effects.push('open');
      return openResult === 'refused' ? { kind: 'refused', code: 'destination_exists', effectAttempted: false } : {
        kind: 'opened', workspace: { serverId: scope.serverId, machineId, workspaceId: 'checkout', rootPath: '/home/me/src/app' },
        directory: '/home/me/src/app', setup: 'approvalRequired' };
    } });
  await answerExternalActionAccountForHome(homes, scope.serverId, { machineId, installationId,
    deploymentSource: { id: source.id, revision: 2 }, actionId: 'deployments.deploy', tokenEpoch: 0,
    execute: () => { effects.push('deploy'); return { ok: true, environmentId: detail.environment.id,
      revision: 1, deploymentId: 'first-deploy', deploymentRevision: 1, state: 'succeeded',
    } satisfies import('@happier-dev/protocol/deployments/deploymentActionsV1').DeploymentReceiptAcceptedResultV1; } });
  homes.answer(scope.serverId, `GET /v1/deployments/environments/${detail.environment.id}`, {
    body: { ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink) } });
  vi.mocked(Modal.confirm).mockResolvedValue(true);
  const { controller } = controllerFor({ detail, history: [] });
  const actions = createDeploymentActions(account.accountLifetime, source.id);
  const openedReceipts: string[] = [];
  try {
    const screen = await renderScreen(<ModalProvider>
      <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
        accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={actions.deploy} review={noReview}
        onOpenReceipt={id => openedReceipts.push(id)} lifetime={account.accountLifetime} />
    </ModalProvider>);
    await waitForContent(screen, 'project-deployments.environment.deploy');
    act(() => { screen.pressByTestId('project-deployments.environment.deploy'); });
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.findByTestId('actions.confirmation-review.decision-approve'), JSON.stringify({ effects,
        outcomes: screen.findAllByType(DeployOutcomeBanner).map(node => node.props.controller?.outcome) })).not.toBeNull();
    });
    expect(sourceRevisions[0]).toBe(2);
    expect(effects).toEqual([]);
    await screen.pressByTestIdAsync(openResult === 'declined' ? 'actions.confirmation-review.decision-reject' : 'actions.confirmation-review.decision-approve');
    await waitForHomeGovernance(() => {
      expect(effects, JSON.stringify(screen.findAllByType(DeployOutcomeBanner).map(node => node.props.controller?.outcome)))
        .toEqual(openResult === 'opened' ? ['open', 'deploy'] : openResult === 'declined' ? [] : ['open']);
      if (openResult === 'opened') expect(openedReceipts).toEqual(['first-deploy']);
      else expect(screen.findByTestId('project-deployments.outcome.refused.other')).not.toBeNull();
    });
  } finally { account.dispose(); await act(async () => { controller.retire(); }); }
});

it.each(['update_available', 'removed_from_source', 'unchecked'] as const)(
  'opens the owning review or source repair from the Environment catalog notice (%s)', async state => {
    await homes.switchAccount(scope.serverId, scope.accountId, { currentAccount: true });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
    const { createPromptLibraryCatalogBoundary } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    const { storage } = await import('@/sync/domains/state/storage');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { BUILT_IN_REGISTRY_SOURCES_V1, checkRegistryAppUpdatesV1, REGISTRY_ACTION_INPUT_SCHEMAS_V1 } = await import('@happier-dev/protocol/registries');
    const { createUiRegistryHttpV1 } = await import('@/registries/registryHttpV1');
    const { ModalProvider } = await import('@/modal');
    const source = { id: `catalog-${state}`, title: 'Application source', format: 'happier-catalog' as const,
      kinds: ['app' as const], url: `https://catalog-${state}.test/apps.json`, enabled: true, addedAt: 1 };
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: { v: 2,
      sources: [source], disabledSourceIds: BUILT_IN_REGISTRY_SOURCES_V1.map(row => row.id) } }] });
    for (const path of ['/v1/account/entity-rows/prompt-library', '/v1/account/entity-rows/prompt-library/registry-sources'])
      homes.answer(scope.serverId, path, { body: await (await catalog.handle(path))!.json() });
    const base = environmentDetailForHome();
    const definition = { kind: 'stored' as const, document: 'services:\n  app:\n    image: nginx:1\n',
      contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app'] };
    const detail = environmentDetailForHome({ content: {
      ...base.content, definition, template: { templateRef: { sourceId: source.id, itemId: 'app', version: '1',
        ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
        definition: { kind: 'stored', contentRevision: definition.contentRevision, composeDigest: definition.composeDigest }, services: ['app'] },
    } });
    const member = detail.targetLinks[0]!.targetLink.members[0]!;
    detail.environment.controllerMachineId = member.machineId;
    const upstreamHttp = createUiRegistryHttpV1(async () => state === 'unchecked' ? new Response(null, { status: 401 })
      : Response.json({ schemaVersion: 1, apps: state === 'removed_from_source' ? [] : [{ itemId: 'app', app: {
        schemaVersion: 1, title: 'App', compose: { document: 'services:\n  app:\n    image: nginx:2\n', profiles: [], services: ['app'] },
        variables: [], generatedSecrets: [], domains: [], volumes: [],
      } }] }));
    const observedChecks: string[] = [];
    const boundaryTrace: string[] = [];
    const boundary = await answerExternalActionAccountForHome(homes, scope.serverId, { actionId: 'registries.updates.check',
      machineId: member.machineId, installationId: member.installationId, tokenEpoch: 0, requesterInvocation: 'none', execute: async raw => {
        const input = REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.updates.check'].parse(raw);
        if (input.kind !== 'app') throw new Error('Expected app update demand');
        // The remote host is the process boundary; its real finite registry checker decides the observation.
        const checked = await checkRegistryAppUpdatesV1({ http: upstreamHttp }, { environments: input.environments,
          readEnvironment: async () => detail, readSources: async () => [{ ...source, origin: { kind: 'user' }, removable: true }] });
        observedChecks.push(...checked.results.map(result => result.upstream.state === 'unchecked'
          ? `${result.upstream.state}:${result.upstream.reason.state}` : result.upstream.state));
        return checked;
      } });
    const handle = boundary.handle.bind(boundary);
    boundary.handle = async (url, init) => {
      const request = `${init?.method ?? 'GET'} ${url.pathname}`;
      try {
        const response = await handle(url, init);
        boundaryTrace.push(`${request}:${response?.status ?? 'unhandled'}`);
        return response;
      } catch (error) {
        const issues = error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)
          ? error.issues.map(issue => issue && typeof issue === 'object'
            ? { code: 'code' in issue ? issue.code : null, path: 'path' in issue ? issue.path : null } : null) : [];
        boundaryTrace.push(`${request}:${error instanceof Error ? error.name : 'unknown'}:${JSON.stringify(issues)}`);
        throw error;
      }
    };
    const account = await captureLazyActionAccountContext(scope.serverId);
    storage.setState({ settingsScope: account.accountLifetime.scope, profileScope: account.accountLifetime.scope });
    storage.getState().activateProfileScope(account.accountLifetime.scope);
    await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({ id: member.machineId,
      installationId: member.installationId, activeAt: Date.now() })]);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const { controller } = controllerFor({ detail });
    const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller}
      environmentId={detail.environment.id} demand={shown} accountId={scope.accountId} serverId={scope.serverId}
      phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} lifetime={account.accountLifetime} /></ModalProvider>);
    try {
      const banner = 'project-deployments.environment.attention.catalogUpdate';
      await waitForHomeGovernance(() => expect(observedChecks, JSON.stringify({ boundaryTrace,
        requests: [...new Set(homes.requests.map(request => `${request.method} ${request.path.split('?')[0]}`))] }))
        .toContain(state === 'unchecked' ? 'unchecked:auth_failed' : state));
      await waitForContent(screen, `${banner}.action`);
      await screen.pressByTestIdAsync(`${banner}.action`);
      await waitForContent(screen, state === 'update_available' ? 'project-deployments.add.review' : 'project-deployments.template.sources.view');
      expect(homes.artifacts(scope.serverId).list()).toEqual([]);
    } finally { await screen.unmount(); controller.retire(); account.dispose(); }
  },
);

// Deploy from CI closes the Overview (pfc-redesign r4 dEnvOv KEEP, owner-approved 11-13).
it.each(['repository', 'stored'] as const)('opens CI token setup only for a %s Environment', async kind => {
  const { ModalProvider } = await import('@/modal');
  const base = environmentDetailForHome();
  const detail = environmentDetailForHome({ content: { ...base.content,
    definition: kind === 'repository' ? { kind, ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: ['app'] } }
      : { kind, document: 'services: {app: {image: nginx:1}}', composeDigest: `sha256:${'a'.repeat(64)}`,
        contentRevision: 1, profiles: [], services: ['app'] },
  } });
  const { controller } = controllerFor({ detail });
  const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
  try {
    const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
      demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
      review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} /></ModalProvider>);
    await waitForContent(screen, 'project-deployments.environment.services');
    if (kind === 'stored') {
      expect(screen.findByTestId('project-deployments.environment.ci')).toBeNull();
    } else {
      expect(screen.findByTestId('project-deployments.environment.ci')).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.environment.ci');
      expect(screen.findByTestId('project-deployments.environment.ci.sheet')).not.toBeNull();
    }
  } finally { await act(async () => { controller.retire(); }); }
});

it('keeps a hyphenated Machine name whole inside the What runs sentence (QA-DEPLOY #37)', async () => {
  const { createMachineFixture, createMachineMetadataFixture } = await import('@/dev/testkit');
  const { keepNamesWhole } = await import('@/utils/text/keepNamesWhole');
  const { storage } = await import('@/sync/domains/state/storage');
  const detail = environmentDetailForHome();
  // The fixture's runtime, build and controller Machine are one Machine.
  const machineIds = [detail.environment.controllerMachineId];
  const { controller } = controllerFor({ detail });
  storage.setState({ profileScope: { serverId: scope.serverId, accountId: scope.accountId } });
  storage.getState().applyMachines(machineIds.map(id => createMachineFixture({ id, installationId: `${id}-install`,
    metadata: createMachineMetadataFixture({ host: 'NLDW4-5-40-40' }) })), true,
  { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
  const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
    demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone deploy={null}
    review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} />);
  try {
    await waitForContent(screen, 'project-deployments.environment.services');
    const section = screen.root.findAll(node => node.props.testID === 'project-deployments.environment.services'
      && typeof node.props.description === 'string')[0];
    const description = String(section?.props.description ?? '');
    expect(description).toContain('NLDW4');
    // The sentence wraps between words at 320, never inside the name; the header fact keeps the name as stored.
    expect(description).toContain(keepNamesWhole('NLDW4-5-40-40'));
    expect(description).not.toContain('NLDW4-5-40-40');
  } finally { await screen.unmount(); await act(async () => { controller.retire(); }); }
});

it('shows the declared login username and first-admin warning; the serving images stay on the receipt (PAGE-ACCEPT-176 D6)', async () => {
  const base = environmentDetailForHome();
  const detail = environmentDetailForHome({ content: { ...base.content,
    template: { templateRef: { sourceId: 'catalog', itemId: 'app', version: '1',
      ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, services: ['app'],
      firstRunSetup: true, loginFields: { username: 'APP_USER', password: 'APP_PASSWORD' } },
    bindings: [{ purpose: 'variable', name: 'APP_USER', phase: 'runtime', source: { kind: 'value', value: 'owner' } }],
  } });
  const receipt = createDeploymentReceiptDetailV1();
  const { controller } = controllerFor({ detail, receipt });
  const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
  try {
    const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
      demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
      review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} />);
    await waitForContent(screen, 'project-deployments.environment.services');
    const username = screen.findHostByTestId('project-deployments.environment.services.login.username');
    expect(username).not.toBeNull();
    expect(screen.getTextContent()).toContain('owner');
    expect(screen.findByTestId('project-deployments.environment.services.firstRun')).not.toBeNull();
    expect(screen.findHostByTestId('project-deployments.environment.services.image:app')).toBeNull();
    expect(screen.getTextContent()).not.toContain(`sha256:${'b'.repeat(64)}`);
    // No admitted address means no speculative external link; the existing Domains tab is the remedy.
    await screen.pressByTestIdAsync('project-deployments.environment.services.firstRun.domains');
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.findHostByTestId('project-deployments.environment.tab:domains')?.props.accessibilityState?.selected).toBe(true);
    });
  } finally { await act(async () => { controller.retire(); }); }
});

beforeEach(async () => {
  installHomeGovernanceBoundaries(homes);
  scope.serverId = await homes.addHome({ name: 'Environment navigation', serverUrl: 'https://environment-navigation.test',
    accountId: scope.accountId, serverIdentityId: 'srv_environment_navigation', currentAccount: true });
  const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
  const resolution = await resolveServerCredentialAccountScope(scope.serverId);
  if (resolution.kind !== 'bound') throw new Error('Expected the Environment Account scope');
  scope.serverId = resolution.scope.serverId;
});

it.each(['current', 'predecessor-only', 'unlinked'] as const)('uses only an attached Domain for the admin address (%s)', async selection => {
  const base = environmentDetailForHome();
  const detail = { ...base, environment: { ...base.environment,
    runtimeTargetLinkId: selection === 'unlinked' ? undefined : base.environment.runtimeTargetLinkId },
    content: { ...base.content, template: { templateRef: { sourceId: 'catalog', itemId: 'app', version: '1',
      ref: { kind: 'content' as const, digest: `sha256:${'a'.repeat(64)}` } },
      definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
      services: ['app'], firstRunSetup: true } } };
  const address = (id: string, targetLinkId: string, hostname: string) => ({
    domain: { v: 1 as const, id, environmentId: detail.environment.id, targetLinkId, revision: 1, state: 'active' as const,
      contentArtifactId: `content-${id}`, contentHeaderVersion: 1, contentBodyVersion: 1,
      createdByAccountId: scope.accountId, createdAtMs: 1, updatedAtMs: 1 },
    title: hostname, content: { hostname, target: { service: 'app', containerPort: 3000 } },
  });
  const items = [address('previous', 'previous-link', 'previous.example.test'),
    ...(selection === 'current' ? [address('current', base.environment.runtimeTargetLinkId!, 'current.example.test')] : [])];
  const { controller } = controllerFor({ detail, listDomains: async () => ({ ok: true, value: { items, nextCursor: null } }) });
  const observedDomains = controller.acquireDomains(detail.environment.id, {}, { mounted: false, visible: false, focused: false });
  const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
  const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
    demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
    review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} />);
  try {
    const { DeploymentAdminLogin } = await import('./DeploymentAdminLogin');
    await waitForHomeGovernance(() => {
      expect(observedDomains.getSnapshot().status).toBe('ready');
      expect(screen.findAllByType(DeploymentAdminLogin)[0]?.props.servingUrl ?? null)
        .toBe(selection === 'current' ? 'https://current.example.test/' : null);
    });
    expect(screen.findByTestId('project-deployments.environment.services.firstRun.open') !== null).toBe(selection === 'current');
  } finally { await screen.unmount(); observedDomains.release(); controller.retire(); }
});

/** The network boundary only; the shared controller, projections and page composition run for real. */
function controllerFor(
  input: Readonly<{
    detail?: ReturnType<typeof createDeploymentEnvironmentDetailV1>;
    receipt?: ReturnType<typeof createDeploymentReceiptDetailV1>;
    history?: readonly ReturnType<typeof createDeploymentReceiptDetailV1>[];
    destinations?: readonly ReturnType<typeof createDeploymentEnvironmentHeaderV1>[];
    onListEnvironments?: () => void;
    listEnvironments?: DeploymentReadTransportV1['listEnvironments'];
    listDomains?: DeploymentReadTransportV1['listDomains'];
  }>,
) {
  const detail = input.detail ?? environmentDetailForHome();
  const receipt = input.receipt ?? createDeploymentReceiptDetailV1();
  const retained = input.history ?? [receipt];
  const servingId = detail.targetLinks.find(row => row.targetLink.id === detail.environment.runtimeTargetLinkId)?.targetLink.activeDeploymentId;
  const servingBase = createDeploymentReceiptDetailV1();
  if (servingBase.content.sourceIntent.kind !== 'repository') throw new Error('Expected repository fixture');
  const servingIntent = { ...servingBase.content.sourceIntent, sha: 'f'.repeat(40) };
  const serving = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: servingId ?? 'not-serving' }),
    content: { ...servingBase.content, sourceIntent: servingIntent, ownServer: { approvedInputBasis: {
      v: 1, environmentId: detail.environment.id, environmentRevision: detail.environment.revision,
      targetLinkId: servingBase.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent: servingIntent,
      manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1',
      services: ['app'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
      bindings: [], images: servingBase.content.images,
    } } } });
  const transport: DeploymentReadTransportV1 = {
    listDomains: input.listDomains ?? (async () => ({ ok: true, value: { items: [], nextCursor: null } })),
    listEnvironments: input.listEnvironments ?? (async () => { input.onListEnvironments?.(); return ({
      ok: true,
      value: {
        items: [
          { environment: detail.environment, title: detail.content.name },
          ...(input.destinations ?? []).map(environment => ({ environment, title: environment.id })),
        ],
        nextCursor: null,
      },
    }); }),
    readEnvironment: async () => ({ ok: true, value: detail }),
    listHistory: async () => ({
      ok: true,
      value: { ok: true, items: [...retained, ...(servingId && !retained.some(row => row.deployment.id === servingId) ? [serving] : [])]
        .map(row => {
          // The real transport's per-row projection: revision title, source, the recorded failure and captured actor.
          const entry = projectDeploymentReceiptHistoryEntryV1(row);
          return { ...row.deployment, source: entry.source, failure: entry.failure, actor: entry.actor,
            ...(entry.historyTitle ? { title: entry.historyTitle } : {}) };
        }), nextCursor: null },
    }),
    readReceipt: async (_scope, _environmentId, id) => ({ ok: true,
      value: retained.find(row => row.deployment.id === id) ?? (id === receipt.deployment.id ? receipt : serving) }),
  };
  return {
    controller: createDeploymentReadControllerV1({ scope, transport }),
    detail,
    receipt,
  };
}

describe('A removed Environment (PAGE-ACCEPT-100 D17)', () => {
  it('says it is gone instead of drawing a live page', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, environment: { ...base.environment, deletedAtMs: 1_700_000_000_000 } };
    const { controller } = controllerFor({ detail });
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={{ mounted: true, visible: true, focused: true }} accountId={scope.accountId} serverId={scope.serverId}
        phone={false} deploy={null} review={{ pendingId: null, request: () => {}, open: () => {} }} onOpenReceipt={() => {}} />,
    );
    try {
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.environment.removed'),
        (node) => node !== null);
      expect(screen.findByTestId('project-deployments.environment.serving.none')).toBeNull();
      expect(screen.findByTestId('project-deployments.environment.data')).toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Project deployments page', () => {
  it.each([
    { phone: false, stored: false, ready: false }, { phone: true, stored: false, ready: false },
    { phone: false, stored: true, ready: false }, { phone: true, stored: true, ready: false },
    // Once Deploy leads, the Environment's agent actions are a titled section of their own, never a bare control (QA-DEPLOY #36).
    { phone: false, stored: false, ready: true }, { phone: true, stored: false, ready: true },
  ])('shows the Environment catalog action with a serving deployment (phone=$phone, stored=$stored, ready=$ready)', async ({ phone, stored, ready }) => {
    const { createDeferred } = await import('@/dev/testkit');
    const catalogAnswer = createDeferred<void>();
    const { configureConnectedServerSocketBoundary, restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { answerSourceDeclaredAccountPluginForHome, prepareSourceDeclaredAccountPluginsForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
    const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
    const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
    const { TRIAGE_PLUGIN } = await import('../../../../../../packages/plugins/triage/src/definition');
    const { createTestkitAccountKv } = await import('../../../../../../packages/plugins/triage/src/settings/testkit/accountKv.test-support');
    const { administerTriageAction, createTriageReadActionsActionHandler } = await import('../../../../../../packages/plugins/triage/src/actions/actionsCatalog');
    const { TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, TriageReadActionsActionInputV1Schema } = await import('../../../../../../packages/plugins/triage/src/actions/actionsCatalogProtocol');
    const { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } = await import('../../../../../../packages/plugins/triage/src/settings/actions');
    const serverIdentityId = 'srv_environment_navigation';
    const catalog = createTestkitAccountKv();
    const created = await administerTriageAction({ v: 1, kind: 'create', expectedRevision: 'absent',
      label: 'Set it up', enabled: true, appliesTo: ['deploymentEnvironment'], profileId: null,
      workspaceMode: 'repository', target: { kind: 'agent', promptInvocationId: 'environment-setup', delivery: 'compose' } },
    { catalog: catalog.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'environment.set-up' });
    expect(created.status).toBe('applied');
    answerSourceDeclaredAccountPluginForHome(homes, scope.serverId, TRIAGE_PLUGIN.manifest.id);
    const installTriage = await prepareSourceDeclaredAccountPluginsForTest([{ manifest: TRIAGE_PLUGIN.manifest,
      activate: TRIAGE_PLUGIN.activateAccount, packageName: '@happier-dev/plugins-triage' }]);
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://environment-navigation.test', serverIdentityId,
      accountId: scope.accountId, credentials: { token: createAccountTokenForTests(scope.accountId, { currentAccount: true }) },
      configureSocket: configureConnectedServerSocketBoundary, request: homes.request });
    let installed: Awaited<ReturnType<typeof installTriage>> | undefined;
    let controller: ReturnType<typeof controllerFor>['controller'] | undefined;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      const lifetime = captureActiveServerAccountScopeLifetime();
      if (!lifetime) throw new Error('Expected the Environment Account lifetime');
      installed = await installTriage({ accountLifetime: lifetime, publishProjection: true });
      const base = environmentDetailForHome();
      const detail = stored ? environmentDetailForHome({ content: { ...base.content, definition: {
        kind: 'stored', document: 'services:\n  app:\n    image: app:tested\n', contentRevision: 1,
        composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app'],
      } } }) : base;
      expect(detail.targetLinks.some(row => row.targetLink.activeDeploymentId)).toBe(true);
      await answerExternalActionAccountForHome(homes, scope.serverId, {
        machineId: detail.environment.controllerMachineId, actionId: 'action.invoke', tokenEpoch: 0,
        requesterInvocation: 'required', execute: async (input, request) => {
          await catalogAnswer.promise;
          const invocation = getActionSpec('action.invoke').inputSchema.parse(input);
          expect(invocation.action).toEqual({ pluginId: TRIAGE_PLUGIN.manifest.id, localId: TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1 });
          // The external controller HTTP, Account KV and admitted host-contribution services are boundaries;
          // Triage's real catalog producer/reader and the browser's admission, placement and full page stay real.
          const context = { signal: request.signal ?? new AbortController().signal,
            services: { storage: { account: { kv: catalog.kv } }, targetedContributions: {
              observeForSelf: () => ({ readCurrent: async () => ({ contributions: [] }), dispose: () => {} }),
            } } } as unknown as Parameters<ReturnType<typeof createTriageReadActionsActionHandler>>[1];
          return createTriageReadActionsActionHandler()(TriageReadActionsActionInputV1Schema.parse(invocation.input), context);
        },
      });
      ({ controller } = controllerFor({ detail }));
      screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={phone}
        deploy={ready ? vi.fn(async () => { throw new Error('Deploy is not invoked by this presentation test'); }) : null}
        review={noReview} onOpenReceipt={() => {}} />);
      const { AgentActionButton } = await import('@happier-dev/plugin-ui/components');
      await waitForHomeGovernance(() => {
        expect(screen!.findByTestId('investigation.agentActions.loading-action')).not.toBeNull();
        expect(screen!.findAllByType(AgentActionButton)).toHaveLength(0);
      });
      await act(async () => catalogAnswer.resolve());
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(screen!.findAllByType(AgentActionButton).map(button => ({ title: button.props.title,
          launchMode: button.props.launchMode, startUnavailableReason: button.props.startUnavailableReason,
          disabled: button.props.disabled === true })))
          .toContainEqual({ title: 'Set it up', launchMode: 'review', startUnavailableReason: undefined, disabled: false });
        expect(screen!.root.findAll(node => typeof node.type === 'string' && node.props.role === 'button'
          && node.props.accessibilityLabel === 'Set it up').length).toBeGreaterThan(0);
      });
      const sections = screen.root.findAll(node => node.props.testID === 'project-deployments.environment.agentActions'
        && typeof node.props.title === 'string');
      if (ready) {
        expect(sections).toHaveLength(1);
        expect(sections[0]!.props.description).toEqual(expect.any(String));
        expect(sections[0]!.findAllByType(AgentActionButton).map(button => button.props.title)).toContain('Set it up');
      } else {
        expect(sections).toHaveLength(0);
      }
    } finally {
      catalogAnswer.resolve();
      await screen?.unmount();
      await act(async () => { controller?.retire(); });
      await installed?.dispose();
      await connection.dispose();
    }
  });

  it('draws no setup control and opens no prompt-only authoring until the person has a record for Environments', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, content: { ...base.content, definition: { kind: 'repository' as const, ref: 'main' } },
      targetLinks: base.targetLinks.map(row => ({ ...row, targetLink: { ...row.targetLink, activeDeploymentId: undefined } })) };
    const { controller } = controllerFor({ detail });
    try {
      // Setup runs only through a configured record ("Set it up", declared by its subject owner) and
      // sessions/run-configured-v1; this Home's catalog has none, so nothing stands in for it.
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        review={noReview} onOpenReceipt={() => {}} />);
      await waitForContent(screen, 'project-deployments.environment.menu');
      const { AgentActionButton } = await import('@happier-dev/plugin-ui/components');
      const { InvestigationAgentActionButtons } = await import('@/components/inbox/detail/InvestigationAgentActionButtons');
      await waitForHomeGovernance(async () => {
        expect(screen.findAllByType(InvestigationAgentActionButtons).every(node => !node.props.pending)).toBe(true);
        expect(screen.findAllByType(AgentActionButton)).toHaveLength(0);
      });
      expect(screen.findByTestId('project-deployments.environment.prepare')).toBeNull();
      await screen.unmount();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('does not offer missing-compose preparation when the Environment already declares compose', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, targetLinks: base.targetLinks.map(row => ({ ...row,
      targetLink: { ...row.targetLink, activeDeploymentId: undefined } })) };
    const { controller } = controllerFor({ detail });
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        review={noReview} onOpenReceipt={() => {}} />);
      await waitForContent(screen, 'project-deployments.environment.menu');
      expect(screen.findByTestId('project-deployments.environment.prepare')).toBeNull();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it.each(['explicit primary', 'wizard repository', 'wizard multiple services', 'wizard missing services', 'stored definition'] as const)('offers Move only for a supported serving source and requires an explicit stateless choice (%s)', async origin => {
    const { ModalProvider } = await import('@/modal');
    const { storage } = await import('@/sync/domains/state/storage');
    const { createMachineFixture } = await import('@/dev/testkit');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const { Switch } = await import('@/components/ui/forms/Switch');
    const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
    const environment = environmentDetailForHome();
    const original = createDeploymentReceiptDetailV1();
    const sourceIntent = { kind: 'repository' as const, projectSourceId: environment.environment.projectSourceId,
      sourceRevision: 1, sha: 'a'.repeat(40), compose: { path: 'compose.yaml', profiles: [], services: [],
        ...(origin === 'explicit primary' ? { primaryService: 'web' } : {}) } };
    const wizardDetail = { ...environment, content: { ...environment.content,
      definition: origin === 'stored definition'
        ? { kind: 'stored' as const, document: 'services: {web: {image: nginx:1}}',
          contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['web'] }
        : { kind: 'repository' as const, ref: 'main', compose: sourceIntent.compose } } };
    const wizardReceipt = createDeploymentReceiptDetailV1({ deployment: { ...original.deployment,
      id: environment.targetLinks[0]!.targetLink.activeDeploymentId! }, content: { ...original.content, sourceIntent,
      ownServer: origin === 'wizard missing services' ? undefined : { approvedInputBasis: { v: 1, environmentId: environment.environment.id, environmentRevision: 1,
        targetLinkId: original.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent,
        manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1',
        services: origin === 'wizard multiple services' ? ['web', 'worker'] : ['web'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
        bindings: [], images: original.content.images } } } });
    const { controller, detail } = controllerFor({ detail: wizardDetail, receipt: wizardReceipt });
    storage.setState({ profileScope: { serverId: scope.serverId, accountId: scope.accountId } });
    storage.getState().applyMachines([createMachineFixture({ id: 'destination', installationId: 'destination-install' })], true,
      { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} /></ModalProvider>);
      await waitForContent(screen, 'project-deployments.environment.serving');
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.settings');
      if (origin === 'stored definition' || origin === 'wizard missing services') {
        expect(screen.findByTestId('project-deployments.environment.menu.move')).toBeNull();
        const { readDeploymentMoveEligibility } = await import('./DeploymentMoveSheet');
        expect(readDeploymentMoveEligibility(detail, detail.targetLinks[0]!.targetLink, wizardReceipt, lifetime))
          .toEqual({ kind: 'unavailable', reason: origin === 'stored definition' ? 'needsRepository' : 'needsServiceManifest' });
        return;
      }
      await waitForContent(screen, 'project-deployments.environment.menu.move');
      await screen.pressByTestIdAsync('project-deployments.environment.menu.move');
      await waitForContent(screen, 'project-deployments.move');
      const confirm = () => screen!.findAllByType(RoundButton).find(button => button.props.testID === 'project-deployments.move.confirm')!;
      expect(confirm().props.disabled).toBe(true);
      const { SessionMachineField } = await import('@/components/sessions/new/placement/SessionPlacementChips');
      const picker = screen.findAllByType(SessionMachineField).find(field => field.props.testID === 'project-deployments.move.destination')!;
      expect(picker, 'the deployed service set makes a wizard repository movable').toBeDefined();
      await act(async () => { picker.props.onSelectMachine(picker.props.machines.find((machine: { id: string }) => machine.id === 'destination')); });
      expect(confirm().props.disabled).toBe(true);
      const choice = screen.findAllByType(Switch).find(control => control.props.value === false)!;
      await act(async () => { choice.props.onValueChange(true); });
      if (origin === 'wizard multiple services') {
        expect(confirm().props.disabled).toBe(true);
        const service = screen.findAllByType(DropdownMenu).find(menu => menu.props.testID === 'project-deployments.move.service')!;
        expect(service.props.items.map((item: { id: string }) => item.id)).toEqual(['web', 'worker']);
        await act(async () => { service.props.onSelect('worker'); });
      }
      expect(confirm().props.disabled).toBe(false);
      await screen.pressByTestIdAsync('project-deployments.move.cancel');
      expect(screen.findByTestId('project-deployments.move')).toBeNull();
    } finally { await screen?.unmount(); await act(async () => { controller.retire(); }); }
  });

  it.each(['Move', 'Add server', 'Remove server'] as const)('starts %s through the saved Workflow owner and opens the admitted Run with the exact serving source', async operation => {
    const { ModalProvider } = await import('@/modal');
    const { createMachineFixture } = await import('@/dev/testkit');
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const { Switch } = await import('@/components/ui/forms/Switch');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
    const { createWorkflowDefinitionActions, getActionSpec } = await import('@happier-dev/protocol/actions');
    const { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } = await import('@happier-dev/protocol/actions/actionCatalog');
    const { ActionIdSchema } = await import('@happier-dev/protocol/actions/actionIds');
    const { createWorkflowAccountRunActionOwner } = await import('@happier-dev/protocol/actions/executor/workflowRunActions');
    const { createDeploymentMoveWorkflowV1 } = await import('@happier-dev/protocol/workflows/builtins/deploymentMoveV1');
    const { createDeploymentFleetWorkflowV1 } = await import('@happier-dev/protocol/workflows/builtins/deploymentFleetV1');
    const { WorkflowRunStartRequestV1Schema } = await import('@happier-dev/protocol/workflows/actionsV1');
    const { WorkflowRunAdmissionPreparationResultV1Schema, WorkflowRunRecipientCensusResponseV1Schema } = await import('@happier-dev/protocol/workflows/workflowRunKeyV1');
    const { openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } = await import('@happier-dev/protocol/workflows/workflowStoredContentV1');
    const { resolveWorkflowRunDataKeyV1 } = await import('@happier-dev/protocol/workflows/workflowRunDataKeyV1');
    const { createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
    const { resolveAbsolutePath } = await import('@/utils/path/pathUtils');
    const { createWorkflowRunRoute } = await import('@/sync/domains/workflows/workflowRunRoute');
    const base = environmentDetailForHome();
    const { controller, detail } = controllerFor({ detail: { ...base,
      targetLinks: base.targetLinks.map(row => ({ ...row, targetLink: { ...row.targetLink,
        activeDeploymentId: 'serving-move-deployment',
        ...(operation === 'Remove server' ? { machines: [...row.targetLink.machines, 'existing-member'],
          members: [...row.targetLink.members, { machineId: 'existing-member', installationId: 'existing-install', state: 'active' as const }] } : {}),
      } })),
    } });
    const captured = await captureLazyActionAccountContext(scope.serverId);
    const definitions = createWorkflowDefinitionActions({ artifactStore: captured.workflowArtifacts,
      encodeListCursor: captured.encodeArtifactListCursor, assertDefinitionWriteAllowed: () => { throw new Error('Run admission does not rewrite the saved definition'); } });
    const encryption = { kind: 'available' as const, witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null } };
    const census = (runId: unknown) => WorkflowRunRecipientCensusResponseV1Schema.parse({ runId,
      ownerAccountId: scope.accountId, visibleTeamId: null, encryptionMode: 'plain', access: 'owner',
      ownerAccountCurrentness: encryption.witness, dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] });
    const admissions: Readonly<Record<string, unknown>>[] = [];
    const owner = createWorkflowAccountRunActionOwner({ definitions, resolveAccountId: async () => scope.accountId,
      resolveEncryption: async () => encryption, normalizeAbsolutePath: resolveAbsolutePath,
      randomBytes: () => { throw new Error('A plain Account does not require encryption keys'); },
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
        readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))) } }),
      storage: { execute: async operation => {
        if (operation.operation === 'get' && operation.prepareAdmission !== undefined) return WorkflowRunAdmissionPreparationResultV1Schema.parse({ run: null, keyCensus: census(operation.runId) });
        if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        if (operation.operation === 'run-key.census') return census(operation.runId);
        if (operation.operation === 'admit') { admissions.push(operation); return { kind: 'created', run: createWorkflowRunSummaryFixture({
          id: String(operation.runId), ownerAccountId: scope.accountId, machineId: 'machine-a', state: 'queued',
          sourceArtifactId: String(operation.sourceArtifactId), origin: { kind: 'direct' } }) }; }
        throw new Error(`Unexpected Run storage operation: ${operation.operation}`);
      } },
    });
    await answerExternalActionAccountForHome(homes, scope.serverId, { actionId: 'workflow.run.start', machineId: 'machine-a', tokenEpoch: 0,
      execute: input => owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse(input),
        context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default',
          externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } }) });
    await publishMachineInventoryForTest(scope, [
      createMachineFixture({ id: 'machine-a', installationId: 'installation-a', activeAt: Date.now() }),
      createMachineFixture({ id: 'destination', installationId: 'destination-install', activeAt: Date.now() }),
      createMachineFixture({ id: 'existing-member', installationId: 'existing-install', activeAt: Date.now() }),
    ]);
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} /></ModalProvider>);
      await waitForContent(screen, 'project-deployments.environment.menu');
      if (operation === 'Move') {
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.move');
      await screen.pressByTestIdAsync('project-deployments.environment.menu.move');
      await waitForContent(screen, 'project-deployments.move');
      const { SessionMachineField } = await import('@/components/sessions/new/placement/SessionPlacementChips');
      const picker = screen.findAllByType(SessionMachineField).find(field => field.props.testID === 'project-deployments.move.destination')!;
      await act(async () => { picker.props.onSelectMachine(picker.props.machines.find((machine: { id: string }) => machine.id === 'destination')); });
      const choice = screen.findAllByType(Switch).find(control => control.props.value === false)!;
      await act(async () => { choice.props.onValueChange(true); });
      await screen.pressByTestIdAsync('project-deployments.move.confirm');
      } else {
        await screen.pressByTestIdAsync('project-deployments.environment.tab:settings');
        await waitForContent(screen, 'project-deployments.environment.settings.servers-build.manage');
        await screen.pressByTestIdAsync('project-deployments.environment.settings.servers-build.manage');
        await waitForContent(screen, 'project-deployments.fleet');
        if (operation === 'Add server') {
          const { SessionMachineField } = await import('@/components/sessions/new/placement/SessionPlacementChips');
          const destination = screen.findAllByType(SessionMachineField).find(field => field.props.testID === 'project-deployments.fleet.destination')!;
          await act(async () => { destination.props.onSelectMachine(destination.props.machines.find((machine: { id: string }) => machine.id === 'destination')); });
          const ingress = screen.findAllByType(SessionMachineField).find(field => field.props.testID === 'project-deployments.environment.settings.servers-build.ingress')!;
          await act(async () => { ingress.props.defaultChoice.onChoose(); });
        } else await screen.pressByTestIdAsync('project-deployments.fleet.remove.existing-member');
        await screen.pressByTestIdAsync('project-deployments.fleet.confirm');
      }
      await waitForHomeGovernance(() => expect(admissions).toHaveLength(1));
      const admitted = admissions[0]!;
      const runId = String(admitted.runId);
      const key = resolveWorkflowRunDataKeyV1({ encryption, census: census(runId) });
      if (key.kind !== 'available') throw new Error('Admitted Move key is unavailable');
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...key.encryption.runCrypto,
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: scope.accountId, runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(String(admitted.acceptedEnvelope)) });
      expect(opened).toMatchObject({ kind: 'available', content: {
        source: { kind: 'saved', definitionId: admitted.sourceArtifactId },
        authoredDefinition: operation === 'Move' ? createDeploymentMoveWorkflowV1()
          : createDeploymentFleetWorkflowV1(operation === 'Add server' ? 'add' : 'remove', {
            deployCurrentRelease: operation === 'Add server', configureIngress: operation === 'Add server' }),
        inputs: operation === 'Move' ? { noLocalData: true, move: { sourceIntent: { kind: 'repository', sha: 'f'.repeat(40) },
          destinationMachineId: 'destination', destinationInstallationId: 'destination-install' } }
          : { fleet: operation === 'Add server' ? { sourceIntent: { kind: 'repository', sha: 'f'.repeat(40) },
              ingress: { kind: 'cloudflareTunnel' }, machines: [
                { machineId: 'machine-a', installationId: 'installation-a' },
                { machineId: 'destination', installationId: 'destination-install' }] }
            : { removedMachineId: 'existing-member', machines: [{ machineId: 'machine-a', installationId: 'installation-a' }] } },
      } });
      await waitForHomeGovernance(() => expect(routerMock.spies.push).toHaveBeenLastCalledWith(createWorkflowRunRoute(runId, 'srv_environment_navigation')));
      expect(screen.findByTestId('project-deployments.move')).toBeNull();
    } finally { captured.dispose(); await screen?.unmount(); await act(async () => { controller.retire(); }); }
  });

  it('offers Duplicate from the loaded Environment without opening another editor owner', async () => {
    const { ModalProvider } = await import('@/modal');
    const { controller, detail } = controllerFor({});
    let selected: typeof detail | undefined;
    try {
      const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        review={noReview} onOpenReceipt={() => {}} onDuplicate={value => { selected = value; }} /></ModalProvider>);
      await waitForContent(screen, 'project-deployments.environment.menu');
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.duplicate');
      await screen.pressByTestIdAsync('project-deployments.environment.menu.duplicate');
      await waitForHomeGovernance(() => expect(selected).toMatchObject(detail));
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('offers Pin in the Environment page menu (Services column Pinned, owner 2026-11-15 13:34Z)', async () => {
    const { ModalProvider } = await import('@/modal');
    const { controller, detail } = controllerFor({});
    try {
      const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        review={noReview} onOpenReceipt={() => {}} /></ModalProvider>);
      await waitForContent(screen, 'project-deployments.environment.menu');
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.pin');
      const menu = screen.root.findAll((node) => Array.isArray(node.props.items)
        && node.props.items.some((item: { id?: string }) => item.id === 'pin'))[0];
      expect(menu?.props.items[0]).toMatchObject({ id: 'pin', title: 'Pin' });
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('a preview offers Deploy to Production, which opens Deploy an app on its code with this preview for Review (deploy auto-mode U9)', async () => {
    const { ModalProvider } = await import('@/modal');
    const base = environmentDetailForHome();
    for (const purpose of ['preview', 'standard'] as const) {
      const detail = { ...base, environment: environmentHeaderForHome({ ...base.environment, purpose,
        ...(purpose === 'preview' ? { previewTemplateEnvironmentId: 'environment-production',
          previewRepositoryId: base.environment.projectSourceId, previewPullRequestId: 'pr:12',
          previewTargetLinkId: base.environment.runtimeTargetLinkId! } : {}) }) };
      const { controller } = controllerFor({ detail });
      try {
        const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
          demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
          review={noReview} onOpenReceipt={() => {}} /></ModalProvider>);
        await waitForContent(screen, 'project-deployments.environment.menu');
        await screen.pressByTestIdAsync('project-deployments.environment.menu');
        await waitForContent(screen, 'project-deployments.environment.menu.settings');
        if (purpose === 'standard') {
          expect(screen.findByTestId('project-deployments.environment.menu.deployProduction'), 'only a preview offers it').toBeNull();
          continue;
        }
        await screen.pressByTestIdAsync('project-deployments.environment.menu.deployProduction');
        // The one Deploy an app opener (useOpenNewApp → NewAppDialog) carries this preview and its Project's code.
        await waitForHomeGovernance(() => expect(screen.root.findAll((node) => node.props?.previewEnvironmentId === detail.environment.id
          && node.props?.projectSourceId === detail.environment.projectSourceId).length).toBeGreaterThan(0));
      } finally { await act(async () => { controller.retire(); }); }
    }
  });

  it.each(['review', 'refusal', 'receipt', 'retained'] as const)(
    'opens promotion from the native stored receipt and preserves the destination controller’s %s', async response => {
    // Designed confirmation binds the real current Account and stable Home identity.
    const serverIdentityId = `srv_${'8'.repeat(32)}`;
    scope.serverId = await homes.addHome({ name: 'Promotion', serverUrl: 'https://promotion-navigation.test',
      accountId: scope.accountId, currentAccount: true, serverIdentityId });
    const previousPromotionRequests = homes.requestsFor('/v1/actions/deployments.promote').length;
    const promotionInputs: unknown[] = [];
    const { Modal, ModalProvider } = await import('@/modal');
    const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
    const { createDeploymentActions } = await import('./deploymentActions');
    const base = environmentDetailForHome();
    const definition = { kind: 'stored' as const, document: 'services:\n  app:\n    image: app:tested\n',
      contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app'] };
    const detail = environmentDetailForHome({ content: { ...base.content, definition },
      ...(response === 'retained' ? { targetLinks: [] } : {}) });
    const baseReceipt = createDeploymentReceiptDetailV1();
    const sourceReceipt = createDeploymentReceiptDetailV1({ content: { ...baseReceipt.content, sourceIntent: definition } });
    const destination = environmentHeaderForHome({ id: 'production' });
    const viewOnly = environmentHeaderForHome({ id: 'view-only', capabilities: { ...destination.capabilities,
      role: 'reader', deploy: false, manage: false } });
    const list = vi.fn();
    const { controller, receipt } = controllerFor({ detail, receipt: sourceReceipt, destinations: [destination, viewOnly], onListEnvironments: list });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const actions = createDeploymentActions(lifetime, scope.projectSourceId);
    homes.answer(scope.serverId, 'GET /v1/deployments/environments/production', { body: { ok: true,
      environment: destination, targetLinks: [] } });
    await answerExternalActionAccountForHome(homes, scope.serverId, { actionId: 'deployments.promote', machineId: 'machine-a',
      tokenEpoch: 0, deploymentSource: { id: scope.projectSourceId, revision: 1 }, execute: input => {
      promotionInputs.push(input);
      return response === 'review'
        ? { kind: 'approval_request_created', actionId: 'deployments.promote', artifactId: 'promotion-review' }
        : response === 'refusal' ? { ok: false, error: 'deployment_access_denied' }
        : { ok: true, environmentId: 'production', deploymentId: 'promoted-receipt', revision: 2,
            deploymentRevision: 1, state: 'succeeded' };
    } });
    const request = vi.fn();
    const openPromoted = vi.fn();
    const review = { ...noReview, request };
    try {
      const screen = await renderScreen(<ModalProvider><DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id} deploymentId={receipt.deployment.id}
            environmentName="Staging" demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false}
            rollback={null} cancel={null} deploy={null} promote={actions.promote} readLogs={null} linkPath={null}
            onBack={() => {}} review={review} onOpenReceipt={() => {}} onOpenPromotionReceipt={openPromoted} /></ModalProvider>);
      await waitForContent(screen, 'project-deployments.receipt.header');
      expect(list, 'closed promotion loads no destination inventory').not.toHaveBeenCalled();
      await act(async () => { await screen.pressByTestIdAsync('project-deployments.receipt.menu'); });
      await waitForContent(screen, 'project-deployments.receipt.promote');
      await act(async () => { await screen.pressByTestIdAsync('project-deployments.receipt.promote'); });
      await waitForContent(screen, 'project-deployments.promote.destination:production');
      expect(screen.findByTestId(`project-deployments.promote.destination:${detail.environment.id}`)).toBeNull();
      expect(screen.findByTestId('project-deployments.promote.destination:view-only')).toBeNull();
      await act(async () => { await screen.pressByTestIdAsync('project-deployments.promote.destination:production'); });
      expect(screen.findByTestId('project-deployments.promote.artifact:rebuild')).toBeNull();
      expect(screen.findByTestId('project-deployments.promote.destination:production')?.props['aria-checked']).toBe(true);
      await act(async () => { await screen.pressByTestIdAsync('project-deployments.promote.confirm'); });
      const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
      await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/actions/deployments.promote'),
        screen.findAllByType(SurfaceStateCard).map(node => node.props.diagnosticCode).filter(Boolean).join(', ')).toHaveLength(previousPromotionRequests + 1));
      await waitForHomeGovernance(() => expect(promotionInputs).toEqual([{ serverId: serverIdentityId, environmentId: 'production',
        sourceEnvironmentId: detail.environment.id, sourceDeploymentId: receipt.deployment.id, artifact: 'image' }]));
      if (response === 'review') {
        await waitForHomeGovernance(() => expect(request, screen.getTextContent()).toHaveBeenCalledWith('promotion-review'));
        await waitForHomeGovernance(async () => {
          await act(async () => {});
          expect(screen.findByTestId('project-deployments.promote')).toBeNull();
        });
      } else if (response === 'refusal') {
        await waitForContent(screen, 'project-deployments.promote.refused');
        expect(screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'project-deployments.promote.refused')?.props.diagnosticCode)
          .toBe('deployment_access_denied');
        expect(screen.findByTestId('project-deployments.promote.destination:production')?.props['aria-checked']).toBe(true);
        expect(request).not.toHaveBeenCalled();
      } else {
        await waitForHomeGovernance(() => expect(openPromoted).toHaveBeenCalledWith('production', 'promoted-receipt'));
        await waitForHomeGovernance(async () => {
          await act(async () => {});
          expect(screen.findByTestId('project-deployments.promote')).toBeNull();
        });
      }
      expect(homes.requestsFor('/v1/actions/deployments.promote')).toHaveLength(previousPromotionRequests + 1);
    } finally { await act(async () => { Modal.hideAll(); controller.retire(); }); }
  });

  it.each(['repository', 'platform'] as const)('hides promotion for an unsupported %s receipt and platform header', async kind => {
    const previousPromotionRequests = homes.requestsFor('/v1/actions/deployments.promote').length;
    const base = environmentDetailForHome();
    const detail = kind === 'platform' ? environmentDetailForHome({ targetLinks: base.targetLinks.map(row => ({ ...row,
      targetLink: { ...row.targetLink, source: { kind: 'plugin', contribution: { pluginId: 'vercel', localId: 'project' } },
        targetKind: 'vercel', machines: [], members: [] } })) }) : base;
    const baseReceipt = createDeploymentReceiptDetailV1();
    const sourceReceipt = kind === 'platform' ? createDeploymentReceiptDetailV1({ content: {
      sourceIntent: { kind: 'stored', document: 'services:\n  app:\n    image: app:tested\n', contentRevision: 1,
        composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app'] },
      sourceMethod: 'upload', machines: [], images: [], machineResults: [], steps: [],
      platform: { credentialPrincipal: { kind: 'account', accountId: scope.accountId, purpose: {
        consumer: { pluginId: 'happier.deployment-vercel', localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
        target: { kind: 'account', account: { service: { pluginId: 'happier.machine-vercel', localId: 'vercel' }, accountId: 'connected' } } },
        providerIdentity: { providerAccountId: 'team', providerResourceId: 'project', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' }, targetLinkRevision: 1, observation: { v: 1, state: 'queued', observedAtMs: 1000 } },
    } }) : baseReceipt;
    const { controller, receipt } = controllerFor({ detail, receipt: sourceReceipt });
    const { createDeploymentActions } = await import('./deploymentActions');
    const promote = createDeploymentActions({ scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) }, scope.projectSourceId).promote;
    try {
      const screen = await renderScreen(<>
        <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
          accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
          review={noReview} onOpenReceipt={() => {}} />
        <DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id} deploymentId={receipt.deployment.id}
          environmentName="Staging" demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false}
          rollback={null} cancel={null} deploy={null} promote={promote} readLogs={null} linkPath={null}
          onBack={() => {}} review={noReview} onOpenReceipt={() => {}} />
      </>);
      await waitForContent(screen, 'project-deployments.environment.serving.receipt');
      await waitForContent(screen, 'project-deployments.receipt.header');
      await act(async () => { await screen.pressByTestIdAsync('project-deployments.receipt.menu'); });
      await waitForContent(screen, 'project-deployments.receipt.menu.environment');
      expect(screen.findByTestId('project-deployments.receipt.promote')).toBeNull();
      expect(screen.findByTestId('project-deployments.environment.promote')).toBeNull();
      expect(homes.requestsFor('/v1/actions/deployments.promote')).toHaveLength(previousPromotionRequests);
    } finally { await act(async () => { controller.retire(); }); }
  });

  it.each(['history', 'stop'] as const)('keeps Delete open with the running deployment cause and actionable %s remedy', async remedy => {
    const detail = environmentDetailForHome();
    const running = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'running-deploy', state: 'running' }) });
    const { controller } = controllerFor({ detail, receipt: { ...running, cancellable: true } });
    const { ModalProvider } = await import('@/modal');
    const { createDeploymentActions } = await import('./deploymentActions');
    const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const deletionPath = `/v1/deployments/environments/${detail.environment.id}/delete`;
    homes.answer(scope.serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
      ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink),
    } });
    homes.answer(scope.serverId, `POST ${deletionPath}`, { status: 409, body: {
      ok: false, error: 'deployment_in_progress', deploymentId: 'running-deploy', href: '/retained-receipt',
    } });
    const onDeleted = vi.fn();
    const onNavigate = vi.fn();
    const deleteRequestsBefore = homes.requestsFor(deletionPath).length;
    const stopRequestsBefore = homes.requestsFor(`/v1/deployments/environments/${detail.environment.id}/deployments/running-deploy/transitions`).length;
    const actions = createDeploymentActions(lifetime, scope.projectSourceId);
    homes.answer(scope.serverId, `POST /v1/deployments/environments/${detail.environment.id}/deployments/running-deploy/transitions`, { body: {
      ok: true, environmentId: detail.environment.id, revision: detail.environment.revision,
      deploymentId: 'running-deploy', deploymentRevision: 2, state: 'running',
    } });
    try {
      const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller}
        environmentId={detail.environment.id} demand={shown} accountId={scope.accountId} serverId={scope.serverId}
        phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} lifetime={lifetime}
        disposition={actions} cancel={actions.cancel} onNavigate={onNavigate} onDeleted={onDeleted} />
      </ModalProvider>);
      await waitForContent(screen, 'project-deployments.environment.menu');
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.delete');
      await screen.pressByTestIdAsync('project-deployments.environment.menu.delete');
      await waitForContent(screen, 'project-deployments.disposition.confirm');
      await screen.pressByTestIdAsync('project-deployments.disposition.confirm');
      await waitForHomeGovernance(() => {
        expect(screen.findByTestId('project-deployments.disposition.refused')).not.toBeNull();
      });
      expect(screen.getTextContent()).toContain(readDeploymentRefusalRecoveryV1('deployment_in_progress')!.remedy);
      expect(onDeleted).not.toHaveBeenCalled();
      expect(homes.requestsFor(deletionPath)).toHaveLength(deleteRequestsBefore + 1);
      await waitForContent(screen, `project-deployments.disposition.${remedy}`);
      await screen.pressByTestIdAsync(`project-deployments.disposition.${remedy}`);
      if (remedy === 'history') {
        expect(onNavigate).toHaveBeenCalledWith({ tab: 'history', section: null });
        expect(screen.findByTestId('project-deployments.disposition')).toBeNull();
      } else {
        await waitForHomeGovernance(() => expect(homes.requestsFor(`/v1/deployments/environments/${detail.environment.id}/deployments/running-deploy/transitions`)).toHaveLength(stopRequestsBefore + 1));
        expect(homes.requestsFor(`/v1/deployments/environments/${detail.environment.id}/deployments/running-deploy/transitions`).at(-1)?.input)
          .toMatchObject({ kind: 'cancel', deploymentId: 'running-deploy', expectedReceiptRevision: running.deployment.revision });
      }
      expect(homes.requestsFor(deletionPath)).toHaveLength(deleteRequestsBefore + 1);
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('unlinks a platform target without Machine wording and starts on Detach (COR4B ui-44)', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, targetLinks: base.targetLinks.map(item => ({ ...item, targetLink: { ...item.targetLink,
      activeDeploymentId: undefined, source: { kind: 'plugin' as const, contribution: { pluginId: 'vercel', localId: 'project' } },
      targetKind: 'vercel', machines: [], members: [] } })) };
    const { controller } = controllerFor({ detail, history: [] });
    const { ModalProvider } = await import('@/modal');
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const { createDeploymentActions } = await import('./deploymentActions');
    const actions = createDeploymentActions(lifetime, scope.projectSourceId);
    try {
      const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller}
        environmentId={detail.environment.id} demand={shown} accountId={scope.accountId} serverId={scope.serverId}
        phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} disposition={actions} />
      </ModalProvider>);
      await selectEnvironmentTab(screen, 'settings');
      await screen.pressByTestIdAsync('project-deployments.environment.settings.servers-build.unlink');
      await waitForContent(screen, 'project-deployments.disposition.confirm');
      // Happier cannot stop a provider's workload from here: Stop and remove is unavailable, Detach is the start.
      expect(screen.findByTestId('project-deployments.disposition.choice:remove')).toBeNull();
      expect(screen.findByTestId('project-deployments.disposition.choice:detach')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(false);
      // The confirm names the kept choice: Unlink keeps the project running on vercel, nothing is deleted.
      expect(screen.getTextContent()).toMatch(/leave it on vercel/);
      expect(screen.getTextContent()).not.toMatch(/Delete at vercel|Stop and remove/i);
      // The sheet's own sentences (ui-44), not the Settings page behind it.
      expect(screen.getTextContent()).not.toMatch(/recorded on a machine|Unlink a machine|services on a machine|cor4b-prod on a machine/i);
      await screen.pressByTestIdAsync('project-deployments.disposition.cancel');
    } finally { await act(async () => { controller.retire(); }); }
  });

  it.each([
    { origin: 'created' as const, starts: 'remove' },
    { origin: undefined, starts: 'detach' },
  ])('deletes a provider resource only after its name is typed (origin $origin starts on $starts)', async ({ origin, starts }) => {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
    const { createDeploymentTargetsTestPlugin, DEPLOYMENT_TARGETS_TEST_EXECUTION } = await import('./deploymentPlatformTargetPlugin.testFixture');
    const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
    const { createDeploymentActions } = await import('./deploymentActions');
    const { ModalProvider } = await import('@/modal');
    const authored = createDeploymentTargetsTestPlugin('com.example.provider-delete', undefined, { teardown: true });
    scope.serverId = await homes.addHome({ name: 'Provider delete', serverUrl: `https://provider-delete-${origin ?? 'linked'}.test`,
      serverIdentityId: `srv_provider_delete_${origin ?? 'linked'}`, accountId: scope.accountId, currentAccount: true });
    const context = await captureLazyActionAccountContext(scope.serverId);
    const installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
      activate: api => authored.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account),
      accountLifetime: context.accountLifetime, publishProjection: true });
    const base = environmentDetailForHome();
    const detail = { ...base, targetLinks: base.targetLinks.map(row => ({ ...row,
      targetLink: { ...row.targetLink, activeDeploymentId: undefined,
        source: { kind: 'plugin' as const, contribution: { pluginId: authored.manifest.id, localId: 'beta' } },
        targetKind: 'beta', machines: [], members: [] },
      content: { ...(origin ? { providerResourceOrigin: origin } : {}),
        credentialPrincipal: { kind: 'account' as const, accountId: scope.accountId,
          purpose: { consumer: { pluginId: authored.manifest.id, localId: 'inspect-beta' }, purpose: 'beta.manage' },
          target: { kind: 'account' as const, account: { service: { pluginId: 'com.example.cloud', localId: 'cloud-account' }, accountId: 'selected' } } },
        providerIdentity: { providerAccountId: 'cloud', providerResourceId: 'prj_7Hq2', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' as const }, preparedNative: { projectName: 'acme-web' } },
    })) };
    await context.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
      header: { kind: 'deployment-environment.v1', title: detail.content.name }, body: JSON.stringify(detail.content) });
    for (const row of detail.targetLinks) await context.createArtifactDocument({ artifactId: row.targetLink.contentArtifactId,
      header: { kind: 'deployment-target-link.v1', title: 'acme-web' }, body: JSON.stringify(row.content) });
    homes.answer(scope.serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
      environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink) } });
    homes.answer(scope.serverId, `GET /v1/deployments/environments/${detail.environment.id}/deployments`,
      { body: { ok: true, items: [], nextCursor: null } });
    // The Domains the removal retires are a separate Action read; this Environment has none.
    const controller = createDeploymentReadControllerV1({ scope, transport: { ...createDeploymentReadTransport(context.accountLifetime),
      listDomains: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }) } });
    const actions = createDeploymentActions(context.accountLifetime, scope.projectSourceId);
    const teardown = vi.fn(async (_input: Parameters<typeof actions.teardown>[0]) => ({ ok: true as const, environmentId: detail.environment.id,
      revision: detail.environment.revision, deploymentId: 'provider-teardown', deploymentRevision: 1, state: 'queued' as const }));
    const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller}
      environmentId={detail.environment.id} demand={shown} accountId={scope.accountId} serverId={scope.serverId}
      phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} lifetime={context.accountLifetime}
      disposition={{ ...actions, teardown } as never} /></ModalProvider>);
    try {
      // The Account's declarations name the platform once they are read; the review offers Delete from them.
      await vi.waitFor(() => expect(screen.getTextContent()).toContain('Beta runtime'), { timeout: 15_000 });
      await waitForContent(screen, 'project-deployments.environment.menu');
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.delete');
      await screen.pressByTestIdAsync('project-deployments.environment.menu.delete');
      await waitForContent(screen, 'project-deployments.disposition.confirm');
      // The removal owner picks the start: Happier-created resources start on Delete, linked ones on Unlink.
      await vi.waitFor(() => expect(screen.findByTestId(`project-deployments.disposition.choice:${starts}`)
        ?.props.accessibilityState).toMatchObject({ selected: true }));
      expect(screen.getTextContent()).not.toMatch(/a machine/i);
      if (starts === 'detach') {
        expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(false);
        expect(screen.findByTestId('project-deployments.disposition.resourceConfirmation')).toBeNull();
        await screen.pressByTestIdAsync('project-deployments.disposition.choice:remove');
      }
      // Delete names the provider's own consequence and stays disabled until the resource name is typed.
      expect(screen.getTextContent()).toContain('Delete this Beta project and its deployments?');
      expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(true);
      await act(async () => screen.findByTestId('project-deployments.disposition.resourceConfirmation')!.props.onChangeText('acme-we'));
      expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(true);
      await act(async () => screen.findByTestId('project-deployments.disposition.resourceConfirmation')!.props.onChangeText('acme-web'));
      await vi.waitFor(() => expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(false));
      await screen.pressByTestIdAsync('project-deployments.disposition.confirm');
      await vi.waitFor(() => expect(teardown).toHaveBeenCalledTimes(1));
      // Deleting the Environment deletes its provider resource first, then removes the Environment.
      expect(teardown.mock.calls[0]![0]).toMatchObject({ targetLinkId: detail.environment.runtimeTargetLinkId,
        providerRemoval: 'delete', removeEnvironment: true });
    } finally { await screen.unmount(); controller.retire(); await installed.dispose(); }
  });

  it('offers removal when the target has never deployed', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, targetLinks: base.targetLinks.map(item => ({ ...item,
      targetLink: { ...item.targetLink, activeDeploymentId: undefined } })) };
    const { controller } = controllerFor({ detail, history: [] });
    const { ModalProvider } = await import('@/modal');
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const { createDeploymentActions } = await import('./deploymentActions');
    const actions = createDeploymentActions(lifetime, scope.projectSourceId);
    try {
      const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller}
        environmentId={detail.environment.id} demand={shown} accountId={scope.accountId} serverId={scope.serverId}
        phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} disposition={actions} />
      </ModalProvider>);
      await selectEnvironmentTab(screen, 'settings');
      await screen.pressByTestIdAsync('project-deployments.environment.settings.servers-build.unlink');
      // The retained Machine association can still be detached even with no deployed workload.
      expect(screen.findByTestId('project-deployments.disposition.choice:detach')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(false);
      await screen.pressByTestIdAsync('project-deployments.disposition.cancel');
    } finally { await act(async () => { controller.retire(); }); }
  });

  it.each([
    { removed: false, neverDeployed: false, inventoryFailure: null, running: false, fromMenu: false },
    { removed: true, neverDeployed: false, inventoryFailure: null, running: true, fromMenu: false },
    { removed: true, neverDeployed: false, inventoryFailure: null, running: false, fromMenu: false },
    { removed: true, neverDeployed: false, inventoryFailure: null, running: true, fromMenu: true },
    { removed: true, neverDeployed: true, inventoryFailure: null, running: false, fromMenu: false },
    { removed: true, neverDeployed: false, inventoryFailure: 'transport', running: false, fromMenu: false },
    { removed: true, neverDeployed: false, inventoryFailure: 'read', running: false, fromMenu: false },
    { removed: true, neverDeployed: false, inventoryFailure: 'envelope', running: false, fromMenu: false },
    { removed: true, neverDeployed: false, inventoryFailure: 'detach', running: false, fromMenu: false },
  ])('consumes the root Environment-removal result from Stop and remove (removed $removed, never deployed $neverDeployed, inventory failure $inventoryFailure, running $running, menu $fromMenu)', async ({ removed, neverDeployed, inventoryFailure, running, fromMenu }) => {
    const detach = inventoryFailure === 'detach';
    const settingsRemoval = removed && !neverDeployed && !inventoryFailure && running && !fromMenu;
    const homeIdentity = `srv_${'d'.repeat(32)}`;
    scope.serverId = await homes.addHome({ name: 'Idle removal', serverUrl: 'https://idle-removal.test',
      serverIdentityId: homeIdentity, accountId: scope.accountId, currentAccount: true });
    const base = environmentDetailForHome();
    const detail = running ? base : { ...base, targetLinks: base.targetLinks.map(item => ({ ...item,
      targetLink: { ...item.targetLink, activeDeploymentId: undefined } })) };
    let deleted = false;
    let finishRefresh: (() => void) | undefined;
    const { controller } = controllerFor({ detail, ...(neverDeployed ? { history: [] } : {}),
      ...(detach ? { listEnvironments: async (_scope, _query, { signal }) => {
        if (!deleted) return { ok: true as const, value: { items: [{ environment: detail.environment, title: detail.content.name }], nextCursor: null } };
        // Keep the pre-delete rail visible while Home's collection refresh is in flight.
        return new Promise<Awaited<ReturnType<DeploymentReadTransportV1['listEnvironments']>>>(resolve => {
          finishRefresh = () => resolve({ ok: true, value: { items: [], nextCursor: null } });
          signal.addEventListener('abort', () => resolve({ ok: false, failure: { code: 'cancelled', retryable: false } }), { once: true });
        });
      } } : {}) });
    const { ModalProvider } = await import('@/modal');
    const { DeploymentTeardownActionInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
    const { ActionExecuteFailureSchema } = await import('@happier-dev/protocol/actions/actionExecutionResult');
    homes.answer(scope.serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
      ok: true, environment: { ...detail.environment, serverId: homeIdentity },
      targetLinks: detail.targetLinks.map(item => item.targetLink),
    } });
    const deletionPath = `/v1/deployments/environments/${detail.environment.id}/delete`;
    if (detach) await answerDeploymentSource(detail);
    if (neverDeployed || detach) homes.answer(scope.serverId, `POST ${deletionPath}`, { select: body => {
      expect(body).toMatchObject({ environmentId: detail.environment.id,
        expectedRevision: detail.environment.revision,
        ...(detach ? { detachKeepRunning: true } : { teardownDeploymentIds: [] }) });
      if (!detach) expect(body).not.toHaveProperty('detachKeepRunning', true);
      deleted = true;
      return { body: { ok: true, environmentId: detail.environment.id,
        revision: detail.environment.revision + 1, detached: detach } };
    } });
    const machineId = detail.environment.controllerMachineId!;
    let inventoryReads = 0;
    await answerTeardownController(machineId, raw => {
      const input = DeploymentTeardownActionInputV1Schema.parse(raw);
      if ('mode' in input && input.mode === 'preview') {
        inventoryReads += 1;
        if (neverDeployed) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        if (inventoryFailure && inventoryReads === 1) return inventoryFailure === 'transport'
          ? { ok: false, errorCode: 'machine_rpc_unavailable', error: 'machine_rpc_unavailable',
              failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: 'ECONNREFUSED', httpStatus: null } }
          : inventoryFailure === 'read' ? { ok: false, error: 'deployment_content_unavailable' }
            : { ok: false, errorCode: 'invalid_encrypted_envelope', error: 'invalid_encrypted_envelope', effectAttempted: false };
        if (inventoryFailure) return { ok: true, kind: 'preview', volumes: [] };
        return { ok: true, kind: 'preview', volumes: [{ name: 'app_data', machineId }, { name: 'app_logs', machineId }] };
      }
      if (neverDeployed) return { ok: false, error: 'target_unavailable' };
      if (removed && !neverDeployed && !inventoryFailure) expect(input).toMatchObject({ volumes: [
        { name: 'app_data', disposition: 'delete', confirmation: 'app_data' },
        { name: 'app_logs', disposition: 'keep' },
      ] });
      return removed ? { ok: true, environmentId: detail.environment.id,
        revision: detail.environment.revision + 2, deploymentId: 'teardown-removed', deploymentRevision: 2, state: 'succeeded', environmentRemoved: true }
        : { ok: false, errorCode: 'deployment_domain_native_unavailable', error: 'deployment_domain_native_unavailable' };
    }, result => {
      const failure = ActionExecuteFailureSchema.safeParse(result);
      return failure.success ? failure.data : null;
    });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const { createDeploymentActions } = await import('./deploymentActions');
    const done = vi.fn();
    try {
      if (detach) routerMock.module.router.setParams({ deploymentEnvironment: detail.environment.id });
      const screen = await renderScreen(<ModalProvider>{detach ? <ProjectDeploymentsView controller={controller}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} lifetime={lifetime}
        sourceId={scope.projectSourceId} actions={createDeploymentActions(lifetime, scope.projectSourceId)} /> : <DeploymentEnvironmentDetail controller={controller}
        environmentId={detail.environment.id} demand={shown} accountId={scope.accountId} serverId={scope.serverId}
        phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} lifetime={lifetime}
        destination={settingsRemoval ? { tab: 'settings', section: null } : undefined}
        disposition={createDeploymentActions(lifetime, scope.projectSourceId)} onDeleted={done} />}
      </ModalProvider>);
      if (detach) await act(async () => {
        screen.findByTestId('project-deployments.layout')?.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 800 } } });
      });
      if (settingsRemoval) {
        await screen.pressByTestIdAsync('project-deployments.environment.settings.servers-build.unlink');
        await screen.pressByTestIdAsync('project-deployments.disposition.choice:remove');
      } else {
        await waitForContent(screen, 'project-deployments.environment.menu');
        await screen.pressByTestIdAsync('project-deployments.environment.menu');
        await waitForContent(screen, 'project-deployments.environment.menu.delete');
        await screen.pressByTestIdAsync('project-deployments.environment.menu.delete');
        if (running) {
          await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.disposition.choice:remove'), screen.getTextContent()).not.toBeNull());
          await screen.pressByTestIdAsync('project-deployments.disposition.choice:remove');
        }
      }
      if (removed && !neverDeployed && !inventoryFailure) {
        await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.disposition.volume.app_data:delete')).not.toBeNull());
        await screen.pressByTestIdAsync('project-deployments.disposition.volume.app_data:delete');
        expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(true);
        await act(async () => {
          screen.findByTestId('project-deployments.disposition.volume.app_data.confirmation')?.props.onChangeText('app');
        });
        expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(true);
        await act(async () => {
          screen.findByTestId('project-deployments.disposition.volume.app_data.confirmation')?.props.onChangeText('app_data');
        });
      }
      if (inventoryFailure) {
        const errorId = 'project-deployments.disposition.volumes.error';
        await waitForContent(screen, errorId);
        expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync(`${errorId}-details-toggle`);
        expect(screen.getTextContent()).toContain(inventoryFailure === 'transport' ? 'machine_rpc_unavailable'
          : inventoryFailure === 'read' ? 'deployment_content_unavailable' : 'invalid_encrypted_envelope');
        if (inventoryFailure === 'transport') expect(screen.getTextContent()).toContain('ECONNREFUSED');
        expect(inventoryReads).toBe(1);
        if (detach) {
          await screen.pressByTestIdAsync('project-deployments.disposition.choice:detach');
        } else {
          await screen.pressByTestIdAsync('project-deployments.disposition.volumes.retry');
          await waitForContent(screen, 'project-deployments.disposition.volumes.empty');
          expect(inventoryReads).toBe(2);
        }
      }
      await waitForHomeGovernance(() => {
        expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(false);
      });
      if (neverDeployed) await waitForContent(screen, 'project-deployments.disposition.volumes.empty');
      const previousTeardowns = homes.requestsFor('/v1/actions/deployments.teardown').length;
      const previousDeletions = homes.requestsFor(deletionPath).length;
      await screen.pressByTestIdAsync('project-deployments.disposition.confirm');
      await waitForHomeGovernance(() => {
        if (detach) expect(screen.findByTestId('project-deployments.environment') === null,
          'Deleted Environment detail closes while the collection refresh is pending').toBe(true);
        else if (removed) expect(done, screen.getTextContent()).toHaveBeenCalledOnce();
        else expect(screen.findByTestId('project-deployments.disposition.refused')).not.toBeNull();
        expect(homes.requestsFor('/v1/actions/deployments.teardown')).toHaveLength(previousTeardowns + (neverDeployed || detach ? 0 : 1));
      });
      expect(homes.requestsFor(deletionPath)).toHaveLength(previousDeletions + (neverDeployed || detach ? 1 : 0));
      expect(homes.requestsFor(`/v1/deployments/environments/${detail.environment.id}/targets/target-link/unlink`)).toHaveLength(0);
      if (removed) expect(screen.findByTestId('project-deployments.disposition')).toBeNull();
      else {
        expect(done).not.toHaveBeenCalled();
        expect(screen.findByTestId('project-deployments.disposition')).not.toBeNull();
      }
      if (detach) {
        await waitForHomeGovernance(() => expect(finishRefresh).toBeTypeOf('function'));
        await act(async () => { finishRefresh?.(); });
        await waitForContent(screen, 'project-deployments.empty');
        expect(screen.findByTestId('project-deployments.environment')).toBeNull();
      }
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('shows the stored definition on Overview in the kept order (dEnvOv KEEP item 3, owner-approved 11-13)', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, content: { ...base.content, definition: {
      kind: 'stored' as const, contentRevision: 4, composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  app:\n    image: nginx:2\n', profiles: [], services: ['app'],
    } } };
    const { controller } = controllerFor({ detail });
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        review={noReview} onOpenReceipt={() => {}} />);
      await waitForContent(screen, 'project-deployments.environment.definition');
      expect(screen.findByTestId('project-deployments.environment.definition')).not.toBeNull();
      await screen.unmount();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it.each([false, true].flatMap(phone => ['edit', 'move'].map(entry => ({ phone, entry }))))(
    'opens the one stored editor from Overview without saving or deploying (phone=$phone entry=$entry)', async ({ phone, entry }) => {
    const base = environmentDetailForHome();
    const definition = { kind: 'stored' as const, contentRevision: 4, composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  app:\n    image: nginx:2\n', profiles: [], services: ['app'] };
    const detail = { ...base, content: { ...base.content, definition } };
    const { controller } = controllerFor({ detail });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const { createDeploymentActions } = await import('./deploymentActions');
    const beforeUpdates = homes.requestsFor('/v1/actions/deployments.environments.update').length;
    const beforeDeploys = homes.requestsFor('/v1/actions/deployments.deploy').length;
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={phone} deploy={null}
        review={noReview} onOpenReceipt={() => {}} lifetime={lifetime}
        environmentActions={createDeploymentActions(lifetime, detail.environment.projectSourceId)} />);
      await waitForContent(screen, 'project-deployments.environment.header');
      const summary = screen.findByTestId('project-deployments.environment.definition');
      expect(summary).not.toBeNull();
      const { t } = await import('@/text');
      expect(screen.getTextContent()).toContain(t('projects.deployments.overviewStatus.definitionStoredDescription', { revision: 4 }));
      expect(screen.findByTestId('project-deployments.environment.definition.repositoryRequired')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.environment.definition.move')).not.toBeNull();
      // Merely reading the definition does not mount an editable copy of the document.
      expect(screen.findByTestId('project-deployments.definition.document')).toBeNull();
      await screen.pressByTestIdAsync(`project-deployments.environment.definition.${entry}`);
      await waitForContent(screen, 'project-deployments.environment.moveRepository.open');
      await waitForContent(screen, 'project-deployments.definition.document');
      expect(screen.findByTestId('project-deployments.definition.document')?.props.value).toBe(definition.document);
      expect(homes.requestsFor('/v1/actions/deployments.environments.update')).toHaveLength(beforeUpdates);
      expect(homes.requestsFor('/v1/actions/deployments.deploy')).toHaveLength(beforeDeploys);
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('edits stored Compose through the public update Action while retaining selectors and public files', async () => {
    scope.serverId = await homes.addHome({ name: 'Stored editor', serverUrl: 'https://stored-editor.test',
      accountId: scope.accountId, currentAccount: true, serverIdentityId: `srv_${'c'.repeat(32)}` });
    const base = environmentDetailForHome();
    const definition = { kind: 'stored' as const, contentRevision: 3, composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  app:\n    image: nginx:1\n', profiles: ['web'], services: ['app'], primaryService: 'app',
      publicFiles: [{ path: 'index.html', content: 'Hello' }] };
    const detail = { ...base, content: { ...base.content, definition } };
    const { controller } = controllerFor({ detail });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const { createDeploymentActions } = await import('./deploymentActions');
    const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
    const { DeploymentActionInputSchemasV1 } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
    let submitted: unknown;
    homes.answer(scope.serverId, `GET /v1/deployments/environments/${detail.environment.id}`, {
      body: { ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink) },
    });
    await answerExternalActionAccountForHome(homes, scope.serverId, { machineId: detail.environment.controllerMachineId,
      actionId: 'deployments.environments.update', tokenEpoch: 0, execute: raw => {
        submitted = DeploymentActionInputSchemasV1['deployments.environments.update'].parse(raw);
        return { ok: false, error: 'deployment_conflict' };
      } });
    try {
      let navigate: (tab: DeploymentEnvironmentTabV1) => void = () => {};
      const actions = createDeploymentActions(lifetime, detail.environment.projectSourceId);
      function EditorPage() {
        const [tab, setTab] = React.useState<DeploymentEnvironmentTabV1>('settings');
        navigate = setTab;
        return <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
          demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
          destination={{ tab, section: null }} environmentActions={actions}
          review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} />;
      }
      const screen = await renderScreen(<EditorPage />);
      await waitForContent(screen, 'project-deployments.environment.settings.lead');
      const field = screen.findByTestId('project-deployments.definition.document');
      expect(field).not.toBeNull();
      expect(submitted).toBeUndefined();
      const document = definition.document.replace('nginx:1', 'nginx:2');
      await act(async () => { field?.props.onChangeText(document); });
      await act(async () => { navigate('overview'); });
      await act(async () => { navigate('settings'); });
      expect(screen.findByTestId('project-deployments.definition.document')?.props.value).toBe(document);
      await screen.pressByTestIdAsync('project-deployments.definition.save');
      await waitForHomeGovernance(() => expect(submitted, screen.getTextContent()).toEqual(expect.objectContaining({
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        patch: { definition: { from: 'compose', document, profiles: ['web'], services: ['app'], primaryService: 'app',
          publicFiles: definition.publicFiles } },
      })));
      expect(screen.findByTestId('project-deployments.definition.document')?.props.value).toBe(document);
      await screen.pressByTestIdAsync('project-deployments.definition.cancel');
      expect(screen.findByTestId('project-deployments.definition.document')?.props.value).toBe(definition.document);
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('shows stored Compose without an edit control to a viewer', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, environment: { ...base.environment,
      capabilities: { ...base.environment.capabilities, role: 'reader' as const, manage: false, deploy: false } },
      content: { ...base.content, definition: { kind: 'stored' as const, contentRevision: 3,
        composeDigest: `sha256:${'a'.repeat(64)}`, document: 'services:\n  app:\n    image: nginx:1\n', profiles: [], services: ['app'] } } };
    const { controller } = controllerFor({ detail });
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        destination={{ tab: 'settings', section: null }} review={noReview} onOpenReceipt={() => {}} />);
      await waitForContent(screen, 'project-deployments.environment.settings.lead');
      expect(screen.findByTestId('project-deployments.definition.document')?.props.editable).toBe(false);
      expect(screen.findByTestId('project-deployments.definition.save')).toBeNull();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('reports the same Previews availability on Overview and Settings for a stored definition', async () => {
    const { t } = await import('@/text');
    const base = environmentDetailForHome();
    const detail = environmentDetailForHome({ content: { ...base.content, definition: { kind: 'stored',
      contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`, document: 'services: {app: {image: nginx:1}}',
      profiles: [], services: ['app'] } } });
    const { controller } = controllerFor({ detail });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
      demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
      review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} />);
    try {
      const overview = 'project-deployments.environment.overview.previews';
      const settings = 'project-deployments.environment.settings.previews.template.needsRepository';
      await waitForContent(screen, overview);
      const needsRepository = t('projects.deployments.settingsSections.previewsNeedRepository');
      expect(screen.findByTestId(overview)?.findAll(node => node.children.includes(needsRepository)).length).toBeGreaterThan(0);
      await selectEnvironmentTab(screen, 'settings');
      await waitForContent(screen, settings);
      expect(screen.findByTestId(settings)?.findAll(node => node.children.includes(needsRepository)).length).toBeGreaterThan(0);
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('uses the History day heading for a receipt just across a calendar-day boundary', async () => {
    const { t } = await import('@/text');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 10, 19, 0, 5).getTime());
    const receipt = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({
      id: 'previous-week', state: 'succeeded', settledAtMs: new Date(2026, 10, 13, 23, 55).getTime(),
    }) });
    const { controller, detail } = controllerFor({ receipt, history: [receipt] });
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        destination={{ tab: 'history', section: null }} review={noReview} onOpenReceipt={() => {}} />);
      try {
        const row = 'project-deployments.receipt.row.previous-week';
        await waitForContent(screen, row);
        const day = t('sessionHistory.daysAgo', { count: 6 });
        expect(screen.findByTestId('project-deployments.environment.history.day.2026-11-13')).not.toBeNull();
        expect(screen.findByTestId(row)?.findAll(node => node.children.includes(day)).length).toBeGreaterThan(0);
      } finally { await screen.unmount(); }
    } finally { clock.mockRestore(); await act(async () => { controller.retire(); }); }
  });

  it('reads a Compose file stored as JSON as YAML in the editor, unchanged until someone edits it', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, content: { ...base.content, definition: { kind: 'stored' as const, contentRevision: 1,
      composeDigest: `sha256:${'a'.repeat(64)}`, document: '{"services":{"app":{"image":"nginx:1"}}}', profiles: [], services: ['app'] } } };
    const { controller } = controllerFor({ detail });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const { createDeploymentActions } = await import('./deploymentActions');
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        destination={{ tab: 'settings', section: null }} review={noReview} onOpenReceipt={() => {}} lifetime={lifetime}
        environmentActions={createDeploymentActions(lifetime, detail.environment.projectSourceId)} />);
      await waitForContent(screen, 'project-deployments.environment.settings.lead');
      expect(screen.findByTestId('project-deployments.definition.document')?.props.value).toBe('services:\n  app:\n    image: nginx:1\n');
      expect(screen.findByTestId('project-deployments.definition.save')?.props.disabled).toBe(true);
      expect(screen.findByTestId('project-deployments.definition.cancel')).toBeNull();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('keeps an unsaved Variables edit across Settings and counts a renamed Saved-secret reference as an added secret', async () => {
    const base = environmentDetailForHome();
    const binding = createDeploymentSecretVariableBindingV1({ name: 'ORIGINAL', phase: 'runtime', resourceId: 'saved', resourceRevision: 1 });
    const detail = { ...base, content: { ...base.content, bindings: [binding] } };
    const { controller } = controllerFor({ detail });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} />);
      await selectEnvironmentTab(screen, 'variables');
      await waitForContent(screen, 'project-deployments.environment.variables.mode:bulk');
      await screen.pressByTestIdAsync('project-deployments.environment.variables.mode:bulk');
      const field = screen.findByTestId('project-deployments.environment.variables.bulk.text');
      await act(async () => { field?.props.onChangeText(field.props.value.replace('ORIGINAL', 'RENAMED')); });
      const { t } = await import('@/text');
      const summary = screen.findByTestId('project-deployments.environment.variables.bulk.diff');
      expect(summary?.findAll(node => node.children.includes(t('projects.deployments.bulkAddedSecrets', { count: 1 }))).length).toBeGreaterThan(0);
      expect(summary?.findAll(node => node.children.includes(t('projects.deployments.bulkAddedPlain', { count: 1 }))).length).toBe(0);
      await selectEnvironmentTab(screen, 'settings');
      await waitForContent(screen, 'project-deployments.environment.settings.lead');
      await selectEnvironmentTab(screen, 'variables');
      await waitForContent(screen, 'project-deployments.environment.variables.mode:bulk');
      await screen.pressByTestIdAsync('project-deployments.environment.variables.mode:bulk');
      expect(screen.findByTestId('project-deployments.environment.variables.bulk.text')?.props.value).toContain('RENAMED');
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('shows the running Secret revision in Variables and sends its Deploy through the page approval continuation', async () => {
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    await publishMachineInventoryForTest(scope, [createMachineFixture({ id: 'machine-a', activeAt: Date.now() })]);
    const base = environmentDetailForHome();
    const binding = createDeploymentSecretVariableBindingV1({ name: 'TOKEN', phase: 'runtime', resourceId: 'credential', resourceRevision: 2 });
    const detail = { ...base, content: { ...base.content, bindings: [binding] },
      savedSecretRevisions: [{ resourceId: 'credential', revision: 2 }] };
    await answerExistingDeploymentCheckout(detail);
    const original = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({ content: { ...original.content, ownServer: { approvedInputBasis: {
      v: 1, environmentId: detail.environment.id, environmentRevision: 1,
      targetLinkId: original.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent: original.content.sourceIntent,
      manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1',
      services: ['app'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }], images: [],
      bindings: [{ ...binding, source: { ...binding.source, resourceRevision: 1 } }],
    } } } });
    const { controller } = controllerFor({ detail, receipt });
    const { HappyError } = await import('@/utils/errors/errors');
    const deploy = vi.fn(async () => {
      throw new HappyError('approval_request_created', false, { code: 'approval_request_created',
        details: { kind: 'approval_request_created', artifactId: 'secret-approval', actionId: 'deployments.deploy' } });
    });
    const requested = vi.fn();
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
      demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={deploy}
      review={{ pendingId: 'secret-approval', request: requested, open: () => {} }} onOpenReceipt={() => {}} lifetime={lifetime} />);
    try {
      await selectEnvironmentTab(screen, 'variables');
      const notice = 'project-deployments.environment.variables.rotated';
      await waitForContent(screen, notice);
      expect(deploy).not.toHaveBeenCalled();
      await screen.pressByTestIdAsync(`${notice}.action`);
      expect(deploy).toHaveBeenCalledExactlyOnceWith({ environmentId: detail.environment.id, targetLinkId: 'target-link' });
      expect(requested).toHaveBeenCalledExactlyOnceWith('secret-approval');
      expect(screen.findByTestId('project-deployments.outcome.approval')).not.toBeNull();
      expect(screen.findByTestId(`${notice}.action`)).toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it.each(['empty', 'pending', 'failed'] as const)('opens an exact Environment even when it is absent from the current collection page (%s)', async rail => {
    const detail = environmentDetailForHome();
    let detailReads = 0;
    const controller = createDeploymentReadControllerV1({ scope, transport: {
      listEnvironments: async (_scope, _query, options) => rail === 'pending'
        ? new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ ok: false,
            failure: { code: 'cancelled', retryable: false } }), { once: true }))
        : rail === 'failed' ? { ok: false, failure: { code: 'offline', retryable: true } }
        : { ok: true, value: { items: [], nextCursor: null } },
      readEnvironment: async () => { detailReads++; return { ok: true, value: detail }; },
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: false, failure: { code: 'not_found', retryable: false } }),
    } });
    routerMock.module.router.setParams({ deploymentEnvironment: detail.environment.id,
      deploymentTab: 'settings', deploymentSection: 'controller' });
    try {
      const screen = await renderScreen(<ProjectDeploymentsView controller={controller} demand={shown}
        accountId="account-owner" serverId={scope.serverId} lifetime={null} sourceId="source-app" />);
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.environment.settings.controller'), node => node !== null); });
      expect(screen.findByTestId('project-deployments.environment.settings.controller')).not.toBeNull();
      expect(detailReads).toBe(1);
      expect(screen.findByTestId('project-deployments.empty')).toBeNull();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('gives a phone a way back to the list on the standalone deployments route, where no Project bar hosts Back', async () => {
    device.current = 'phone';
    const { controller, detail } = controllerFor({});
    routerMock.module.router.setParams({ deploymentEnvironment: detail.environment.id });
    try {
      const screen = await renderScreen(<ProjectDeploymentsView controller={controller} demand={shown}
        accountId="account-owner" serverId={scope.serverId} lifetime={null} sourceId="source-app" />);
      await waitForContent(screen, 'project-deployments.environment.back');
      await screen.pressByTestIdAsync('project-deployments.environment.back');
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(screen.findByTestId('project-deployments.environment.back')).toBeNull();
      });
    } finally { controller.retire(); }
  });

  it('opens the Environment, tab and Settings section a link names, and keeps the URL on each tab change', async () => {
    const { controller, detail } = controllerFor({});
    routerMock.module.router.setParams({ deploymentEnvironment: detail.environment.id,
      deploymentTab: 'settings', deploymentSection: 'controller' });
    routerMock.spies.setParams.mockClear();
    try {
      const screen = await renderScreen(<ProjectDeploymentsView controller={controller} demand={shown}
        accountId="account-owner" serverId={scope.serverId} lifetime={null} sourceId="source-app" />);
      await waitForContent(screen, 'project-deployments.environment.settings.controller');
      await selectEnvironmentTab(screen, 'history');
      await waitForContent(screen, 'project-deployments.environment.history');
      expect(routerMock.spies.setParams).toHaveBeenLastCalledWith(expect.objectContaining({
        deploymentTab: 'history', deploymentSection: undefined }));
      expect(screen.findByTestId('project-deployments.environment.history')).not.toBeNull();
    } finally { controller.retire(); }
  });

  it('says a failed deploy in the rail without naming a Machine this Home does not know', async () => {
    const { controller, detail } = controllerFor({});
    const failed = createDeploymentReceiptHeaderV1({ id: 'failed-release', state: 'failed' });
    const transport: DeploymentReadTransportV1 = {
      listEnvironments: async () => ({ ok: true, value: { items: [
        { environment: detail.environment, title: detail.content.name, currentDeployment: failed }], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [failed], nextCursor: null } }),
      readReceipt: async () => ({ ok: false, errorCode: 'not_found' }) as never,
    };
    controller.retire();
    const railController = createDeploymentReadControllerV1({ scope, transport });
    try {
      const screen = await renderScreen(<ProjectDeploymentsView controller={railController} demand={shown}
        accountId="account-owner" serverId={scope.serverId} lifetime={null} sourceId="source-app" />);
      const row = screen.findHostByTestId(`project-deployments.rail.row.${detail.environment.id}`);
      expect(row).not.toBeNull();
      const text = screen.getTextContent();
      expect(text).toContain('Failed');
      // Landing still opens the first Environment when this split page has no route selection.
      await act(async () => {
        screen.findByTestId('project-deployments.layout')?.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 800 } } });
      });
      await waitForContent(screen, 'project-deployments.environment');
      expect(text).not.toContain('null');
    } finally { railController.retire(); }
  });

  it.each([
    ['succeeded', true],
    ['running_unverified', true],
    ['queued', false],
    ['running', false],
    ['failed', false],
    ['cancelled', false],
    ['outcome_unknown', false],
  ] as const)('offers rollback for a retained %s receipt: %s', async (state, eligible) => {
    const base = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: 'retained-release', state,
        ...(['queued', 'running', 'outcome_unknown'].includes(state) ? { settledAtMs: undefined } : {}),
      }),
      content: base.content,
    });
    const { controller, detail } = controllerFor({ receipt });
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail cancel={null} deploy={null} phone={false} linkPath={null} serverId={scope.serverId} readLogs={null} controller={controller}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} environmentName="Staging"
        demand={shown} accountId="account-owner" onBack={() => {}} rollback={async () => ({ ok: true,
          environmentId: detail.environment.id, revision: 1, deploymentId: 'rollback-result', deploymentRevision: 1, state: 'queued' })}
        review={noReview} onOpenReceipt={() => {}} />);
      expect(screen.findByTestId('project-deployments.receipt.rollback') !== null).toBe(eligible);
    } finally { controller.retire(); }
  });

  it('names who acted in Recent activity from the captured actor, never from the requester (owner ruling 11-15)', async () => {
    const base = environmentDetailForHome();
    const servingId = base.targetLinks.find(row => row.targetLink.id === base.environment.runtimeTargetLinkId)?.targetLink.activeDeploymentId;
    if (!servingId) throw new Error('Expected a serving receipt in the fixture');
    const serving = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: servingId, state: 'succeeded' }) });
    const plain = createDeploymentReceiptDetailV1();
    // Both earlier attempts were requested by the viewer: one by their agent, one with no captured actor at all.
    const byAgent = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: 'agent-attempt', state: 'succeeded', requestedByAccountId: scope.accountId }),
      content: { ...plain.content, actor: { actorKind: 'agent', sessionId: 'session-agent',
        onBehalfOf: { serverId: scope.serverId, accountId: scope.accountId } } } as typeof plain.content });
    const unknown = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: 'unknown-attempt', state: 'succeeded', requestedByAccountId: scope.accountId }) });
    const { controller, detail } = controllerFor({ receipt: serving, history: [serving, byAgent, unknown], detail: base });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller}
        environmentId={detail.environment.id} demand={shown} accountId={scope.accountId} serverId={scope.serverId}
        phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} />);
      await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('(your session)'));
      const text = screen.getTextContent();
      // The agent acted for the viewer, so it is not "You"; the receipt with no captured actor names nobody.
      expect(text).toContain('An agent (your session)');
      expect(text).not.toMatch(/\bYou\b/);
      expect(text).not.toContain('by you');
    } finally { controller.retire(); }
  });

  it('says how several servers are doing in the facts, and opens History from Recent deployments', async () => {
    const base = environmentDetailForHome();
    const servingId = base.targetLinks.find(row => row.targetLink.id === base.environment.runtimeTargetLinkId)?.targetLink.activeDeploymentId;
    if (!servingId) throw new Error('Expected a serving receipt in the fixture');
    const serving = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: servingId, state: 'succeeded' }) });
    const earlier = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'earlier-attempt', state: 'succeeded' }) });
    const { controller, detail } = controllerFor({ receipt: serving, history: [serving, earlier], detail: { ...base, healthAggregate: {
      v: 1, environmentId: base.environment.id, targetLinkId: base.environment.runtimeTargetLinkId!,
      protection: base.environment.protection, status: 'degraded', n: 3, down: 1, degraded: 0, unknown: 0,
      members: [], affectedMachineIds: [], edgeUnreachable: false, authoritativeRecovery: false,
    } } });
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller}
        environmentId={detail.environment.id} demand={shown} accountId="account-owner" serverId={scope.serverId}
        phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} />);
      expect(screen.findByTestId('project-deployments.environment.facts.health')).not.toBeNull();
      expect(screen.getTextContent()).toContain('2 of 3 servers healthy');
      // The version that serves leads the page, so Recent lists what came before it and never the same row again.
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.receipt.row.earlier-attempt')).not.toBeNull());
      expect(screen.findByTestId(`project-deployments.receipt.row.${servingId}`)).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.environment.recent.history');
      expect(screen.findByTestId('project-deployments.environment.history')).not.toBeNull();
      // History is the whole record, the serving version included.
      await waitForHomeGovernance(() => expect(screen.findByTestId(`project-deployments.receipt.row.${servingId}`)).not.toBeNull());
    } finally { controller.retire(); }
  });

  it('says a failed attempt\'s cause in words, names the serving version once, and one no-health-check claim', async () => {
    const detail = environmentDetailForHome();
    const servingId = detail.targetLinks.find(row => row.targetLink.id === detail.environment.runtimeTargetLinkId)?.targetLink.activeDeploymentId;
    if (!servingId) throw new Error('Expected a serving receipt in the fixture');
    const base = createDeploymentReceiptDetailV1();
    const { commitSubject: _subject, ...withoutSubject } = base.content;
    const serving = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: servingId, state: 'running_unverified' }), content: withoutSubject });
    const failed = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: 'failed-attempt', state: 'failed' }),
      content: { ...withoutSubject, failure: { code: 'machine_target_not_current', phase: 'admission' } } });
    const { controller } = controllerFor({ detail, receipt: serving, history: [serving, failed] });
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller}
        environmentId={detail.environment.id} demand={shown} accountId="account-owner" serverId={scope.serverId}
        phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} />);
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.receipt.row.failed-attempt')).not.toBeNull());
      const text = screen.getTextContent();
      expect(text).not.toContain('machine_target_not_current');
      expect(text).toContain('The deploy couldn’t start');
      const servingRow = screen.findByTestId('project-deployments.environment.serving.receipt');
      const servingText = JSON.stringify(servingRow?.findAll(node => typeof node.type === 'string' && typeof node.props.children === 'string')
        .map(node => node.props.children));
      expect(servingText.split('aaaaaaa').length - 1).toBe(1);
      // The Overview carries the receipt's own notice for a version running without a health check, and says it once:
      // the facts no longer repeat it (DEPLOY-ACCEPT-143 A7).
      expect(screen.findByTestId('project-deployments.environment.serving.notice.running_unverified')).not.toBeNull();
      expect(JSON.stringify(screen.findByTestId('project-deployments.environment.facts')?.findAll(node =>
        typeof node.props.children === 'string').map(node => node.props.children))).not.toContain('No health check');
    } finally { controller.retire(); }
  });

  it.each([[true, false], [false, true]] as const)('offers Prepare with an agent once: not on the Overview while the Environments list beside it offers it (list %s)', async (listOffers, onOverview) => {
    const { ModalProvider } = await import('@/modal');
    const base = environmentDetailForHome();
    const detail = environmentDetailForHome({ content: { ...base.content,
      definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: ['app'] } } } });
    const { controller } = controllerFor({ detail });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    try {
      const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} preparationInList={listOffers} /></ModalProvider>);
      await waitForContent(screen, 'project-deployments.environment.menu');
      expect(screen.findByTestId('project-deployments.prepare.open') !== null).toBe(onOverview);
      await screen.unmount();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('names the Project the hosting page carries in the meta line, even without a checkout, and opens it', async () => {
    const { controller, detail } = controllerFor({});
    const open = vi.fn();
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview}
        onOpenReceipt={() => {}} project={{ name: 'billing-api', onOpen: open }} />);
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.environment.header')).not.toBeNull());
      expect(screen.getTextContent()).toContain('billing-api');
      // The meta fact is a link (the header owner's pressable inside the fact).
      const link = screen.findByTestId('project-deployments.environment.project')
        ?.findAll(node => node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function')[0];
      await act(async () => { link?.props.onPress(); });
      expect(open).toHaveBeenCalledTimes(1);
    } finally { controller.retire(); }
  });

  it('shows the version the runtime link serves and opens its receipt', async () => {
    const base = environmentDetailForHome();
    const current = base.targetLinks[0]!;
    const { controller, detail, receipt } = controllerFor({ detail: {
      ...base, targetLinks: [{ ...current, targetLink: { ...current.targetLink,
        id: 'retained-predecessor', activeDeploymentId: undefined } }, current],
    } });
    const open = vi.fn();
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail
        controller={controller}
        environmentId={detail.environment.id}
        demand={shown}
        accountId="account-owner"
        serverId={scope.serverId}
        phone={false}
        deploy={null}
        review={noReview}
        onOpenReceipt={open}
      />,
    );
    expect(screen.getTextContent()).toContain(detail.content.name);
    // The serving row names the exact commit the receipt deployed, not the latest history row.
    expect(screen.getTextContent()).toContain('a'.repeat(7));
    expect(
      screen.findByTestId('project-deployments.environment.serving.none'),
    ).toBeNull();
    await screen.pressByTestIdAsync(
      'project-deployments.environment.serving.receipt',
    );
    expect(open).toHaveBeenCalledWith(receipt.deployment.id);
    controller.retire();
  });


  describe('the first deploy ends on the live address (FIRST-DEPLOY-URL-1112)', () => {
    const liveDomains = (targetLinkId: string): DeploymentReadTransportV1['listDomains'] => async () => ({ ok: true as const, value: {
      items: [{
        domain: { v: 1 as const, id: 'app-domain', environmentId: 'ignored', targetLinkId, revision: 1, state: 'active' as const,
          contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1,
          createdByAccountId: 'account-owner', createdAtMs: 1, updatedAtMs: 1 },
        title: 'shop.example.test', content: { hostname: 'shop.example.test', target: { service: 'app', containerPort: 3000 } },
      }], nextCursor: null } });
    const servingFixture = (earlier: boolean) => {
      const detail = environmentDetailForHome();
      const runtime = detail.targetLinks.find(row => row.targetLink.id === detail.environment.runtimeTargetLinkId)!.targetLink;
      const serving = createDeploymentReceiptDetailV1({
        deployment: createDeploymentReceiptHeaderV1({ id: runtime.activeDeploymentId!, targetLinkId: runtime.id, state: 'succeeded' }) });
      const older = createDeploymentReceiptDetailV1({
        deployment: createDeploymentReceiptHeaderV1({ id: 'earlier-deploy', targetLinkId: runtime.id, state: 'succeeded' }) });
      return controllerFor({ detail, receipt: serving, history: earlier ? [serving, older] : [serving],
        listDomains: liveDomains(runtime.id) });
    };
    const openButton = async (screen: Awaited<ReturnType<typeof renderScreen>>) => {
      const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
      return screen.findAllByType(RoundButton).find(button => button.props.testID === 'project-deployments.environment.live.open');
    };

    it('leads with the address once the first deploy serves, with Open as the one primary', async () => {
      const { controller, detail } = servingFixture(false);
      try {
        const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
          demand={shown} accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview}
          onOpenReceipt={() => {}} />);
        await waitForHomeGovernance(async () => expect(await openButton(screen)).toBeDefined());
        expect(screen.getTextContent()).toContain('shop.example.test');
        expect((await openButton(screen))?.props.display ?? 'default').toBe('default');
      } finally { controller.retire(); }
    });

    it('keeps Open beside Deploy once the Environment has deployed before', async () => {
      const { controller, detail } = servingFixture(true);
      try {
        const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
          demand={shown} accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview}
          onOpenReceipt={() => {}} />);
        await waitForHomeGovernance(async () => expect(await openButton(screen)).toBeDefined());
        expect((await openButton(screen))?.props.display).toBe('secondary');
      } finally { controller.retire(); }
    });

    it('stays on the failure and its recovery when the first deploy fails', async () => {
      const base = environmentDetailForHome();
      const detail = environmentDetailForHome({ targetLinks: base.targetLinks.map(link => ({
        ...link, targetLink: { ...link.targetLink, activeDeploymentId: undefined } })) });
      const runtimeId = detail.environment.runtimeTargetLinkId!;
      const failed = createDeploymentReceiptDetailV1({
        deployment: createDeploymentReceiptHeaderV1({ id: 'first-failed', targetLinkId: runtimeId, state: 'failed' }) });
      const { controller } = controllerFor({ detail, receipt: failed, history: [failed], listDomains: liveDomains(runtimeId) });
      try {
        const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
          demand={shown} accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview}
          onOpenReceipt={() => {}} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.environment.attention.latestFailed')).not.toBeNull());
        expect(await openButton(screen)).toBeUndefined();
      } finally { controller.retire(); }
    });
  });

  it('says nothing is deployed when the runtime link has no active receipt, and who can deploy for a reader', async () => {
    const base = environmentDetailForHome();
    const detail = environmentDetailForHome({
      environment: environmentHeaderForHome({
        capabilities: {
          ...base.environment.capabilities,
          role: 'reader',
          deploy: false,
        },
      }),
      targetLinks: base.targetLinks.map((link) => ({
        ...link,
        targetLink: { ...link.targetLink, activeDeploymentId: undefined },
      })),
    });
    const { controller } = controllerFor({ detail });
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail
        controller={controller}
        environmentId={detail.environment.id}
        demand={shown}
        accountId="account-owner"
        serverId={scope.serverId}
        phone={false}
        deploy={null}
        review={noReview}
        onOpenReceipt={() => {}}
      />,
    );
    expect(
      screen.findByTestId('project-deployments.environment.serving.none'),
    ).not.toBeNull();
    expect(
      screen.findByTestId('project-deployments.environment.serving.receipt'),
    ).toBeNull();
    expect(screen.getTextContent()).toContain(
      'Only managers of this environment can deploy here.',
    );
    controller.retire();
  });

  it('keeps an unknown outcome nonterminal: one notice and no retry on the receipt', async () => {
    const settled = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({
        state: 'outcome_unknown',
        settledAtMs: undefined,
      }),
      content: {
        ...settled.content,
        machineResults: settled.content.machineResults.map((result) => ({
          ...result,
          activation: 'outcome_unknown',
          health: 'unknown',
        })),
      },
    });
    const { controller, detail } = controllerFor({ receipt });
    const screen = await renderScreen(
      <DeploymentReceiptDetail cancel={null} deploy={null} phone={false} linkPath={null} serverId={scope.serverId} readLogs={null}
        controller={controller}
        environmentId={detail.environment.id}
        deploymentId={receipt.deployment.id}
        environmentName="Staging"
        demand={shown}
        accountId="account-owner"
        onBack={() => {}}
        rollback={null}
        review={noReview}
        onOpenReceipt={() => {}}
      />,
    );
    expect(
      screen.findByTestId(
        'project-deployments.receipt.notice.outcome_unknown',
      ),
    ).not.toBeNull();
    expect(
      screen.findByTestId('project-deployments.receipt.notice.succeeded'),
    ).toBeNull();
    expect(screen.getTextContent()).not.toContain('Deploy again');
    // Its next action: look at what runs on the one Machine it deployed to.
    routerMock.spies.push.mockClear();
    await screen.pressByTestIdAsync('project-deployments.receipt.notice.outcome_unknown.action');
    expect(routerMock.spies.push).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(routerMock.spies.push.mock.calls[0]![0])).toContain(`/machines/${receipt.content.machines[0]}`);
    controller.retire();
  });
  it('explains a failed deploy from its recorded facts: cause, what it left, the masked log tail and a rollback to the incumbent', async () => {
    const base = createDeploymentReceiptDetailV1();
    const environment = environmentDetailForHome();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ state: 'failed' }),
      content: {
        ...base.content,
        failure: { code: 'native_activate_failed', phase: 'activate' },
        commitSubject: 'Repair worker startup',
        machineResults: base.content.machineResults.map((result) => ({
          ...result, activation: 'failed' as const, health: 'unhealthy' as const, restoration: 'failed' as const,
        })),
        ownServer: {
          approvedInputBasis: {
            v: 1, environmentId: environment.environment.id, environmentRevision: 1,
            targetLinkId: base.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent: base.content.sourceIntent,
            manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1',
            services: ['app'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
            bindings: [], images: [], ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true },
          },
          rollbackTarget: { deploymentId: 'last-good', revision: { kind: 'repository', sha: 'b'.repeat(40) } },
          stageLogs: [{ machineId: 'machine-a', installationId: 'installation-a', relativePath: '.happier/deploy.log',
            excerpt: { text: 'Error: connect ECONNREFUSED [REDACTED]', truncated: true } }],
        },
      } as never,
    });
    if (base.content.sourceIntent.kind !== 'repository') throw new Error('Expected repository fixture');
    const incumbent = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'last-good',
      requestedAtMs: 900, startedAtMs: 901, settledAtMs: 902 }),
      content: { ...base.content, sourceIntent: { ...base.content.sourceIntent, sha: 'b'.repeat(40) } } });
    const { controller, detail } = controllerFor({ receipt, detail: environment, history: [receipt, incumbent] });
    const rollback = vi.fn(async () => ({ ok: false as const, error: 'deployment_conflict' }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail cancel={null} deploy={null} phone={false} linkPath={null} serverId={scope.serverId} readLogs={null} controller={controller}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} environmentName="Staging"
        demand={shown} accountId="account-owner" onBack={() => {}} rollback={rollback as never}
        review={noReview} onOpenReceipt={() => {}} />);
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt.outcome.failed.action'), node => node !== null); });
      const text = screen.getTextContent();
      expect(screen.findByTestId('project-deployments.receipt.outcome.failed')).not.toBeNull();
      expect(text).toContain('Repair worker startup');
      expect(text).toContain('ECONNREFUSED');
      // The incumbent is named by its own identity; there is no #N ordinal to invent.
      expect(text).toContain('b'.repeat(7));
      expect(screen.findByTestId('project-deployments.receipt.rollback')).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.receipt.outcome.failed.action');
      expect(rollback).toHaveBeenCalledWith({ environmentId: detail.environment.id, deploymentId: 'last-good' });
    } finally { controller.retire(); }
  });

  it('does not invent a cause, log tail or rollback target for a failed receipt that recorded none', async () => {
    const base = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ state: 'failed' }),
      content: base.content,
    });
    const { controller, detail } = controllerFor({ receipt });
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail cancel={null} deploy={null} phone={false} linkPath={null} serverId={scope.serverId} readLogs={null} controller={controller}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} environmentName="Staging"
        demand={shown} accountId="account-owner" onBack={() => {}} rollback={async () => ({ ok: false, error: 'deployment_conflict' })}
        review={noReview} onOpenReceipt={() => {}} />);
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt.outcome.failed'), node => node !== null); });
      expect(screen.findByTestId('project-deployments.receipt.rollback')).toBeNull();
      await waitForContent(screen, 'investigation.agentActions.unavailable');
      expect(screen.getTextContent()).toContain('Retry');
      expect(screen.findByTestId('project-deployments.receipt.log')).toBeNull();
    } finally { controller.retire(); }
  });

  it('offers rollback of the retained serving predecessor rather than treating it as the current runtime', async () => {
    const base = environmentDetailForHome();
    const current = base.targetLinks[0]!;
    const old = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'old-deployment' }) });
    const { controller, detail } = controllerFor({ receipt: old, detail: {
      ...base, targetLinks: [{ ...current, targetLink: { ...current.targetLink,
        id: 'retained-predecessor', activeDeploymentId: old.deployment.id } }, current],
    } });
    const screen = await renderScreen(
      <DeploymentReceiptDetail cancel={null} deploy={null} phone={false} linkPath={null} serverId={scope.serverId} readLogs={null} controller={controller} environmentId={detail.environment.id}
        deploymentId={old.deployment.id} environmentName="Staging" demand={shown} accountId="account-owner"
        onBack={() => {}} rollback={async () => ({ ok: false, error: 'deployment_unavailable' })}
        review={noReview} onOpenReceipt={() => {}} />,
    );
    expect(screen.findByTestId('project-deployments.receipt.rollback')).not.toBeNull();
    controller.retire();
  });
  it('deploys the runtime link by ids and hands a held review to the page\'s approval continuation', async () => {
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    await publishMachineInventoryForTest(scope, [createMachineFixture({ id: 'machine-a', activeAt: Date.now() })]);
    const { controller, detail } = controllerFor({});
    const { HappyError } = await import('@/utils/errors/errors');
    const deploy = vi.fn(async () => {
      throw new HappyError('approval_request_created', false, {
        code: 'approval_request_created',
        details: { kind: 'approval_request_created', artifactId: 'approval-a', actionId: 'deployments.deploy' },
      });
    });
    const requested: string[] = [];
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail
        controller={controller}
        environmentId={detail.environment.id}
        demand={shown}
        accountId="account-owner"
        serverId={scope.serverId}
        phone={false}
        deploy={deploy}
        review={{ pendingId: 'approval-a', request: (id) => requested.push(id), open: () => {} }}
        onOpenReceipt={() => {}}
      />,
    );
    await screen.pressByTestIdAsync('project-deployments.environment.deploy');
    expect(deploy).toHaveBeenCalledWith({ environmentId: detail.environment.id, targetLinkId: 'target-link' });
    expect(requested).toEqual(['approval-a']);
    // While that review is open, the page says so and offers it again instead of a second Deploy.
    expect(screen.findByTestId('project-deployments.outcome.approval')).not.toBeNull();
    controller.retire();
  });

  it('offers a running target Detach first, and Stop and remove as one teardown of the link it shows', async () => {
    const { controller, detail } = controllerFor({});
    const { ModalProvider } = await import('@/modal');
    const lifetime = { scope: { serverId: scope.serverId, accountId: scope.accountId }, isCurrent: () => true,
      onRetire: () => ({ dispose: () => {} }) };
    const unlink = vi.fn(async (input: Readonly<{ targetLinkId: string }>) =>
      ({ ok: true as const, environmentId: detail.environment.id, revision: 2, targetLinkId: input.targetLinkId, detached: true }));
    const teardown = vi.fn(async (input: Readonly<{ mode?: string }>) => input.mode === 'preview'
      ? { ok: true as const, kind: 'preview' as const, volumes: [] }
      : { ok: true as const, environmentId: detail.environment.id, revision: 3,
        deploymentId: 'teardown-1', deploymentRevision: 1, state: 'running' as const });
    const disposition = { deleteEnvironment: vi.fn(), unlink, teardown };
    const render = () => renderScreen(
      <ModalProvider>
        <DeploymentEnvironmentDetail
          controller={controller}
          environmentId={detail.environment.id}
          demand={shown}
          accountId="account-owner"
          serverId={scope.serverId}
          phone={false}
          deploy={null}
          review={noReview}
          lifetime={lifetime as never}
          disposition={disposition as never}
          onOpenReceipt={() => {}}
        />
      </ModalProvider>,
    );
    const screen = await render();
    await selectEnvironmentTab(screen, 'settings');
    await screen.pressByTestIdAsync('project-deployments.environment.settings.servers-build.unlink');
    // Opening runs nothing; the choice that stops nothing leads, and Stop and remove can be chosen.
    expect(screen.findByTestId('project-deployments.disposition')).not.toBeNull();
    expect(unlink).not.toHaveBeenCalled();
    expect(screen.findByTestId('project-deployments.disposition.choice:remove')?.props.accessibilityState)
      .toMatchObject({ disabled: false, selected: false });
    expect(screen.findByTestId('project-deployments.disposition.choice:detach')?.props.accessibilityState)
      .toMatchObject({ disabled: false, selected: true });
    await screen.pressByTestIdAsync('project-deployments.disposition.confirm');
    // The review is the confirmation of this exact Action: the front door must not ask a second time.
    expect(unlink).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: detail.environment.id, targetLinkId: 'target-link', detachKeepRunning: true,
    }), expect.objectContaining({ confirmed: true }));
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.findByTestId('project-deployments.disposition'), screen.getTextContent()).toBeNull();
    });
    // Stop and remove: one teardown request for the link the sheet showed; the UI builds no candidate.
    await screen.pressByTestIdAsync('project-deployments.environment.settings.servers-build.unlink');
    await screen.pressByTestIdAsync('project-deployments.disposition.choice:remove');
    await waitForHomeGovernance(() => {
      expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(false);
    });
    await screen.pressByTestIdAsync('project-deployments.disposition.confirm');
    expect(teardown).toHaveBeenCalledWith(expect.objectContaining({ environmentId: detail.environment.id,
      targetLinkId: 'target-link', reason: 'manual' }), expect.anything());
    // Still running: nothing is removed yet and the sheet hands over to the receipt.
    expect(unlink).toHaveBeenCalledTimes(1);
    controller.retire();
  });

  it('says health checks start after a deploy instead of reading health where nothing is deployed', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, targetLinks: base.targetLinks.map(item => ({ ...item,
      targetLink: { ...item.targetLink, activeDeploymentId: undefined } })) };
    const { controller } = controllerFor({ detail });
    const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
      demand={shown} accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview}
      onOpenReceipt={() => {}} />);
    try {
      await selectEnvironmentTab(screen, 'settings');
      expect(screen.findByTestId('project-deployments.environment.settings.checks-alerts.notDeployed')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.environment.settings.checks-alerts.error')).toBeNull();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('shares through the Happier network without joining another network and preserves an explicit joined-network choice', async () => {
    scope.serverId = await homes.addHome({ name: 'Private sharing', serverUrl: 'https://private-sharing.test',
      serverIdentityId: 'srv_private-sharing', accountId: scope.accountId, currentAccount: true });
    const base = environmentDetailForHome();
    const stored = environmentDetailForHome({ content: { ...base.content,
      definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
        document: 'services:\n  postgres:\n    image: postgres:17\n    expose:\n      - "5432"\n', profiles: [], services: [] },
    } });
    const { controller, detail } = controllerFor({ detail: stored });
    const { storage } = await import('@/sync/domains/state/storage');
    const { createMachineFixture } = await import('@/dev/testkit');
    const { MachineReachabilityObservationV1Schema } = await import('@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1');
    const network = { provider: { pluginId: 'happier.access.tailscale', localId: 'tailscale' },
      networkIdentity: 'shop-net', displayName: 'Shop network', dnsName: null,
      addresses: ['100.80.0.12'], state: 'ready', interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'], magicDnsEnabled: false };
    const reachability = MachineReachabilityObservationV1Schema.parse({ revision: 1,
      management: { daemon: 'ready', providers: [], publicSsh: 'closed' }, privateNetworks: [network], ingress: [] });
    storage.setState({ profileScope: { serverId: scope.serverId, accountId: scope.accountId } });
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', installationId: 'installation-a' })], true,
      { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
    const { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1 } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
    const updates: Array<ReturnType<typeof DeploymentActionInputSchemasV1['deployments.environments.update']['parse']>> = [];
    await answerExternalActionAccountForHome(homes, scope.serverId, { machineId: 'machine-a', installationId: 'installation-a',
      actionId: 'deployments.environments.update', tokenEpoch: 0, execute: input => {
        updates.push(DeploymentActionInputSchemasV1['deployments.environments.update'].parse(input));
        return DeploymentActionOutputSchemasV1['deployments.environments.update'].parse({ ok: true, environmentId: detail.environment.id, revision: 2 });
      } });
    homes.answer(scope.serverId, `/v1/deployments/environments/${detail.environment.id}`, { body: {
      ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink),
    } });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(scope.serverId);
    const { createDeploymentActions } = await import('./deploymentActions');
    const actions = createDeploymentActions(account.accountLifetime, scope.projectSourceId);
    const { ModalProvider } = await import('@/modal');
    const deploy = vi.fn();
    const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller}
      environmentId={detail.environment.id} demand={shown} accountId={scope.accountId} serverId={scope.serverId}
      destination={{ tab: 'settings', section: 'servers-build' }}
      phone={false} deploy={deploy} review={noReview} lifetime={account.accountLifetime}
      environmentActions={actions} onOpenReceipt={() => {}} /></ModalProvider>);
    const id = 'project-deployments.environment.privateSharing';
    try {
      await waitForContent(screen, 'project-deployments.environment.settings.servers-build');
      expect(screen.findByTestId(`${id}.add`)).not.toBeNull();
      const fill = async (hostPort: string) => { await act(async () => {
        screen.findByTestId(`${id}.hostPort`)!.props.onChangeText(hostPort);
        screen.findByTestId(`${id}.containerPort`)!.props.onChangeText('5432');
        screen.findByTestId(`${id}.scheme`)!.props.onChangeText('postgres'); }); };
      const saved = async (count: number) => { await screen.pressByTestIdAsync(`${id}.save`);
        await waitForHomeGovernance(() => expect(updates, JSON.stringify({ text: screen.getTextContent(),
          refusals: screen.root.findAll(node => node.props.testID === `${id}.refused`)
            .map(node => node.props.diagnosticCode).filter(Boolean) })).toHaveLength(count)); };
      const document = (index: number) => { const definition = updates[index]!.patch?.definition;
        return definition && 'document' in definition ? definition.document : ''; };
      // The deployed forwarding owner supports Happier-network exports without a joined network.
      await screen.pressByTestIdAsync(`${id}.add`);
      // The port the stored Compose service declares fills Container port (PAGE-ACCEPT-176 D29).
      await waitForHomeGovernance(() => expect(screen.findByTestId(`${id}.containerPort`)?.props.value).toBe('5432'));
      // Review sharing says what it still needs instead of staying disabled without a reason (D29).
      expect(screen.findByTestId(`${id}.needs`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.networkMissing`)).toBeNull();
      expect(screen.findByTestId(`${id}.reach:happierNetwork`)?.props.accessibilityState)
        .toMatchObject({ disabled: false, selected: true });
      expect(screen.findByTestId(`${id}.address`)).toBeNull();
      await fill('15432');
      expect(screen.findByTestId(`${id}.needs`)).toBeNull();
      await screen.pressByTestIdAsync(`${id}.review`);
      expect(updates).toHaveLength(0);
      expect(screen.findByTestId(`${id}.reviewAddress`)).toBeNull();
      await saved(1);
      expect(updates[0]!.patch?.ownServer?.serviceExports).toEqual([{ key: 'postgres', service: 'postgres',
        containerPort: 5432, scheme: 'postgres', exposure: 'loopback', transport: { kind: 'iroh' } }]);
      expect(document(0)).toContain('127.0.0.1');
      await screen.pressByTestIdAsync(`${id}.add`);
      // A joined network arrives without replacing the default; it remains an explicit choice.
      await act(async () => { storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', installationId: 'installation-a',
        daemonState: { status: 'running', reachability } })], true,
        { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
      expect(screen.findByTestId(`${id}.networkMissing`)).toBeNull();
      expect(screen.findByTestId(`${id}.address`)).toBeNull();
      await screen.pressByTestIdAsync(`${id}.reach:network:shop-net`);
      expect(screen.findByTestId(`${id}.address`)).not.toBeNull();
      await fill('15432');
      await screen.pressByTestIdAsync(`${id}.review`);
      expect(updates).toHaveLength(1);
      expect(screen.getTextContent()).toContain('100.80.0.12');
      expect(screen.getTextContent()).toContain('15432');
      await saved(2);
      expect(updates[1]!.patch?.ownServer?.serviceExports).toEqual([{ key: 'postgres', service: 'postgres',
        containerPort: 5432, scheme: 'postgres', exposure: 'privateNetwork', privateNetwork: 'shop-net' }]);
      expect(updates[1]!.patch?.definition).toMatchObject({ from: 'compose' });
      expect(document(1)).toContain('100.80.0.12');
      expect(deploy).not.toHaveBeenCalled();
    } finally { await screen.unmount(); controller.retire(); account.dispose(); }
  });

  it('links a Machine from where Deploy says it needs one, in a sheet that makes the link', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, targetLinks: [] };
    const { controller } = controllerFor({ detail });
    const { ModalProvider } = await import('@/modal');
    const { storage } = await import('@/sync/domains/state/storage');
    const { createMachineFixture } = await import('@/dev/testkit');
    storage.setState({ profileScope: { serverId: scope.serverId, accountId: scope.accountId } });
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-b', installationId: 'installation-b' })], true,
      { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const lifetime = { scope: { serverId: scope.serverId, accountId: scope.accountId }, isCurrent: () => true,
      onRetire: () => ({ dispose: () => {} }) };
    const link = vi.fn(async () => ({ ok: true as const, environmentId: detail.environment.id, revision: 2,
      targetLinkId: 'new-link', targetLinkRevision: 1 }));
    const disposition = { deleteEnvironment: vi.fn(), unlink: vi.fn(), teardown: vi.fn(), link };
    const screen = await renderScreen(
      <ModalProvider>
        <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
          accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview}
          lifetime={lifetime as never} disposition={disposition as never} onOpenReceipt={() => {}} />
      </ModalProvider>,
    );
    try {
      await screen.pressByTestIdAsync('project-deployments.environment.unavailable.noTarget.action');
      expect(screen.findByTestId('project-deployments.link')).not.toBeNull();
      expect(link).not.toHaveBeenCalled();
      await screen.pressByTestIdAsync('project-deployments.link.confirm');
      expect(link).toHaveBeenCalledWith(expect.objectContaining({
        environmentId: detail.environment.id, targetId: 'own-server', role: 'runtime',
        machines: [{ machineId: 'machine-b', installationId: 'installation-b' }],
      }), expect.objectContaining({ confirmed: true }));
      expect(screen.findByTestId('project-deployments.link')).toBeNull();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it.each(['upload', undefined] as const)('reopens a protected platform method before Send (recorded=%s)', async recorded => {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
    const { createDeploymentTargetsTestPlugin, DEPLOYMENT_TARGETS_TEST_EXECUTION } = await import('./deploymentPlatformTargetPlugin.testFixture');
    const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
    const authored = createDeploymentTargetsTestPlugin('com.example.retained-method', undefined, { upload: true });
    scope.serverId = await homes.addHome({ name: 'Retained method', serverUrl: 'https://retained-method.test',
      serverIdentityId: 'srv_retained_method', accountId: scope.accountId, currentAccount: true });
    const context = await captureLazyActionAccountContext(scope.serverId);
    const installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
      activate: api => authored.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account),
      accountLifetime: context.accountLifetime, publishProjection: true });
    const base = environmentDetailForHome();
    const detail = { ...base, targetLinks: base.targetLinks.map(row => ({ ...row,
      targetLink: { ...row.targetLink, activeDeploymentId: undefined,
        source: { kind: 'plugin' as const, contribution: { pluginId: authored.manifest.id, localId: 'beta' } },
        targetKind: 'beta', machines: [], members: [] },
      content: { credentialPrincipal: { kind: 'account' as const, accountId: scope.accountId,
        purpose: { consumer: { pluginId: authored.manifest.id, localId: 'inspect-beta' }, purpose: 'beta.manage' },
        target: { kind: 'account' as const, account: { service: { pluginId: 'com.example.cloud', localId: 'cloud-account' }, accountId: 'selected' } } },
        providerIdentity: { providerAccountId: 'cloud', providerResourceId: 'site', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' as const }, ...(recorded ? { sourceMethod: recorded } : {}) },
    })) };
    let releaseSource = () => {};
    const sourceResponse = new Promise<void>(resolve => { releaseSource = resolve; });
    await answerExistingDeploymentCheckout(detail, sourceResponse);
    await context.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
      header: { kind: 'deployment-environment.v1', title: detail.content.name }, body: JSON.stringify(detail.content) });
    for (const row of detail.targetLinks) await context.createArtifactDocument({ artifactId: row.targetLink.contentArtifactId,
      header: { kind: 'deployment-target-link.v1', title: 'Upload site' }, body: JSON.stringify(row.content) });
    homes.answer(scope.serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
      environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink) } });
    homes.answer(scope.serverId, `GET /v1/deployments/environments/${detail.environment.id}/deployments`,
      { body: { ok: true, items: [], nextCursor: null } });
    const beforeRead = homes.requests.length;
    const controller = createDeploymentReadControllerV1({ scope, transport: createDeploymentReadTransport(context.accountLifetime) });
    const deploy = vi.fn(async () => { throw Object.assign(new Error('content unavailable'), { code: 'deployment_content_unavailable' }); });
    // The shipped Overview keeps how a platform Environment deploys above Serving now (dEnvOv KEEP, owner-approved 11-13).
    const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
      demand={shown} lifetime={context.accountLifetime} accountId={scope.accountId} serverId={scope.serverId}
      phone={false} deploy={deploy} review={noReview} onOpenReceipt={() => {}} />);
    try {
      await waitForContent(screen, 'project-deployments.environment.sourceMethod');
      await act(async () => { screen.pressByTestId('project-deployments.environment.deploy'); });
      if (recorded === 'upload') {
        await vi.waitFor(() => expect(homes.requests.slice(beforeRead).some(request =>
          request.path.split('?')[0] === `/v1/projects/sources/${detail.environment.projectSourceId}`)).toBe(true));
        expect(screen.findByTestId('project-deployments.outcome.refused.other')).toBeNull();
        expect(deploy).not.toHaveBeenCalled();
        await act(async () => releaseSource());
      }
      await waitForHomeGovernance(() => expect(deploy, JSON.stringify({ text: screen.getTextContent(),
        requests: homes.requests.slice(beforeRead).map(request => `${request.method} ${request.path}`) })).toHaveBeenLastCalledWith({ environmentId: detail.environment.id,
        targetLinkId: detail.environment.runtimeTargetLinkId, sourceMethod: recorded ?? 'gitIntegration' }));
      expect(homes.requests.slice(beforeRead).filter(request =>
        request.path.split('?')[0] === `/v1/projects/sources/${detail.environment.projectSourceId}`)).toHaveLength(1);
      expect(homes.requests.slice(beforeRead).filter(request => request.path === '/v1/artifacts/read'
        && JSON.stringify(request.input).includes(detail.environment.contentArtifactId)).map(request => request.input))
        .toEqual([{ artifactIds: [detail.environment.contentArtifactId, detail.targetLinks[0]!.targetLink.contentArtifactId] }]);
      if (recorded) {
        const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
        const method = () => screen.root.findAllByType(SegmentedChoiceItem)
          .find(node => node.props.testID === 'project-deployments.environment.sourceMethod')!;
        await act(async () => method().props.onChange('gitIntegration'));
        await vi.waitFor(() => expect(method().props.value).toBe('gitIntegration'));
        await screen.pressByTestIdAsync('project-deployments.environment.deploy');
        await vi.waitFor(() => expect(deploy).toHaveBeenLastCalledWith({ environmentId: detail.environment.id,
          targetLinkId: detail.environment.runtimeTargetLinkId, sourceMethod: 'gitIntegration' }));
      }
    } finally { releaseSource(); await screen.unmount(); controller.retire(); await installed.dispose(); context.dispose(); }
  });

  it('deploys a linked platform target through the same Action input, and shows the target\'s typed refusal', async () => {
    const base = environmentDetailForHome();
    const plugin = environmentDetailForHome({
      targetLinks: base.targetLinks.map((link) => ({ ...link, targetLink: { ...link.targetLink,
        source: { kind: 'plugin' as const, contribution: { pluginId: 'vercel', localId: 'project' } },
        targetKind: 'vercel', machines: [], members: [], machineId: 'machine-a', installationId: 'installation-a' } })),
    });
    const first = controllerFor({ detail: plugin });
    const deploy = vi.fn(async () => { throw Object.assign(new Error('unsupported'), { code: 'unsupported' }); });
    const pluginScreen = await renderScreen(
      <DeploymentEnvironmentDetail controller={first.controller} environmentId={plugin.environment.id} demand={shown}
        accountId="account-owner" serverId={scope.serverId} phone={false} deploy={deploy} review={noReview} onOpenReceipt={() => {}} />,
    );
    expect(pluginScreen.findByTestId('project-deployments.environment.unavailable.noTarget')).toBeNull();
    await pluginScreen.pressByTestIdAsync('project-deployments.environment.deploy');
    expect(deploy).toHaveBeenCalledWith({ environmentId: plugin.environment.id, targetLinkId: plugin.environment.runtimeTargetLinkId });
    expect(pluginScreen.findByTestId('project-deployments.outcome.refused.unsupported')).not.toBeNull();
    first.controller.retire();

    const second = controllerFor({});
    const ownServer = await renderScreen(
      <DeploymentEnvironmentDetail controller={second.controller} environmentId={second.detail.environment.id} demand={shown}
        accountId="account-owner" serverId={scope.serverId} phone={false} deploy={deploy} review={noReview} onOpenReceipt={() => {}} />,
    );
    await ownServer.pressByTestIdAsync('project-deployments.environment.deploy');
    expect(ownServer.findByTestId('project-deployments.outcome.refused.unsupported')).not.toBeNull();
    second.controller.retire();
  });

  it('names the Compose file a refused revision lacks once, without the generic Source setup in its Details', async () => {
    const detail = environmentDetailForHome();
    const { controller } = controllerFor({ detail });
    // The daemon's file boundary refuses with these typed details (nativeComposeSource.ts).
    const deploy = vi.fn(async () => { throw new HappyError('deployment_source_unavailable', false, { code: 'deployment_source_unavailable',
      details: { kind: 'deploymentSourceFileUnavailable', path: 'compose.yaml', reason: 'absent' } }); });
    const { readDeploymentFailureRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
    const generic = readDeploymentFailureRecoveryV1('deployment_source_unavailable').remedy;
    try {
      const screen = await renderScreen(
        <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
          accountId="account-owner" serverId={scope.serverId} phone={false} deploy={deploy} review={noReview} onOpenReceipt={() => {}} />,
      );
      await screen.pressByTestIdAsync('project-deployments.environment.deploy');
      const banner = 'project-deployments.outcome.refused.other';
      await vi.waitFor(() => expect(screen.findByTestId(banner)).not.toBeNull());
      if (screen.findByTestId(`${banner}.details`)) await screen.pressByTestIdAsync(`${banner}.details`);
      const text = screen.getTextContent();
      expect(text).toContain('compose.yaml');
      expect(text).not.toContain(generic);
    } finally { controller.retire(); }
  });

  it.each([
    ['nothing deployed yet', false, null],
    ['only an older receipt', true, null],
    ['the refusal naming its failed receipt', true, 'failed-release'],
  ] as const)('opens "Read deployment logs" on the failed step\'s own receipt, never a dead control (%s)', async (_name, older, failedId) => {
    const base = environmentDetailForHome();
    // A platform target with nothing serving: logs exist only on a receipt the refusal names.
    const platform = environmentDetailForHome({
      targetLinks: base.targetLinks.map(({ targetLink: { activeDeploymentId: _serving, ...targetLink }, ...link }) => ({ ...link, targetLink: { ...targetLink,
        source: { kind: 'plugin' as const, contribution: { pluginId: 'vercel', localId: 'project' } },
        targetKind: 'vercel', machines: [], members: [], machineId: 'machine-a', installationId: 'installation-a' } })),
    });
    const { controller } = controllerFor({ detail: platform, history: older ? [createDeploymentReceiptDetailV1()] : [] });
    const opened: unknown[][] = [];
    const review = { ...noReview, openRecovery: (...args: unknown[]) => { opened.push(args); } };
    const link = platform.targetLinks[0]!.targetLink;
    // The controller's refusal names the receipt whose step failed when one was recorded.
    const deploy = vi.fn(async () => { throw new HappyError('native_failed', false, { code: 'native_failed', details: failedId ? {
      serverId: platform.environment.serverId, environmentId: platform.environment.id, targetLinkId: link.id,
      deploymentId: failedId, failure: { code: 'native_failed', phase: 'build' },
    } : undefined }); });
    const { t } = await import('@/text');
    try {
      const screen = await renderScreen(
        <DeploymentEnvironmentDetail controller={controller} environmentId={platform.environment.id} demand={shown}
          accountId="account-owner" serverId={scope.serverId} phone={false} deploy={deploy} review={review} onOpenReceipt={() => {}} />,
      );
      if (older) await waitForContent(screen, 'project-deployments.receipt.row.deployment-a');
      await screen.pressByTestIdAsync('project-deployments.environment.deploy');
      const banner = 'project-deployments.outcome.refused.other';
      await vi.waitFor(() => expect(screen.findByTestId(banner)).not.toBeNull());
      if (failedId) {
        await screen.pressByTestIdAsync(`${banner}.action`);
        expect(opened).toEqual([['logs', { deploymentId: failedId }]]);
      } else {
        // This attempt recorded no step to inspect: no dead control, and the banner says why.
        expect(screen.findByTestId(`${banner}.action`)).toBeNull();
        expect(screen.getTextContent()).not.toContain('Open the deployment logs');
        expect(screen.getTextContent()).toContain(t('projects.deployments.refusedBeforeLogs'));
      }
    } finally { controller.retire(); }
  });

  it('opens the runtime Machine\'s own setup for a missing deployment tool, in words, never the raw remedy code', async () => {
    const detail = environmentDetailForHome();
    const { controller } = controllerFor({ detail });
    const opened: unknown[][] = [];
    const review = { ...noReview, openRecovery: (...args: unknown[]) => { opened.push(args); } };
    // The Machine's missing-tool resolution answers with its typed remedy code, not a sentence (QA136-FORGE SOURCE-REVIEW).
    const deploy = vi.fn(async () => { throw new HappyError('plugin_exec_system_tool_unavailable', false, {
      code: 'plugin_exec_system_tool_unavailable',
      details: { kind: 'systemToolUnavailable', remedy: 'install_on_machine_and_add_to_daemon_path' } }); });
    try {
      const screen = await renderScreen(
        <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
          accountId="account-owner" serverId={scope.serverId} phone={false} deploy={deploy} review={review} onOpenReceipt={() => {}} />,
      );
      await screen.pressByTestIdAsync('project-deployments.environment.deploy');
      const banner = 'project-deployments.outcome.refused.other';
      await vi.waitFor(() => expect(screen.findByTestId(banner)).not.toBeNull());
      // Details stay closed: what reads is the sentence, not the code.
      expect(screen.getTextContent()).not.toContain('install_on_machine_and_add_to_daemon_path');
      await screen.pressByTestIdAsync(`${banner}.action`);
      // The fixture's one runtime Machine.
      expect(opened).toEqual([['machines', { machineId: 'machine-a' }]]);
    } finally { controller.retire(); }
  });

  it('keeps a failed receipt\'s "Read deployment logs" on that receipt, where its failed step\'s logs are', async () => {
    const base = createDeploymentReceiptDetailV1();
    const failure = { code: 'native_failed', phase: 'build' as const };
    const failed = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: 'failed-release', state: 'failed' }),
      content: DeploymentOwnServerContentV1Schema.parse({ ...base.content, failure }),
    });
    const { controller, detail } = controllerFor({ receipt: failed, history: [failed] });
    routerMock.module.router.setParams({ deploymentEnvironment: detail.environment.id, deployment: failed.deployment.id });
    try {
      const screen = await renderScreen(<ProjectDeploymentsView controller={controller} demand={shown}
        accountId="account-owner" serverId={scope.serverId} lifetime={null} sourceId="source-app" />);
      await waitForContent(screen, 'project-deployments.receipt.outcome.failed.recovery');
      routerMock.spies.setParams.mockClear();
      await screen.pressByTestIdAsync('project-deployments.receipt.outcome.failed.recovery');
      await act(async () => {});
      // It never leaves the failed step for the Environment's Overview.
      expect(routerMock.spies.setParams).not.toHaveBeenCalledWith(expect.objectContaining({ deploymentTab: 'overview' }));
      expect(screen.findByTestId('project-deployments.receipt.outcome.failed')).not.toBeNull();
    } finally { controller.retire(); }
  });

  it('says a failed read failed and offers Retry: the serving receipt and the first History page', async () => {
    const { controller: base, detail } = controllerFor({});
    base.retire();
    let receiptReads = 0;
    let historyReads = 0;
    const transport: DeploymentReadTransportV1 = {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => { historyReads += 1; return { ok: false, failure: { code: 'deployment_unavailable', retryable: true } }; },
      readReceipt: async () => { receiptReads += 1; return { ok: false, failure: { code: 'deployment_unavailable', retryable: true } }; },
    };
    const controller = createDeploymentReadControllerV1({ scope, transport });
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
        accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} />,
    );
    expect(screen.findByTestId('project-deployments.environment.serving.error')).not.toBeNull();
    const before = receiptReads;
    await screen.pressByTestIdAsync('project-deployments.environment.serving.error.retry');
    expect(receiptReads).toBeGreaterThan(before);
    await selectEnvironmentTab(screen, 'history');
    expect(screen.findByTestId('project-deployments.environment.history.error')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain('No deployments yet');
    expect(historyReads).toBeGreaterThan(0);
    controller.retire();
  });

  it('keeps a superseded "Running, not verified" History row quiet; only what serves now says it (PAGE-ACCEPT-176 D17)', async () => {
    const { controller: base, detail, receipt } = controllerFor({});
    base.retire();
    const past = { ...receipt.deployment, id: 'deployment-superseded', state: 'running_unverified' as const, title: 'Deployed' };
    const transport: DeploymentReadTransportV1 = {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [past], nextCursor: null } }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    };
    const controller = createDeploymentReadControllerV1({ scope, transport });
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
        accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} />,
    );
    await selectEnvironmentTab(screen, 'history');
    const rowId = `project-deployments.receipt.row.${past.id}`;
    await waitForContent(screen, rowId);
    const { Item } = await import('@/components/ui/lists/Item');
    expect(screen.findAllByType(Item).find(row => row.props.testID === rowId)?.props.subtitle).toBeUndefined();
    controller.retire();
  });

  it('pages History on request only: one read per page, Older reads the next cursor, Newer returns', async () => {
    const { controller: base, detail, receipt } = controllerFor({});
    base.retire();
    const cursors: (string | undefined)[] = [];
    const transport: DeploymentReadTransportV1 = {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async (_scope, _id, query) => {
        cursors.push(query.cursor);
        return { ok: true, value: { ok: true, items: [receipt.deployment], nextCursor: query.cursor ? null : 'page-2' } };
      },
      readReceipt: async () => ({ ok: true, value: receipt }),
    };
    const controller = createDeploymentReadControllerV1({ scope, transport });
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
        accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} />,
    );
    await selectEnvironmentTab(screen, 'history');
    expect(cursors).toEqual([undefined]);
    expect(screen.findByTestId('project-deployments.environment.history.newer')).toBeNull();
    await screen.pressByTestIdAsync('project-deployments.environment.history.older');
    expect(cursors).toEqual([undefined, 'page-2']);
    expect(screen.findByTestId('project-deployments.environment.history.older')).toBeNull();
    expect(screen.findByTestId('project-deployments.environment.history.newer')).not.toBeNull();
    controller.retire();
  });

  // Skipped (UI8A round 2): the row menu's popover rows are not reachable under renderScreen yet; round 3 drives
  // this through the menu harness. K1's own editor test covers the Both pair; this proves the page's one write.
  it.skip('changes a variable to Both and saves the pair in one bindings write', async () => {
    const base = environmentDetailForHome();
    const runtime = { purpose: 'variable' as const, name: 'LOG_LEVEL', phase: 'runtime' as const,
      source: { kind: 'value' as const, value: 'info' } };
    const detail = environmentDetailForHome({
      environment: environmentHeaderForHome({
        capabilities: { ...base.environment.capabilities, manageBindings: true },
      }),
      content: { ...base.content, bindings: [runtime] },
    });
    const { controller } = controllerFor({ detail });
    const lifetime = { scope: { serverId: scope.serverId, accountId: scope.accountId }, isCurrent: () => true,
      onRetire: () => ({ dispose: () => {} }) };
    const setBindings = vi.fn(async (input: { environmentId: string; expectedRevision: number; content: { bindings: readonly unknown[] } }) =>
      ({ ok: true as const, environmentId: input.environmentId, revision: input.expectedRevision + 1 }));
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
        accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}}
        lifetime={lifetime as never} setBindings={setBindings as never} />,
    );
    await selectEnvironmentTab(screen, 'variables');
    expect(screen.findByTestId('project-deployments.environment.variables.save')).toBeNull();
    // The test renders before measurement, so the Collection rests as the list: its ⋯ holds "Used at".
    await screen.pressByTestIdAsync('project-deployments.environment.variable.LOG_LEVEL.menu');
    await screen.pressByTestIdAsync('project-deployments.environment.variable.LOG_LEVEL.menu.phase.both');
    await screen.pressByTestIdAsync('project-deployments.environment.variables.save');
    expect(setBindings).toHaveBeenCalledTimes(1);
    const written = setBindings.mock.calls[0]![0];
    expect(written.expectedRevision).toBe(detail.environment.revision);
    expect(written.content.bindings).toEqual(expect.arrayContaining([
      { ...runtime, phase: 'build' }, runtime,
    ]));
    expect(written.content.bindings).toHaveLength(2);
    controller.retire();
  });
});

describe('Deployment receipt header actions', () => {
  const running = (cancellable: boolean | undefined) => {
    const base = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: 'running-release', state: 'running', revision: 4, settledAtMs: undefined }),
      content: base.content,
    });
    return cancellable === undefined ? receipt : { ...receipt, cancellable };
  };
  const receiptProps = {
    environmentName: 'Staging', demand: shown, accountId: 'account-owner', onBack: () => {},
    rollback: null, review: noReview, onOpenReceipt: () => {}, phone: false, linkPath: null,
    serverId: scope.serverId, readLogs: null,
  } as const;

  it.each([[true, true], [false, false], [undefined, false]] as const)(
    'offers Cancel on a running receipt only when the receipt read says it is cancellable (%s)', async (cancellable, offered) => {
      const { controller, detail, receipt } = controllerFor({ receipt: running(cancellable) as never });
      try {
        const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
          environmentId={detail.environment.id} deploymentId={receipt.deployment.id}
          cancel={async () => ({ ok: false as const, error: 'deployment_conflict' }) as never} deploy={null} />);
        await act(async () => { await waitForTestEvent(screen.subscribe,
          () => screen.findByTestId('project-deployments.receipt.header'), node => node !== null); });
        expect(screen.findByTestId('project-deployments.receipt.cancel') !== null).toBe(offered);
      } finally { controller.retire(); }
    });

  it('cancels with the receipt revision it showed, and says a refusal where Cancel was pressed', async () => {
    const { controller, detail, receipt } = controllerFor({ receipt: running(true) as never });
    const cancel = vi.fn(async () => ({ ok: false as const, error: 'deployment_conflict' }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} cancel={cancel as never} deploy={null} />);
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt.cancel'), node => node !== null); });
      await screen.pressByTestIdAsync('project-deployments.receipt.cancel');
      expect(cancel).toHaveBeenCalledWith({ environmentId: detail.environment.id, deploymentId: 'running-release',
        expectedReceiptRevision: 4 });
      expect(screen.findByTestId('project-deployments.outcome.refused.other')).not.toBeNull();
    } finally { controller.retire(); }
  });

  it('keeps a refused rollback\'s typed code out of its sentence and behind Details', async () => {
    const base = environmentDetailForHome();
    const current = base.targetLinks[0]!;
    const old = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'old-deployment' }) });
    const { controller, detail } = controllerFor({ receipt: old, detail: {
      ...base, targetLinks: [{ ...current, targetLink: { ...current.targetLink,
        id: 'retained-predecessor', activeDeploymentId: old.deployment.id } }, current],
    } });
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={old.deployment.id} cancel={null} deploy={null}
        rollback={async () => ({ ok: false as const, error: 'machine_target_not_current' }) as never} />);
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt.rollback'), node => node !== null); });
      await screen.pressByTestIdAsync('project-deployments.receipt.rollback');
      const banner = 'project-deployments.outcome.refused.other';
      expect(screen.findByTestId(banner)).not.toBeNull();
      expect(screen.getTextContent()).not.toContain('machine_target_not_current');
      await screen.pressByTestIdAsync(`${banner}.details`);
      expect(screen.getTextContent()).toContain('machine_target_not_current');
    } finally { controller.retire(); }
  });

  it.each(['failed', 'outcome_unknown'] as const)('retries a failed teardown through the teardown Action instead of deploying its source again (%s)', async state => {
    const { ModalProvider } = await import('@/modal');
    const homeIdentity = `srv_${'e'.repeat(32)}`;
    scope.serverId = await homes.addHome({ name: 'Teardown retry', serverUrl: 'https://teardown-retry.test',
      serverIdentityId: homeIdentity, accountId: scope.accountId, currentAccount: true });
    const detail = environmentDetailForHome();
    const link = detail.targetLinks[0]!.targetLink;
    const { machineId, installationId } = link.members[0]!;
    const member = { machineId, installationId };
    const base = createDeploymentReceiptDetailV1();
    const storedIntent = { kind: 'stored' as const, document: 'services:\n  app:\n    image: app:tested\n',
      contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app'] };
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: 'failed-teardown', operation: 'teardown', state,
        requestKey: 'teardown-retry-original' }),
      content: { ...base.content, sourceIntent: state === 'outcome_unknown' ? storedIntent : base.content.sourceIntent,
        teardown: { reason: 'decommission', targetLinkRevision: link.revision,
        machines: [member], resources: [{ id: 'retained-workload', kind: 'workload', machineId: member.machineId,
          ownership: 'owned', disposition: 'remove' }], proofs: [{ ...member, step: 'removeTarget',
          state, reason: state === 'outcome_unknown' ? 'removal_unproved' : 'native_route_unavailable', resources: [] }] } },
    });
    const { controller } = controllerFor({ detail, receipt });
    const { createDeploymentActions } = await import('./deploymentActions');
    await answerDeploymentSource(detail);
    homes.answer(scope.serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
      ok: true, environment: { ...detail.environment, serverId: homeIdentity },
      targetLinks: detail.targetLinks.map(row => row.targetLink),
    } });
    const beforeTeardowns = homes.requestsFor('/v1/actions/deployments.teardown').length;
    const beforeDeploys = homes.requestsFor('/v1/actions/deployments.deploy').length;
    await answerTeardownController(detail.environment.controllerMachineId, input => {
      expect(input).toMatchObject({ environmentId: detail.environment.id,
        targetLinkId: receipt.deployment.targetLinkId, requestKey: receipt.deployment.requestKey, reason: receipt.content.teardown!.reason });
      return { ok: true, environmentId: detail.environment.id, revision: 4,
        deploymentId: receipt.deployment.id, deploymentRevision: 1, state: 'running' };
    });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    routerMock.module.router.setParams({ deploymentEnvironment: detail.environment.id, deployment: receipt.deployment.id });
    try {
      const screen = await renderScreen(<ModalProvider><ProjectDeploymentsView controller={controller} demand={shown} lifetime={lifetime}
        serverId={scope.serverId} accountId={scope.accountId} sourceId={scope.projectSourceId}
        actions={createDeploymentActions(lifetime, scope.projectSourceId)} /></ModalProvider>);
      await waitForContent(screen, 'project-deployments.receipt.deployAgain');
      const { Modal } = await import('@/modal');
      vi.mocked(Modal.confirm).mockClear();
      await screen.pressByTestIdAsync('project-deployments.receipt.deployAgain');
      await waitForHomeGovernance(() => {
        const requests = homes.requestsFor('/v1/actions/deployments.teardown').length - beforeTeardowns
          + homes.requestsFor('/v1/actions/deployments.deploy').length - beforeDeploys;
        expect(requests > 0 || screen.findByTestId('project-deployments.outcome.refused.other') !== null).toBe(true);
      });
      if (screen.findByTestId('project-deployments.outcome.refused.other.details')) {
        await screen.pressByTestIdAsync('project-deployments.outcome.refused.other.details');
      }
      await waitForHomeGovernance(() => {
        const teardowns = homes.requestsFor('/v1/actions/deployments.teardown').length - beforeTeardowns;
        const deploys = homes.requestsFor('/v1/actions/deployments.deploy').length - beforeDeploys;
        expect(teardowns + deploys, screen.getTextContent()).toBeGreaterThan(0);
        expect({ teardowns, deploys }).toEqual({ teardowns: 1, deploys: 0 });
      });
      expect(Modal.confirm).not.toHaveBeenCalled();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('deploys a failed receipt\'s own commit again through the Environment\'s runtime link', async () => {
    const base = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: 'failed-release', state: 'failed' }),
      content: base.content,
    });
    const { controller, detail } = controllerFor({ receipt });
    const deploy = vi.fn(async () => ({ ok: false as const, error: 'deployment_conflict' }));
    const sha = base.content.sourceIntent.kind === 'repository' ? base.content.sourceIntent.sha : null;
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} cancel={null} deploy={deploy as never} />);
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt.outcome.failed.action'), node => node !== null); });
      await screen.pressByTestIdAsync('project-deployments.receipt.outcome.failed.action');
      expect(sha).not.toBeNull();
      expect(deploy).toHaveBeenCalledWith({ environmentId: detail.environment.id, targetLinkId: 'target-link', sha });
    } finally { controller.retire(); }
  });
});

describe('Deployment receipt step logs', () => {
  const receiptProps = {
    environmentName: 'Staging', demand: shown, accountId: 'account-owner', onBack: () => {},
    rollback: null, cancel: null, deploy: null, review: noReview, onOpenReceipt: () => {}, phone: false, linkPath: null,
    serverId: 'home',
  } as const;
  const page = (text: string) => ({ kind: 'page' as const, page: { sourceRevision: 'source-a', text,
    nextCursor: { sourceRevision: 'source-a', token: String(text.length) }, truncated: false } });
  /** The admitted Logs read echoes the read target it was asked for. */
  const logsRead = (input: Parameters<DeploymentReadLogs>[0], text: string) => ({ ok: true as const, kind: 'build' as const,
    environmentId: input.environmentId, deploymentId: input.deploymentId, targetLinkId: input.targetLinkId,
    machineId: input.machineId, installationId: input.installationId, logs: page(text) });
  /** A native receipt whose sink recorded each step's range in the one masked operation file (DEP-43). */
  const withStepLogs = (state: 'failed' | 'running') => {
    const base = createDeploymentReceiptDetailV1();
    const steps = state === 'failed'
      ? [{ id: 'source', label: 'Sync', state: 'succeeded' as const, durationMs: 4_000 },
        { id: 'activate', label: 'Roll out', state: 'failed' as const, durationMs: 14_000 },
        { id: 'route', label: 'Route', state: 'skipped' as const }]
      : [{ id: 'source', label: 'Sync', state: 'succeeded' as const, durationMs: 4_000 },
        { id: 'build', label: 'Build', state: 'running' as const },
        { id: 'activate', label: 'Roll out', state: 'pending' as const }];
    return createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: `${state}-release`, state,
        ...(state === 'running' ? { settledAtMs: undefined } : {}) }),
      content: { ...base.content, steps, machineResults: [], ownServer: {
        approvedInputBasis: {
          v: 1, environmentId: 'environment-a', environmentRevision: 1, targetLinkId: 'target-link', targetLinkRevision: 1,
          sourceIntent: base.content.sourceIntent, manifestFingerprint: 'manifest', configInputDigests: [],
          physicalProjectName: 'app', toolVersion: '2.40.1', services: ['web'], profiles: [],
          members: [{ machineId: 'machine-a', installationId: 'installation-a' }], bindings: [], images: [],
        },
        stageLogs: [{ machineId: 'machine-a', installationId: 'installation-a', relativePath: '.happier/deploy.log',
          excerpt: { text: 'operation tail', truncated: true },
          steps: [{ ref: 'source', range: { start: 0, end: 40 } },
            { ref: state === 'failed' ? 'activate' : 'build', range: { start: 40, end: null } }] }],
      } } as never,
    });
  };
  const settle = (screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) => act(async () => {
    await waitForTestEvent(screen.subscribe, () => screen.findByTestId(testID), node => node !== null);
  });

  it('reads a failed Receipt’s recorded cause even when its live logs need the Machine online', async () => {
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const runtime = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { t } = await import('@/text');
    const previousRuntime = runtime.getAppliedActiveServerSnapshot();
    const previousAvailable = runtime.isAppliedActiveServerRuntimeAvailable();
    const base = withStepLogs('failed');
    const receipt = createDeploymentReceiptDetailV1({
      deployment: base.deployment,
      content: { ...base.content, steps: [], failure: { code: 'native_activate_failed', phase: 'activate', failureCause: {
        phase: 'deployment.native.activate', errorClass: 'HttpStatusError', errorCode: 'upstream_error', httpStatus: 503,
      } } },
    });
    const { controller, detail } = controllerFor({ receipt });
    const readLogs = vi.fn<DeploymentReadLogs>(async () => ({ ok: false, error: 'action_failed' }));
    runtime.publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    try {
      await publishMachineInventoryForTest(scope, [createMachineFixture({ id: 'machine-a', active: false, activeAt: 1 })]);
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs} />);
      try {
        await settle(screen, 'project-deployments.receipt.outcome.failed');
        const banner = screen.findByTestId('project-deployments.receipt.outcome.failed')!;
        const bannerText = banner.findAll(node => typeof node.type === 'string')
          .flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ');
        expect.soft(bannerText).toContain(t('errors.serverError'));
        const log = 'project-deployments.receipt.steps.log';
        await waitForHomeGovernance(() => {
          expect(screen.findByTestId(`${log}.offline`)).not.toBeNull();
          expect(screen.getTextContent()).toContain('Live logs need');
        });
        expect(screen.findByTestId(`${log}.error`)).toBeNull();
      } finally { await screen.unmount(); }
    } finally {
      controller.retire();
      runtime.publishAppliedActiveServerSnapshot(previousRuntime, previousAvailable);
    }
  });

  it.each([false, true])('shows the running deploy in Build logs with a serving deployment: %s', async (hasServing) => {
    const base = environmentDetailForHome();
    const detail = hasServing ? base : { ...base, targetLinks: base.targetLinks.map(row => ({ ...row,
      targetLink: { ...row.targetLink, activeDeploymentId: undefined } })) };
    const receipt = withStepLogs('running');
    const { controller } = controllerFor({ detail, receipt, history: [receipt] });
    const readLogs = vi.fn<DeploymentReadLogs>(async input => logsRead(input, 'current deploy output'));
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller}
        environmentId={detail.environment.id} demand={shown} accountId={scope.accountId} serverId={scope.serverId}
        phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} readLogs={readLogs} />);
      await waitForContent(screen, 'project-deployments.environment.menu');
      expect(readLogs).not.toHaveBeenCalled();
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.logs');
      await screen.pressByTestIdAsync('project-deployments.environment.menu.logs');
      await waitForContent(screen, 'environment-logs.header');
      await screen.pressByTestIdAsync('environment-logs.view:build');
      await waitForContent(screen, 'environment-logs.build.steps.log.lines');
      expect(screen.findByTestId('environment-logs.empty')).toBeNull();
      expect(screen.getTextContent()).toContain('current deploy output');
      expect(readLogs.mock.calls[0]?.[0]).toMatchObject({ deploymentId: receipt.deployment.id, ref: 'build', tail: true });
    } finally { await act(async () => { controller.retire(); }); }
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)('stops retained step activity when the receipt is %s', async (state) => {
    const base = withStepLogs('running');
    const receipt = createDeploymentReceiptDetailV1({ ...base,
      deployment: createDeploymentReceiptHeaderV1({ ...base.deployment, state, settledAtMs: 2_000 }),
    });
    for (const readable of [true, false]) {
      const { controller, detail } = controllerFor({ receipt });
      const readLogs = readable ? async (input: Parameters<DeploymentReadLogs>[0]) => logsRead(input, 'retained log') : null;
      try {
        const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
          environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs} />);
        await settle(screen, 'project-deployments.receipt.step-row-build-status-slot');
        expect(screen.findByTestId('project-deployments.receipt.step-row-build-status-slot')!
          .findAllByType(ActivitySpinner)).toHaveLength(0);
        expect(screen.findByTestId('project-deployments.receipt.steps.follow')).toBeNull();
        await screen.unmount();
      } finally { controller.retire(); }
    }
  });

  it.each([true, false])('uses operation log availability when retained receipt steps are empty (logs=%s)', async (available) => {
    const base = withStepLogs('failed');
    const receipt = createDeploymentReceiptDetailV1({
      deployment: { ...base.deployment, state: 'running_unverified' },
      content: { ...base.content, steps: [], machineResults: [{ machineId: 'machine-a',
        installationId: 'installation-a', activation: 'succeeded', health: 'unverified', steps: [] }],
        ownServer: { ...base.content.ownServer!, stageLogs: available ? base.content.ownServer!.stageLogs : [] } },
    });
    const { controller, detail } = controllerFor({ receipt });
    // The Action transport boundary returns the same masked operation page as the live read.
    const readLogs = vi.fn(async () => ({ ok: true as const, logs: page('retained masked build lines') }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs as never} />);
      await settle(screen, available ? 'project-deployments.receipt.steps' : 'project-deployments.receipt.header');
      // The receipt's only log is the page's content: it opens on arrival, with no disclosure row to press.
      expect(screen.findByTestId('project-deployments.receipt.step-row-build-log.machine-a.installation-a')).toBeNull();
      if (available) {
        await settle(screen, 'project-deployments.receipt.steps.log.lines');
        expect(screen.getTextContent()).toContain('retained masked build lines');
        expect(readLogs.mock.calls[0]).toEqual([{ kind: 'build', environmentId: receipt.deployment.environmentId,
          deploymentId: receipt.deployment.id, targetLinkId: receipt.deployment.targetLinkId,
          machineId: 'machine-a', installationId: 'installation-a', tail: true }]);
      } else {
        // No steps and no log: the block is left out rather than drawn empty (lab d3).
        const block = screen.findByTestId('project-deployments.receipt.steps');
        expect(block?.findAll((node) => typeof node.type === 'string') ?? []).toHaveLength(0);
        expect(screen.findByTestId('project-deployments.receipt.steps.toolbar')).toBeNull();
      }
    } finally { controller.retire(); }
  });

  it('opens the first of several logs on arrival when the receipt recorded no steps', async () => {
    const base = withStepLogs('failed');
    const stageLog = base.content.ownServer!.stageLogs![0]!;
    const receipt = createDeploymentReceiptDetailV1({
      deployment: { ...base.deployment, state: 'running_unverified' },
      content: { ...base.content, steps: [], machineResults: [], ownServer: { ...base.content.ownServer!,
        stageLogs: [stageLog, { ...stageLog, machineId: 'machine-b', installationId: 'installation-b' }] } },
    });
    const { controller, detail } = controllerFor({ receipt });
    const readLogs = vi.fn(async (_input: Readonly<Record<string, unknown>>) => ({ ok: true as const, logs: page('first machine lines') }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs as never} />);
      await settle(screen, 'project-deployments.receipt.steps.log.lines');
      expect(readLogs).toHaveBeenCalledTimes(1);
      expect(readLogs.mock.calls[0]![0]).toMatchObject({ machineId: 'machine-a', installationId: 'installation-a' });
      expect(screen.findByTestId('project-deployments.receipt.step-row-build-log.machine-b.installation-b')).not.toBeNull();
    } finally { controller.retire(); }
  });

  it('opens the failed step\'s own masked log by its ref, and another step reads only its own', async () => {
    const { controller, detail, receipt } = controllerFor({ receipt: withStepLogs('failed') });
    const readLogs = vi.fn(async (input: { ref?: string }) => ({ ok: true as const, logs: page(`lines of ${input.ref}`) }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs as never} />);
      await settle(screen, 'project-deployments.receipt.steps.log.lines');
      expect(readLogs).toHaveBeenCalledTimes(1);
      expect(readLogs.mock.calls[0]![0]).toMatchObject({ kind: 'build', ref: 'activate', tail: true,
        machineId: 'machine-a', installationId: 'installation-a', deploymentId: 'failed-release' });
      expect(screen.getTextContent()).toContain('lines of activate');
      // The step refs supersede the operation tail; the operation log is never shown in their place.
      expect(screen.findByTestId('project-deployments.receipt.log')).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.receipt.step-row-source');
      await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.getTextContent(),
        text => text.includes('lines of source')); });
      expect(readLogs.mock.calls.map(([input]) => input.ref)).toEqual(['activate', 'source']);
      // A step without a ref of its own is a plain row: nothing to open, nothing read.
      const route = screen.findByTestId('project-deployments.receipt.step-row-route')!;
      expect(route.props.onPress ?? route.props.onClick).toBeUndefined();
      expect(readLogs).toHaveBeenCalledTimes(2);
    } finally { controller.retire(); }
  });

  it('narrows to the failed steps from the receipt\'s own step states', async () => {
    const { controller, detail, receipt } = controllerFor({ receipt: withStepLogs('failed') });
    const readLogs = vi.fn(async () => ({ ok: true as const, logs: page('masked') }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs as never} />);
      await settle(screen, 'project-deployments.receipt.steps.filter:failed');
      expect(screen.findByTestId('project-deployments.receipt.step-row-source')).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.receipt.steps.filter:failed');
      expect(screen.findByTestId('project-deployments.receipt.step-row-source')).toBeNull();
      expect(screen.findByTestId('project-deployments.receipt.step-row-route')).toBeNull();
      expect(screen.findByTestId('project-deployments.receipt.step-row-activate')).not.toBeNull();
      // Nothing to follow once the deploy settled.
      expect(screen.findByTestId('project-deployments.receipt.steps.follow')).toBeNull();
    } finally { controller.retire(); }
  });

  it.each([
    ['unavailable', { kind: 'unavailable' as const, reason: 'unavailable' as const }, 'project-deployments.receipt.steps.log.unavailable'],
    ['source-changed', { kind: 'source-changed' as const, sourceRevision: 'source-b' }, 'project-deployments.receipt.steps.log.sourceChanged'],
  ] as const)('says when the step log is %s and reads it again on request', async (_kind, answer, testID) => {
    const { controller, detail, receipt } = controllerFor({ receipt: withStepLogs('failed') });
    let next: unknown = answer;
    const readLogs = vi.fn(async () => ({ ok: true as const, logs: next }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs as never} />);
      await settle(screen, testID);
      next = page('read again');
      await screen.pressByTestIdAsync(`${testID}-action`);
      await settle(screen, 'project-deployments.receipt.steps.log.lines');
      expect(readLogs).toHaveBeenCalledTimes(2);
      expect(screen.getTextContent()).toContain('read again');
    } finally { controller.retire(); }
  });

  it('follows only a running step, and Follow turns off and on', async () => {
    const { controller, detail, receipt } = controllerFor({ receipt: withStepLogs('running') });
    const readLogs = vi.fn(async (input: { ref?: string }) => ({ ok: true as const, logs: page(`lines of ${input.ref}`) }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs as never} />);
      await settle(screen, 'project-deployments.receipt.steps.follow');
      expect(screen.findByTestId('project-deployments.receipt.step-row-build-status-slot')!
        .findAllByType(ActivitySpinner)).toHaveLength(1);
      expect(readLogs.mock.calls[0]![0]).toMatchObject({ ref: 'build', tail: true });
      const follow = () => screen.findByTestId('project-deployments.receipt.steps.follow')!;
      const following = follow().props.accessibilityLabel;
      await screen.pressByTestIdAsync('project-deployments.receipt.steps.follow');
      expect(follow().props.accessibilityLabel).not.toBe(following);
      await screen.pressByTestIdAsync('project-deployments.receipt.steps.follow');
      expect(follow().props.accessibilityLabel).toBe(following);
      // A finished step's log cannot grow: opening it offers no Follow.
      await screen.pressByTestIdAsync('project-deployments.receipt.step-row-source');
      await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.getTextContent(),
        text => text.includes('lines of source')); });
      expect(screen.findByTestId('project-deployments.receipt.steps.follow')).toBeNull();
    } finally { controller.retire(); }
  });
});

describe('Environment Overview attention and status (L-A, DEPLOY-COMPOSE P1)', () => {
  const render = (controller: ReturnType<typeof createDeploymentReadControllerV1>, detail: { environment: { id: string } }, onOpenReceipt = (_id: string) => {}) =>
    renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
      accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview} onOpenReceipt={onOpenReceipt} />);
  const healthOf = (base: ReturnType<typeof environmentDetailForHome>, status: 'down' | 'degraded') => ({
    v: 1 as const, environmentId: base.environment.id, targetLinkId: base.environment.runtimeTargetLinkId!,
    protection: base.environment.protection, status, n: 1, down: status === 'down' ? 1 : 0, degraded: status === 'degraded' ? 1 : 0,
    unknown: 0, members: [], affectedMachineIds: [], edgeUnreachable: false, authoritativeRecovery: false,
  });

  it('shows one notice when several things are wrong: the failed latest deploy, which opens its receipt', async () => {
    const base = environmentDetailForHome();
    const servingId = base.targetLinks.find(row => row.targetLink.id === base.environment.runtimeTargetLinkId)!.targetLink.activeDeploymentId!;
    const serving = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: servingId, state: 'running_unverified' }) });
    const failed = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'latest-failed', state: 'failed' }),
      content: { ...serving.content, failure: { code: 'machine_target_not_current', phase: 'admission' } } });
    const { controller, detail } = controllerFor({ receipt: serving, history: [failed, serving],
      detail: { ...base, healthAggregate: healthOf(base, 'degraded') } });
    const opened: string[] = [];
    try {
      const screen = await render(controller, detail, id => { opened.push(id); });
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.environment.attention.latestFailed')).not.toBeNull());
      expect(screen.findByTestId('project-deployments.environment.attention.unhealthy')).toBeNull();
      expect(screen.findByTestId('project-deployments.environment.serving.notice.running_unverified')).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.environment.attention.latestFailed.action');
      expect(opened).toEqual(['latest-failed']);
    } finally { controller.retire(); }
  });

  it('says jobs and alerts are paused while the controller is offline, and nothing when its presence is unknown', async () => {
    const base = environmentDetailForHome();
    for (const [state, shownNotice] of [['paused', true], ['unknown', false]] as const) {
      const { controller, detail } = controllerFor({ detail: { ...base,
        controller: { machineId: base.environment.controllerMachineId, state } } });
      try {
        const screen = await render(controller, detail);
        await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.environment.serving')).not.toBeNull());
        expect(screen.findByTestId('project-deployments.environment.attention.controllerPaused') !== null).toBe(shownNotice);
      } finally { controller.retire(); }
    }
  });

  it('keeps the Health fact when the serving version also has a health notice', async () => {
    const base = environmentDetailForHome();
    const servingId = base.targetLinks.find(row => row.targetLink.id === base.environment.runtimeTargetLinkId)!.targetLink.activeDeploymentId!;
    const serving = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: servingId, state: 'running_unverified' }),
    });
    const { controller, detail } = controllerFor({ detail: base, receipt: serving });
    const screen = await render(controller, detail);
    try {
      await waitForContent(screen, 'project-deployments.environment.serving.notice.running_unverified');
      expect(screen.findByTestId('project-deployments.environment.facts.health')).not.toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('shows a reason for Environment and receipt agent actions on a known offline Controller', async () => {
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const runtime = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const previousRuntime = runtime.getAppliedActiveServerSnapshot();
    const previousAvailable = runtime.isAppliedActiveServerRuntimeAvailable();
    const base = environmentDetailForHome();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ state: 'failed' }),
    });
    const { controller, detail } = controllerFor({ detail: base, receipt });
    const { t } = await import('@/text');
    const machineId = detail.environment.controllerMachineId;
    runtime.publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    try {
      await publishMachineInventoryForTest(scope, [createMachineFixture({ id: machineId, active: false, activeAt: 1 })]);
      const overview = await render(controller, detail);
      try {
        await waitForContent(overview, 'investigation.agentActions.unavailable');
        expect(overview.getTextContent()).toContain(t('inbox.work.healthNotice.agentActionsNeedMachine'));
        expect(overview.findByTestId('investigation.agentActions.unavailable-action')?.props.accessibilityLabel)
          .toBe(t('common.retry'));
      } finally { await overview.unmount(); }
      const failed = await renderScreen(<DeploymentReceiptDetail controller={controller}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} environmentName={detail.content.name} demand={shown}
        accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        rollback={null} cancel={null} linkPath={null} readLogs={null} onBack={() => {}} review={noReview} onOpenReceipt={() => {}} />);
      try {
        await waitForContent(failed, 'investigation.agentActions.unavailable');
        expect(failed.getTextContent()).toContain(t('inbox.work.healthNotice.agentActionsNeedMachine'));
        expect(failed.findByTestId('project-deployments.receipt.investigate')).toBeNull();
        const retry = 'investigation.agentActions.unavailable-action';
        expect(failed.findByTestId(retry)?.props.accessibilityLabel).toBe(t('common.retry'));
        await failed.pressByTestIdAsync(retry);
        expect(failed.getTextContent()).toContain(t('inbox.work.healthNotice.agentActionsNeedMachine'));
        await act(async () => {
          await publishMachineInventoryForTest(scope, [createMachineFixture({ id: machineId, active: true, activeAt: Date.now() })]);
        });
        await waitForHomeGovernance(() => {
          expect(failed.getTextContent()).toContain(t('inbox.work.healthNotice.agentActionsUnavailable'));
          expect(failed.getTextContent()).toContain(t('common.retry'));
        });
      } finally { await failed.unmount(); }
    } finally {
      controller.retire();
      runtime.publishAppliedActiveServerSnapshot(previousRuntime, previousAvailable);
    }
  });

  it.each([
    { page: 'Receipt', state: 'loading', reason: 'agentActionsLoading' },
    { page: 'Receipt', state: 'plugin_action_generation_retired', reason: 'agentActionsUnavailable' },
    { page: 'Receipt', state: 'agent_unavailable', reason: 'agentActionsNeedAgent' },
    { page: 'Receipt', state: 'empty', reason: 'agentActionsNotConfigured' },
    { page: 'Environment', state: 'loading', reason: 'agentActionsLoading' },
    { page: 'Environment', state: 'contributed_action_unavailable', reason: 'agentActionsUnavailable' },
  ] as const)('$page shows a quiet agent catalog $state reason with Retry', async ({ page, state, reason }) => {
    const { createDeferred } = await import('@/dev/testkit');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    const { TRIAGE_FAILURE_TEST_BINDING } = await import('@/dev/testkit/harness/triageFailureActionBoundary');
    const { createPluginPagePlacementFixture } = await import('@/dev/testkit/fixtures/pluginPageProjectionFixture');
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const runtime = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { AgentActionButton } = await import('@happier-dev/plugin-ui/components');
    const { t } = await import('@/text');
    const previousRuntime = runtime.getAppliedActiveServerSnapshot();
    const previousAvailable = runtime.isAppliedActiveServerRuntimeAvailable();
    const base = environmentDetailForHome();
    const receipt = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ state: 'failed' }) });
    const { controller, detail } = controllerFor({ detail: base, receipt });
    const machineId = detail.environment.controllerMachineId;
    const placement = createPluginPagePlacementFixture({ pluginId: TRIAGE_FAILURE_TEST_BINDING.pluginId, localId: 'triage', title: 'Triage', targetKind: 'app' });
    const unpublish = publishCommittedAppShellPluginUiProjection(() => ({ ...EMPTY_PLUGIN_UI_PROJECTION,
      surfacePlacementsById: { [placement.id]: { ...placement, failureActions: { action: TRIAGE_FAILURE_TEST_BINDING.action } } } }));
    const heldRead = createDeferred<ActionExecuteResult>();
    const available: ActionExecuteResult = { ok: true, result: { v: 1, kind: 'choices', defaultActionId: 'investigate',
      actions: [{ label: 'Investigate', forSubject: true, selection: { configuredActionId: 'investigate',
        sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'configured' } }] } };
    let reads = 0;
    let retry = false;
    contributedFailureRead.answer = async () => {
      reads++;
      if (retry) return available;
      if (state === 'loading') return heldRead.promise;
      if (state === 'empty') return { ok: true, result: { v: 1, kind: 'choices', defaultActionId: null, actions: [] } };
      return { ok: false, errorCode: state, error: state };
    };
    runtime.publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      await publishMachineInventoryForTest(scope, [createMachineFixture({ id: machineId, active: true, activeAt: Date.now() })]);
      screen = page === 'Environment' ? await render(controller, detail) : await renderScreen(<DeploymentReceiptDetail controller={controller}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} environmentName={detail.content.name} demand={shown}
        accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        rollback={null} cancel={null} linkPath={null} readLogs={null} onBack={() => {}} review={noReview} onOpenReceipt={() => {}} />);
      const mounted = screen;
      await waitForContent(mounted, page === 'Receipt' ? 'project-deployments.receipt.outcome.failed' : 'project-deployments.environment.menu');
      await waitForHomeGovernance(() => expect(reads).toBeGreaterThan(0));
      const line = `investigation.agentActions.${state === 'loading' ? 'loading' : 'unavailable'}`;
      await waitForHomeGovernance(() => {
        expect(mounted.findByTestId(line)).not.toBeNull();
        expect(mounted.getTextContent()).toContain(t(`inbox.work.healthNotice.${reason}`));
      });
      expect(mounted.findByTestId(`${line}-action`)?.props.accessibilityLabel).toBe(t('common.retry'));
      expect(mounted.findAllByType(AgentActionButton)).toHaveLength(0);
      expect(mounted.findByTestId('project-deployments.receipt.investigate')).toBeNull();
      retry = true;
      await mounted.pressByTestIdAsync(`${line}-action`);
      await waitForHomeGovernance(() => {
        expect(mounted.findAllByType(AgentActionButton).map(button => [button.props.title, Boolean(button.props.disabled)]))
          .toEqual([['Investigate', false]]);
      });
      expect(mounted.findByTestId(line)).toBeNull();
    } finally {
      heldRead.resolve(available);
      await screen?.unmount();
      contributedFailureRead.answer = null;
      unpublish();
      controller.retire();
      runtime.publishAppliedActiveServerSnapshot(previousRuntime, previousAvailable);
    }
  });

  it('offers Roll back… only when an earlier version served (D11)', async () => {
    const base = environmentDetailForHome();
    const undeployed = environmentDetailForHome({ targetLinks: base.targetLinks.map(link => ({ ...link,
      targetLink: { ...link.targetLink, activeDeploymentId: undefined } })) });
    const { controller: empty } = controllerFor({ detail: undeployed, history: [] });
    try {
      const screen = await render(empty, undeployed);
      await waitForContent(screen, 'project-deployments.environment.menu');
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.settings');
      expect(screen.findByTestId('project-deployments.environment.menu.history')).toBeNull();
    } finally { empty.retire(); }
    const servingId = base.targetLinks.find(row => row.targetLink.id === base.environment.runtimeTargetLinkId)!.targetLink.activeDeploymentId!;
    const serving = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: servingId, state: 'succeeded' }) });
    const earlier = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'earlier-good', state: 'succeeded' }) });
    const { controller, detail } = controllerFor({ detail: base, receipt: serving, history: [serving, earlier] });
    try {
      const screen = await render(controller, detail);
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.receipt.row.earlier-good')).not.toBeNull());
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.history');
    } finally { controller.retire(); }
  });

  it('opens and closes the Logs companion from the header ⋯ only while Logs is offered (ruling 11-08 option a)', async () => {
    const base = environmentDetailForHome();
    const unlinked = { ...base, environment: { ...base.environment, runtimeTargetLinkId: undefined }, targetLinks: [] };
    const { controller: none } = controllerFor({ detail: unlinked, history: [] });
    try {
      const screen = await render(none, unlinked);
      await waitForContent(screen, 'project-deployments.environment.menu');
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.settings');
      expect(screen.findByTestId('project-deployments.environment.menu.logs')).toBeNull();
    } finally { none.retire(); }
    const servingId = base.targetLinks.find(row => row.targetLink.id === base.environment.runtimeTargetLinkId)!.targetLink.activeDeploymentId!;
    const serving = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: servingId, state: 'succeeded' }) });
    const { controller, detail } = controllerFor({ detail: base, receipt: serving, history: [serving] });
    try {
      const screen = await render(controller, detail);
      await waitForContent(screen, 'project-deployments.environment.menu');
      expect(screen.findByTestId('environment-logs.header')).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.logs');
      await screen.pressByTestIdAsync('project-deployments.environment.menu.logs');
      await waitForContent(screen, 'environment-logs.header');
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.logs');
      await screen.pressByTestIdAsync('project-deployments.environment.menu.logs');
      await waitForHomeGovernance(() => expect(screen.findByTestId('environment-logs.header')).toBeNull());
    } finally { controller.retire(); }
  });

  it('lists several servers with a sentence only for the one down and the one joining (Lab 1 A)', async () => {
    const base = environmentDetailForHome();
    const runtimeId = base.environment.runtimeTargetLinkId!;
    const members = [
      { machineId: 'srv-a', installationId: 'inst-a', state: 'active' as const },
      { machineId: 'srv-b', installationId: 'inst-b', state: 'active' as const },
      { machineId: 'srv-c', installationId: 'inst-c', state: 'joining' as const },
    ];
    const detail = { ...base, targetLinks: base.targetLinks.map(link => link.targetLink.id === runtimeId ? { ...link,
      targetLink: { ...link.targetLink, machines: members.map(m => m.machineId), members } } : link),
      healthAggregate: { ...healthOf(base, 'down'), n: 3, down: 1, members: [
        { machineId: 'srv-a', roles: ['runtime' as const], status: 'up' as const, evidence: [{ role: 'runtime' as const, status: 'up' as const, source: 'native' as const }] },
        { machineId: 'srv-b', roles: ['runtime' as const], status: 'down' as const, evidence: [{ role: 'runtime' as const, status: 'down' as const, source: 'native' as const }] },
      ] } };
    const { controller } = controllerFor({ detail });
    try {
      const screen = await render(controller, detail);
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.environment.servers')).not.toBeNull());
      const rowText = (id: string) => JSON.stringify(screen.findByTestId(`project-deployments.environment.servers.${id}`)
        ?.findAll(node => typeof node.props.children === 'string').map(node => node.props.children));
      expect(rowText('srv-a')).not.toContain('Down');
      expect(rowText('srv-b')).toContain('Down');
      expect(rowText('srv-c')).toContain('not counted as down');
      expect(screen.getTextContent()).toContain('1 of 3 down');
    } finally { controller.retire(); }
  });

  it('keeps a single-server Environment free of a Servers section', async () => {
    const { controller, detail } = controllerFor({});
    try {
      const screen = await render(controller, detail);
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.environment.serving')).not.toBeNull());
      expect(screen.findByTestId('project-deployments.environment.servers')).toBeNull();
    } finally { controller.retire(); }
  });
});

describe('passes the selected fleet failure policy and manages runtime membership', () => {
it.each(['rollbackAll', 'keepPartial'] as const)('passes the selected fleet failure policy into the real deploy Action (%s)', async policy => {
  const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
  const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
  const { DeploymentDeployIntentInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentDeployIntentV1');
  const { createDeploymentActions } = await import('./deploymentActions');
  const { ModalProvider } = await import('@/modal');
  const base = environmentDetailForHome();
  const link = base.targetLinks[0]!.targetLink;
  const second = { machineId: 'machine-b', installationId: 'installation-b', state: 'active' as const };
  const fleet = { ...link, machines: [...link.machines, second.machineId], members: [...link.members, second] };
  const { controller, detail } = controllerFor({ detail: { ...base,
    // Fleet policy is independent of repository preparation; this also exercises stored deploys without Open.
    content: { ...base.content, definition: { kind: 'stored', document: 'services:\n  app:\n    image: app:tested\n',
      contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app'] } },
    targetLinks: [{ ...base.targetLinks[0]!, targetLink: fleet }] } });
  await publishMachineInventoryForTest(scope, fleet.members.map(member => createMachineFixture({
    id: member.machineId, installationId: member.installationId, activeAt: Date.now(),
  })));
  // The Action front door resolves the controller independently through the Home metadata boundary.
  homes.answer(scope.serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
    ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink),
  } });
  const context = await captureLazyActionAccountContext(scope.serverId);
  const received: unknown[] = [];
  await answerExternalActionAccountForHome(homes, scope.serverId, { machineId: detail.environment.controllerMachineId,
    installationId: link.members[0]!.installationId,
    deploymentSource: { id: detail.environment.projectSourceId, revision: 1 },
    actionId: 'deployments.deploy', tokenEpoch: 0, execute: raw => {
      received.push(DeploymentDeployIntentInputV1Schema.parse(raw));
      return { ok: false, error: 'deployment_conflict' };
    } });
  const actions = createDeploymentActions(context.accountLifetime, detail.environment.projectSourceId);
  let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
  try {
    screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller}
      environmentId={detail.environment.id} demand={shown} accountId={scope.accountId} serverId={scope.serverId}
      phone={false} deploy={actions.deploy} review={noReview} onOpenReceipt={() => {}} lifetime={context.accountLifetime} /></ModalProvider>);
    await waitForContent(screen, 'project-deployments.environment.servers');
    await screen.pressByTestIdAsync(`project-deployments.environment.failurePolicy:${policy}`);
    await screen.pressByTestIdAsync('project-deployments.environment.deploy');
    await waitForHomeGovernance(() => expect(received, JSON.stringify({ text: screen?.getTextContent(),
      requests: [...new Set(homes.requests.map(request => `${request.method} ${request.path.split('?')[0]}`))],
    })).toContainEqual(expect.objectContaining({
      environmentId: detail.environment.id, targetLinkId: fleet.id, onFailure: policy,
    })));
  } finally { await screen?.unmount(); controller.retire(); context.dispose(); }
});


it('opens fleet membership review from a single serving server without replacing its placement', async () => {
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const { ModalProvider } = await import('@/modal');
  const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
  const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
  const { controller, detail } = controllerFor({});
  const member = detail.targetLinks[0]!.targetLink.members[0]!;
  await publishMachineInventoryForTest(scope, [createMachineFixture({ id: member.machineId,
    installationId: member.installationId, activeAt: Date.now() }), createMachineFixture({ id: 'joining-machine',
    installationId: 'joining-installation', activeAt: Date.now() })]);
  const context = await captureLazyActionAccountContext(scope.serverId);
  let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
  try {
    screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller}
      environmentId={detail.environment.id} demand={shown} accountId={scope.accountId} serverId={scope.serverId}
      phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} lifetime={context.accountLifetime}
      destination={{ tab: 'settings', section: 'servers-build' }} /></ModalProvider>);
    await waitForContent(screen, 'project-deployments.environment.settings.servers-build.manage');
    await screen.pressByTestIdAsync('project-deployments.environment.settings.servers-build.manage');
    await waitForContent(screen, 'project-deployments.fleet');
    expect(screen.findByTestId('project-deployments.fleet.add')).not.toBeNull();
    expect(screen.findByTestId('project-deployments.environment.settings.servers-build.ingress')).not.toBeNull();
    expect(screen.findByTestId(`project-deployments.fleet.remove.${member.machineId}`)).not.toBeNull();
    expect(screen.findByTestId('project-deployments.link')).toBeNull();
  } finally { await screen?.unmount(); controller.retire(); context.dispose(); }
});

});
