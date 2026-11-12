// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentReadControllerV1, selectDeploymentRuntimeTargetLinkV1 } from '@happier-dev/deployments';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { resetSavedSecretCatalogEngineForTests, refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { settingsParse } from '@/sync/domains/settings/settings';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
const CARRIED_REVIEW_DIGEST = 'S'.repeat(43);
// Test Renderer paints the real menu at the external DOM renderer boundary.
vi.mock('@/utils/web/reactDomCjs', async () => (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();

let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | null = null;
beforeEach(() => { resetSavedSecretCatalogEngineForTests(); resetSavedSecretCatalogSnapshotsForTests(); });
afterEach(async () => { standardCleanup(); await home?.dispose(); home = null; });
const prefix = 'project-deployments.environment.settings.migration';
// These authoring cases exercise a manager's waived write; approval presentation has its own owner tests.
const authoringSettings = settingsParse({ actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
  'deployments.environments.update': ['ui'], 'deployments.bindings.set': ['ui'],
} } });
const authoringToken = createAccountTokenForTests('account-a', { currentAccount: true });

it.each(['plain', 'e2ee'] as const)('saves and removes a literal candidate migration through Environment Settings and its real Action (%s)', async mode => {
  let boundary: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>> | null = null;
  const writes: unknown[] = [];
  home = await createSecretSettingsTestHarness({ mode, settings: authoringSettings, token: authoringToken, serverIdentityId: `srv_${(mode === 'plain' ? 'd' : 'b').repeat(32)}`,
    handleRequest: async (path, init) => path.startsWith('/v1/deployments/environments/')
      ? Response.json({ ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) })
      : boundary?.handle(new URL(path, context.endpointUrl), init) ?? null });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const context = await captureLazyActionAccountContext(home.scope.serverId);
  const { encryption } = await context.resolveAccountEncryption();
  const { createDeploymentActions } = await import('./deploymentActions');
  const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
  const { DeploymentEnvironmentSettingsPanel } = await import('./DeploymentEnvironmentSettingsPanel');
  const { DeployOutcomeBanner } = await import('./DeploymentEnvironmentDetail');
  const { ModalProvider } = await import('@/modal');
  const initial = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: context.serverIdentityId! }) });
  let detail = { ...initial, runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1(initial), memberVersions: {}, secretRevisions: [] };
  boundary = await createExternalActionAccountHttpBoundary({ serverUrl: context.endpointUrl,
    serverIdentityId: context.serverIdentityId!, accountId: context.accountId, machineId: detail.environment.controllerMachineId,
    actionId: 'deployments.environments.update', tokenEpoch: 0, ...(encryption ? { encryption } : {}), execute: raw => {
      const input = DeploymentActionInputSchemasV1['deployments.environments.update'].parse(raw);
      writes.push(input.patch?.ownServer);
      return { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 };
    } });
  const controller = createDeploymentReadControllerV1({ scope: { ...home.scope, projectSourceId: detail.environment.projectSourceId },
    transport: createDeploymentReadTransport(context.accountLifetime) });
  const actions = createDeploymentActions(context.accountLifetime, detail.environment.projectSourceId);
  const editing = { actions, serverId: home.scope.serverId, review: { pendingId: null, request() {}, open() {} }, onChanged() {} };
  const element = () => <ModalProvider><ListPresentationProvider value="page"><DeploymentEnvironmentSettingsPanel detail={detail} controller={controller}
    definitionDocument={{ document: detail.content.definition.kind === 'stored' ? detail.content.definition.document : '', change() {} }}
    demand={{ mounted: false, visible: false, focused: false }} machineName={id => id} environmentTitle={() => null}
    editing={editing} lifetime={context.accountLifetime} /></ListPresentationProvider></ModalProvider>;
  try {
    const screen = await renderScreen(element());
    await screen.pressByTestIdAsync(`${prefix}.edit`);
    await act(async () => {
      screen.findHostByTestId(`${prefix}.service.input`)!.props.onChangeText('app');
      screen.findHostByTestId(`${prefix}.argv.input`)!.props.onChangeText('migrate\n--all');
      screen.findHostByTestId(`${prefix}.pending.input`)!.props.onChangeText('pending\n--check');
    });
    await screen.pressByTestIdAsync(`${prefix}.save`);
    await vi.waitFor(() => expect(writes, `${screen.getTextContent()} ${JSON.stringify(screen.findAllByType(DeployOutcomeBanner).map(node => node.props.controller.outcome))}`).toEqual([{ migration: { service: 'app', argv: ['migrate', '--all'], pendingCheck: { argv: ['pending', '--check'] } },
      backupBeforeMigration: true, migrationFailurePolicy: 'ask' }]));
    detail = { ...detail, content: { ...detail.content, ownServer: { ...detail.content.ownServer!,
      migration: { service: 'app', argv: ['migrate', '--all'] } } } };
    await act(async () => screen.update(element()));
    await screen.pressByTestIdAsync(`${prefix}.remove`);
    await vi.waitFor(() => expect(writes.at(-1)).toEqual({ migration: null }));
  } finally { controller.retire(); context.dispose(); }
});

it.each(['plain', 'e2ee'] as const)('edits and removes registry access through the same binding Action without opening secret material (%s)', async mode => {
  let boundary: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>> | null = null;
  const writes: unknown[] = [];
  home = await createSecretSettingsTestHarness({ mode, settings: authoringSettings, token: authoringToken, serverIdentityId: `srv_${(mode === 'plain' ? 'e' : 'c').repeat(32)}`,
    handleRequest: async (path, init) => path.startsWith('/v1/deployments/environments/')
      ? Response.json({ ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) })
      : boundary?.handle(new URL(path, context.endpointUrl), init) ?? null });
  const { entry } = await home.addOwnerResource();
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const context = await captureLazyActionAccountContext(home.scope.serverId);
  const { encryption } = await context.resolveAccountEncryption();
  const { createDeploymentActions } = await import('./deploymentActions');
  const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
  const { DeploymentEnvironmentSettingsPanel } = await import('./DeploymentEnvironmentSettingsPanel');
  const { DeployOutcomeBanner } = await import('./DeploymentEnvironmentDetail');
  const { ModalProvider } = await import('@/modal');
  const { EnvironmentSecretBindingV1Schema } = await import('@happier-dev/deployment-protocol/v1');
  const initial = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: context.serverIdentityId! }) });
  const binding = EnvironmentSecretBindingV1Schema.parse({ purpose: 'registry', targetLinkId: initial.environment.runtimeTargetLinkId,
    registryOrigin: 'https://registry.example', access: 'pull', source: { kind: 'secret', ref: entry.ref, resourceRevision: 1 } });
  let detail = { ...initial, content: { ...initial.content, bindings: [...initial.content.bindings, binding] },
    runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1(initial), memberVersions: {}, secretRevisions: [] };
  boundary = await createExternalActionAccountHttpBoundary({ serverUrl: context.endpointUrl,
    serverIdentityId: context.serverIdentityId!, accountId: context.accountId, machineId: detail.environment.controllerMachineId,
    actionId: 'deployments.bindings.set', tokenEpoch: 0, ...(encryption ? { encryption } : {}), execute: raw => {
      const input = DeploymentActionInputSchemasV1['deployments.bindings.set'].parse(raw);
      writes.push({ set: input.set, remove: input.remove });
      return { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 };
    } });
  const controller = createDeploymentReadControllerV1({ scope: { ...home.scope, projectSourceId: detail.environment.projectSourceId },
    transport: createDeploymentReadTransport(context.accountLifetime) });
  const actions = createDeploymentActions(context.accountLifetime, detail.environment.projectSourceId);
  const editing = { actions, serverId: home.scope.serverId, review: { pendingId: null, request() {}, open() {} }, onChanged() {} };
  const element = () => <ModalProvider><ListPresentationProvider value="page"><DeploymentEnvironmentSettingsPanel detail={detail} controller={controller}
    definitionDocument={{ document: detail.content.definition.kind === 'stored' ? detail.content.definition.document : '', change() {} }}
    demand={{ mounted: false, visible: false, focused: false }} machineName={id => id} environmentTitle={() => null}
    editing={editing} lifetime={context.accountLifetime} /></ListPresentationProvider></ModalProvider>;
  try {
    const screen = await renderScreen(element());
    const registry = 'project-deployments.environment.settings.registry';
    await screen.pressByTestIdAsync(`${registry}.edit`);
    await screen.pressByTestIdAsync(`${registry}.access:pushPull`);
    await screen.pressByTestIdAsync(`${registry}.save`);
    await vi.waitFor(() => expect(writes, `${screen.getTextContent()} ${JSON.stringify(screen.findAllByType(DeployOutcomeBanner).map(node => node.props.controller.outcome))}`).toEqual([{ set: [{ ...binding, access: 'pushPull' }], remove: [] }]));
    const changed = { ...binding, access: 'pushPull' as const, registryOrigin: 'https://renamed.registry' };
    detail = { ...detail, content: { ...detail.content, bindings: [{ ...binding, access: 'pushPull' }] } };
    await act(async () => screen.update(element()));
    await screen.pressByTestIdAsync(`${registry}.edit`);
    await act(async () => screen.findHostByTestId(`${registry}.origin.input`)!.props.onChangeText(changed.registryOrigin));
    await screen.pressByTestIdAsync(`${registry}.save`);
    await vi.waitFor(() => expect(writes.at(-1)).toEqual({ set: [changed],
      remove: [{ purpose: 'registry', targetLinkId: binding.targetLinkId, registryOrigin: binding.registryOrigin }] }));
    detail = { ...detail, content: { ...detail.content, bindings: [changed] } };
    await act(async () => screen.update(element()));
    await screen.pressByTestIdAsync(`${registry}.remove`);
    await vi.waitFor(() => expect(writes.at(-1)).toEqual({ set: [],
      remove: [{ purpose: 'registry', targetLinkId: binding.targetLinkId, registryOrigin: changed.registryOrigin }] }));
    detail = { ...detail, content: { ...detail.content, bindings: [] } };
    await act(async () => screen.update(element()));
    await screen.pressByTestIdAsync(`${registry}.add`);
    await act(async () => screen.findHostByTestId(`${registry}.origin.input`)!.props.onChangeText('https://other.registry'));
    await screen.pressByTestIdAsync(`${registry}.secret`);
    await act(async () => refreshSavedSecretCatalog(context.accountLifetime.scope, { includeMaterial: false }));
    await measureMountedCollections(screen);
    await screen.pressByTestIdAsync(`saved-secret-picker:saved:${entry.ref}`);
    await screen.pressByTestIdAsync(`${registry}.save`);
    await vi.waitFor(() => expect(writes.at(-1)).toEqual({ set: [{ ...binding, registryOrigin: 'https://other.registry',
      source: { ...binding.source, resourceRevision: entry.revision } }], remove: [] }));
    expect(home.request.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/resources/materials'))).toHaveLength(0);
  } finally { controller.retire(); context.dispose(); }
});

it.each(['action_interactive_review_required', 'approval_stale', 'machine_unavailable'] as const)('opens recovery from Settings after %s', async code => {
  const { Modal } = await import('@/modal');
  vi.mocked(Modal.confirm).mockClear().mockResolvedValue(true);
  const mode = 'plain';
  let boundary: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>> | null = null;
  const writes: unknown[] = [];
  home = await createSecretSettingsTestHarness({ mode, settings: authoringSettings, token: authoringToken, serverIdentityId: `srv_${({ action_interactive_review_required: '1', approval_stale: '2', machine_unavailable: '3' }[code]).repeat(32)}`,
    handleRequest: async (path, init) => path.startsWith('/v1/deployments/environments/')
      ? Response.json({ ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) })
      : boundary?.handle(new URL(path, context.endpointUrl), init) ?? null });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const context = await captureLazyActionAccountContext(home.scope.serverId);
  const { encryption } = await context.resolveAccountEncryption();
  const { createDeploymentActions } = await import('./deploymentActions');
  const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
  const { DeploymentEnvironmentSettingsPanel } = await import('./DeploymentEnvironmentSettingsPanel');
  const recovered: string[] = [];
  const requested: string[] = [];
  const { ModalProvider } = await import('@/modal');
  const initial = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: context.serverIdentityId! }) });
  let detail = { ...initial, runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1(initial), memberVersions: {}, secretRevisions: [] };
  boundary = await createExternalActionAccountHttpBoundary({ serverUrl: context.endpointUrl,
    serverIdentityId: context.serverIdentityId!, accountId: context.accountId, machineId: detail.environment.controllerMachineId,
    actionId: 'deployments.environments.update', tokenEpoch: 0, ...(encryption ? { encryption } : {}), execute: (raw, invocationContext) => {
      const input = DeploymentActionInputSchemasV1['deployments.environments.update'].parse(raw);
      writes.push(input.patch?.ownServer);
      // A controller without a presenter carries its review back and admits only a confirmation of that review.
      if (code === 'action_interactive_review_required'
        && invocationContext.invocation.presentUserConfirmation?.reviewDigest === CARRIED_REVIEW_DIGEST) {
        return { ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1 };
      }
      return { ok: false, error: code, input };
    }, failure: result => typeof result === 'object' && result !== null && 'ok' in result && result.ok === true ? null
      : { errorCode: code, error: code, ...(code === 'action_interactive_review_required' ? { details: {
        review: { actionArgs: (result as { input: unknown }).input, preview: { summary: 'Start the new release first' } },
        reviewDigest: CARRIED_REVIEW_DIGEST } } : {}) } });
  const controller = createDeploymentReadControllerV1({ scope: { ...home.scope, projectSourceId: detail.environment.projectSourceId },
    transport: createDeploymentReadTransport(context.accountLifetime) });
  const actions = createDeploymentActions(context.accountLifetime, detail.environment.projectSourceId);
  const editing = { actions, serverId: home.scope.serverId, review: { pendingId: null, request(artifactId: string) { requested.push(artifactId); }, open() {}, openRecovery(destination: string) { recovered.push(destination); } }, onChanged() {} };
  const element = () => <ModalProvider><ListPresentationProvider value="page"><DeploymentEnvironmentSettingsPanel detail={detail} controller={controller}
    definitionDocument={{ document: detail.content.definition.kind === 'stored' ? detail.content.definition.document : '', change() {} }}
    demand={{ mounted: false, visible: false, focused: false }} machineName={id => id} environmentTitle={() => null}
    editing={editing} lifetime={context.accountLifetime} /></ListPresentationProvider></ModalProvider>;
  try {
    const screen = await renderScreen(element());
    await screen.pressByTestIdAsync('project-deployments.environment.settings.rollout.rollout:startFirst');
    const refused = `project-deployments.outcome.refused.${code === 'machine_unavailable' ? 'machine' : 'other'}`;
    if (code === 'action_interactive_review_required') {
      // The person confirms the controller's own review natively; the exact Save runs once more with it,
      // never a self-approval Artifact and never a failure banner.
      await vi.waitFor(() => expect(writes).toHaveLength(2));
      expect(Modal.confirm).toHaveBeenCalledTimes(1);
      expect(requested).toEqual([]);
      expect(screen.findByTestId(refused)).toBeNull();
      return;
    }
    await vi.waitFor(() => expect(screen.findByTestId(refused)).not.toBeNull());
    const banner = screen.find(node => node.props.testID === refused && node.props.tone !== undefined);
    // The outcome shows inside the section whose control was pressed, not at the page lead.
    let section = banner.parent;
    while (section && section.props.testID !== 'project-deployments.environment.settings.rollout') section = section.parent;
    expect(section).not.toBeNull();
    // A refusal that needs a fresh review is "needs you" (amber) with its review, never a rose failure.
    if (code === 'approval_stale') {
      expect(banner.props).toMatchObject({ tone: 'warning', title: 'Waiting for your review' });
    }
    await screen.pressByTestIdAsync(`${refused}.action`);
    if (code === 'machine_unavailable') expect(recovered).toEqual(['machines']);
    else await vi.waitFor(() => expect(writes).toHaveLength(2));
  } finally { controller.retire(); context.dispose(); }
});


it('opens Environment alert setup before its first deployment instead of showing an unavailable placeholder', async () => {
  home = await createSecretSettingsTestHarness({ mode: 'plain', settings: authoringSettings,
    token: authoringToken, serverIdentityId: `srv_${'9'.repeat(32)}`,
    handleRequest: async path => path === '/v3/automations/query'
      ? Response.json({ automations: [], nextCursor: null }) : null });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const context = await captureLazyActionAccountContext(home.scope.serverId);
  const { createDeploymentActions } = await import('./deploymentActions');
  const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
  const { DeploymentEnvironmentSettingsPanel } = await import('./DeploymentEnvironmentSettingsPanel');
  const { ModalProvider } = await import('@/modal');
  const initial = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: context.serverIdentityId! }) });
  const detail = { ...initial, runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
  const controller = createDeploymentReadControllerV1({ scope: { ...home.scope, projectSourceId: detail.environment.projectSourceId },
    transport: createDeploymentReadTransport(context.accountLifetime) });
  const actions = createDeploymentActions(context.accountLifetime, detail.environment.projectSourceId);
  try {
    const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentSettingsPanel detail={detail} controller={controller}
      definitionDocument={{ document: detail.content.definition.kind === 'stored' ? detail.content.definition.document : '', change() {} }}
      demand={{ mounted: false, visible: false, focused: false }} machineName={id => id} environmentTitle={() => null}
      editing={{ actions, serverId: home.scope.serverId, review: { pendingId: null, request() {}, open() {} }, onChanged() {} }}
      lifetime={context.accountLifetime} /></ModalProvider>);
    await screen.pressByTestIdAsync('project-deployments.environment.settings.checks-alerts.alerts');
    await vi.waitFor(() => expect(screen.findByTestId('workflows-column-new-trigger-popover')).not.toBeNull());
  } finally { controller.retire(); context.dispose(); }
});
