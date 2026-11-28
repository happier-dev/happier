// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentReadControllerV1, selectDeploymentRuntimeTargetLinkV1 } from '@happier-dev/deployments';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { resetSavedSecretCatalogEngineForTests, refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
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
afterEach(async () => {
  standardCleanup();
  (await import('./inlineAddDraft')).forgetInlineAddDraftsForTest();
  await home?.dispose();
  home = null;
});
const prefix = 'project-deployments.environment.settings.migration';
// These authoring cases exercise a manager's waived write; approval presentation has its own owner tests.
const authoringSettings = settingsParse({ actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
  'deployments.environments.update': ['ui'], 'deployments.bindings.set': ['ui'],
} } });
const authoringToken = createAccountTokenForTests('account-a', { currentAccount: true });

it('saves Environment database editing and agent access in one reviewed revision update', async () => {
  let boundary: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>> | null = null;
  let detail = createDeploymentEnvironmentDetailV1();
  const writes: unknown[] = [];
  home = await createSecretSettingsTestHarness({ mode: 'plain', settings: authoringSettings, token: authoringToken,
    serverIdentityId: `srv_${'a'.repeat(32)}`,
    handleRequest: async (path, init) => path.startsWith('/v1/deployments/environments/')
      ? Response.json({ ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) })
      : boundary?.handle(new URL(path, context.endpointUrl), init) ?? null });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const context = await captureLazyActionAccountContext(home.scope.serverId);
  const { createDeploymentActions } = await import('./deploymentActions');
  const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
  const { DeploymentEnvironmentSettingsPanel } = await import('./DeploymentEnvironmentSettingsPanel');
  detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({
    serverId: context.serverIdentityId!, dataEditorMode: 'off', dataAgentAccess: 'read',
  }) });
  const revision = detail.environment.revision;
  boundary = await createExternalActionAccountHttpBoundary({ serverUrl: context.endpointUrl,
    serverIdentityId: context.serverIdentityId!, accountId: context.accountId, machineId: detail.environment.controllerMachineId,
    actionId: 'deployments.environments.update', tokenEpoch: 0, execute: raw => {
      const input = DeploymentActionInputSchemasV1['deployments.environments.update'].parse(raw);
      writes.push({ expectedRevision: input.expectedRevision, patch: input.patch });
      detail = { ...detail, environment: { ...detail.environment, revision: revision + 1,
        dataEditorMode: input.patch?.dataEditorMode ?? detail.environment.dataEditorMode,
        dataAgentAccess: input.patch?.dataAgentAccess ?? detail.environment.dataAgentAccess } };
      return { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision };
    } });
  const controller = createDeploymentReadControllerV1({ scope: { ...home.scope, projectSourceId: detail.environment.projectSourceId },
    transport: createDeploymentReadTransport(context.accountLifetime) });
  const onChanged = vi.fn();
  const actions = createDeploymentActions(context.accountLifetime, detail.environment.projectSourceId);
  const editing = { actions, serverId: home.scope.serverId, review: { pendingId: null, request() {}, open() {} }, onChanged };
  const element = () => <ListPresentationProvider value="page"><DeploymentEnvironmentSettingsPanel
    detail={{ ...detail, runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1(detail), memberVersions: {}, secretRevisions: [] }}
    controller={controller} definitionDocument={{ document: '', change() {} }} lifetime={context.accountLifetime}
    demand={{ mounted: false, visible: false, focused: false }} machineName={id => id} environmentTitle={() => null}
    focusSection="database-access" editing={editing} /></ListPresentationProvider>;
  const section = 'project-deployments.environment.settings.database-access';
  try {
    const screen = await renderScreen(element());
    expect(screen.findByTestId(`${section}.save`)?.props.disabled).toBe(true);
    await screen.pressByTestIdAsync(`${section}.editors:managers`);
    // Agents is the same titled field select the workbench access sheet uses: the four levels, the saved one chosen.
    const agents = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${section}.agents`)!;
    expect((agents().props.items as readonly { id: string }[]).map(item => item.id))
      .toEqual(['none', 'read', 'readWriteAsk', 'readWriteNoApproval']);
    expect(agents().props.selectedId).toBe('read');
    await act(async () => { agents().props.onSelect('none'); });
    expect(agents().props.selectedId).toBe('none');
    expect(writes).toHaveLength(0);
    await screen.pressByTestIdAsync(`${section}.save`);
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(writes).toEqual([{ expectedRevision: revision, patch: { dataEditorMode: 'managers', dataAgentAccess: 'none' } }]);
    await act(async () => screen.update(element()));
    expect(screen.findByTestId(`${section}.save`)?.props.disabled).toBe(true);
  } finally { controller.retire(); context.dispose(); }
});

it.each(['single link', 'multiple links', 'retired mount'] as const)('sets up a managed database writer from staged review with %s', async links => {
  let boundary: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>> | null = null;
  const writes: unknown[] = [];
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployments/testing/v1');
  const { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
  const { PluginUiHostPresentationScope } = await import('@happier-dev/plugin-ui/advanced');
  const { projectHappierUiEnvironment } = await import('@happier-dev/plugin-ui/environment');
  const { createSurfaceContextFixture } = await import('@happier-dev/plugin-sdk/testing');
  const { createPluginUiPrivatePresentationHost } = await import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost');
  const { ModalProvider } = await import('@/modal');
  home = await createSecretSettingsTestHarness({ mode: 'plain', settings: authoringSettings, token: authoringToken,
    serverIdentityId: `srv_${({ 'single link': '6', 'multiple links': '7', 'retired mount': '8' }[links]).repeat(32)}`,
    handleRequest: async (path, init) => path.startsWith('/v1/deployments/environments/')
      ? Response.json({ ok: true, environment, targetLinks })
      : boundary?.handle(new URL(path, context.endpointUrl), init) ?? null });
  const context = await captureLazyActionAccountContext(home.scope.serverId);
  const environment = createDeploymentEnvironmentHeaderV1({ serverId: context.serverIdentityId!,
    owner: { kind: 'account', accountId: context.accountId }, runtimeTargetLinkId: undefined });
  const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'data-link', environmentId: environment.id, role: 'data',
    source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.neon', localId: 'database' } },
    targetKind: 'neon', machines: [], members: [], activeDeploymentId: undefined });
  const single = links !== 'multiple links';
  const targetLinks = single ? [targetLink] : [targetLink, { ...targetLink, id: 'other-data-link', contentArtifactId: 'other-artifact' }];
  try {
    const { entry: chosen } = await home.addOwnerResource();
    const installedRef = single ? chosen.ref : 'happier:shared-secret:v1:other-database';
    const { content } = createDeploymentEnvironmentDetailV1();
    await context.createArtifactDocument({ artifactId: environment.contentArtifactId,
      header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: content.name },
      body: JSON.stringify({ ...content, bindings: [{ purpose: 'variable', name: 'DIRECT_URL', phase: 'runtime',
        source: { kind: 'secret', ref: installedRef, resourceRevision: chosen.revision } }] }) });
    boundary = await createExternalActionAccountHttpBoundary({ serverUrl: context.endpointUrl,
      serverIdentityId: context.serverIdentityId!, accountId: context.accountId, machineId: environment.controllerMachineId,
      actionId: 'deployments.bindings.set', tokenEpoch: 0, execute: raw => {
        const input = DeploymentActionInputSchemasV1['deployments.bindings.set'].parse(raw);
        if (!('set' in input)) throw new Error('Expected a binding patch');
        writes.push({ environmentId: input.environmentId, expectedRevision: input.expectedRevision, set: input.set, remove: input.remove });
        return { ok: true, environmentId: environment.id, revision: environment.revision + 1 };
      } });
    let mountCurrent = true;
    const presentationHost = createPluginUiPrivatePresentationHost(undefined, { automations: {
      accountLifetime: context.accountLifetime, target: { kind: 'app' }, isCurrent: () => mountCurrent,
    } });
    const setup = presentationHost.databaseWorkbench?.renderWriteSetup?.({
      code: 'write_connection_setup_required', target: {
        kind: 'managed_deployment', environment: { serverId: environment.serverId,
          environmentId: environment.id, projectSourceId: environment.projectSourceId },
        targetLinkId: targetLink.id, contribution: { pluginId: 'happier.deploy.neon', contributionId: 'database' },
        platformProjectId: 'project', branchId: 'main', database: 'shop',
      }, onConfigured: () => {},
    });
    const screen = await renderScreen(<ModalProvider><PluginUiHostPresentationScope
      environment={projectHappierUiEnvironment(createSurfaceContextFixture())} presentationHost={presentationHost}>
      {setup}
    </PluginUiHostPresentationScope></ModalProvider>);
    const setupId = 'database-workbench.write-setup';
    await vi.waitFor(() => expect(screen.findByTestId(`${setupId}.save`)?.props.disabled).toBe(!single));
    expect(writes).toHaveLength(0);
    if (!single) {
      await screen.pressByTestIdAsync(`${setupId}.secret`);
      await act(async () => refreshSavedSecretCatalog(context.accountLifetime.scope, { includeMaterial: false }));
      await measureMountedCollections(screen);
      await screen.pressByTestIdAsync(`saved-secret-picker:saved:${chosen.ref}`);
      expect(writes).toHaveLength(0);
    }
    if (links === 'retired mount') {
      // The already-rendered callback must honor the captured mount's retirement.
      mountCurrent = false;
      await screen.pressByTestIdAsync(`${setupId}.save`);
      expect(writes).toHaveLength(0);
      return;
    }
    await screen.pressByTestIdAsync(`${setupId}.save`);
    await vi.waitFor(() => expect(writes).toEqual([{ environmentId: environment.id, expectedRevision: environment.revision,
      set: [{ purpose: 'dataRole', targetLinkId: targetLink.id, role: 'write',
        source: { kind: 'secret', ref: chosen.ref, resourceRevision: chosen.revision } }], remove: [] }]));
    expect(home.request.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/resources/materials'))).toHaveLength(0);
  } finally { context.dispose(); }
});

it.each([
  { code: 'write_role_setup_required', role: 'write', testId: 'database-workbench.write-setup.save', homeIdentity: '9' },
  { code: 'read_role_setup_required', role: 'readOnlyPassword', testId: 'database-workbench.read-setup.save', homeIdentity: 'f' },
] as const)('creates and binds an own-server $role login from Workbench setup', async ({ code, role, testId, homeIdentity }) => {
  let boundary: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>> | null = null;
  const writes: unknown[] = [];
  const onConfigured = vi.fn();
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployments/testing/v1');
  const { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
  const { PluginUiHostPresentationScope } = await import('@happier-dev/plugin-ui/advanced');
  const { projectHappierUiEnvironment } = await import('@happier-dev/plugin-ui/environment');
  const { createSurfaceContextFixture } = await import('@happier-dev/plugin-sdk/testing');
  const { createPluginUiPrivatePresentationHost } = await import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost');
  const { formatSharedSavedSecretRefV1 } = await import('@happier-dev/protocol/account/settings/savedSecretReferenceV1');
  home = await createSecretSettingsTestHarness({ mode: 'plain', settings: authoringSettings, token: authoringToken,
    serverIdentityId: `srv_${homeIdentity.repeat(32)}`,
    handleRequest: async (path, init) => path.startsWith('/v1/deployments/environments/')
      ? Response.json({ ok: true, environment, targetLinks: [targetLink] })
      : boundary?.handle(new URL(path, context.endpointUrl), init) ?? null });
  const context = await captureLazyActionAccountContext(home.scope.serverId);
  const environment = createDeploymentEnvironmentHeaderV1({ serverId: context.serverIdentityId!,
    owner: { kind: 'account', accountId: context.accountId }, runtimeTargetLinkId: 'runtime-link' });
  const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'runtime-link', environmentId: environment.id,
    activeDeploymentId: 'deployment' });
  const { content } = createDeploymentEnvironmentDetailV1({ environment });
  try {
    await context.createArtifactDocument({ artifactId: environment.contentArtifactId,
      header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: content.name }, body: JSON.stringify(content) });
    boundary = await createExternalActionAccountHttpBoundary({ serverUrl: context.endpointUrl,
      serverIdentityId: context.serverIdentityId!, accountId: context.accountId, machineId: environment.controllerMachineId,
      actionId: 'deployments.bindings.set', tokenEpoch: 0, execute: raw => {
        const input = DeploymentActionInputSchemasV1['deployments.bindings.set'].parse(raw);
        if (!('set' in input)) throw new Error('Expected a binding patch');
        writes.push({ environmentId: input.environmentId, expectedRevision: input.expectedRevision, set: input.set, remove: input.remove });
        return { ok: true, environmentId: environment.id, revision: environment.revision + 1 };
      } });
    const presentationHost = createPluginUiPrivatePresentationHost(undefined, { automations: {
      accountLifetime: context.accountLifetime, target: { kind: 'app' }, isCurrent: () => true,
    } });
    const setup = presentationHost.databaseWorkbench?.renderWriteSetup?.({ code, target: {
      kind: 'deployment_service', environment: { serverId: environment.serverId,
        environmentId: environment.id, projectSourceId: environment.projectSourceId },
      targetLinkId: targetLink.id, deploymentId: 'deployment', serviceId: 'database', database: 'shop',
    }, onConfigured });
    const screen = await renderScreen(<PluginUiHostPresentationScope
      environment={projectHappierUiEnvironment(createSurfaceContextFixture())} presentationHost={presentationHost}>
      {setup}
    </PluginUiHostPresentationScope>);
    await vi.waitFor(() => expect(screen.findByTestId(testId)?.props.disabled).toBe(false));
    expect(home.creations).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(onConfigured).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync(testId);
    await vi.waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1));
    expect(home.creations).toHaveLength(1);
    expect(writes).toEqual([{ environmentId: environment.id, expectedRevision: environment.revision,
      set: [{ purpose: 'dataRole', service: 'database', role,
        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(home.creations[0]!.resourceId), resourceRevision: 1 } }], remove: [] }]);
  } finally { context.dispose(); }
});

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
  const { EnvironmentSecretBindingV1Schema } = await import('@happier-dev/deployments/contracts/v1');
  const initial = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: context.serverIdentityId! }) });
  const binding = EnvironmentSecretBindingV1Schema.parse({ purpose: 'registry', targetLinkId: initial.environment.runtimeTargetLinkId,
    registryOrigin: 'https://registry.example', access: 'pull', source: { kind: 'secret', ref: entry.ref, resourceRevision: 1 } });
  if (binding.purpose !== 'registry') throw new Error('Expected a registry binding');
  let detail = { ...initial, content: { ...initial.content, bindings: [...initial.content.bindings, binding] },
    runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1(initial), memberVersions: {}, secretRevisions: [] };
  boundary = await createExternalActionAccountHttpBoundary({ serverUrl: context.endpointUrl,
    serverIdentityId: context.serverIdentityId!, accountId: context.accountId, machineId: detail.environment.controllerMachineId,
    actionId: 'deployments.bindings.set', tokenEpoch: 0, ...(encryption ? { encryption } : {}), execute: raw => {
      const input = DeploymentActionInputSchemasV1['deployments.bindings.set'].parse(raw);
      if (!('set' in input)) throw new Error('Expected a binding patch');
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
      await vi.waitFor(() => expect(screen.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      expect(writes).toHaveLength(1);
      await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
      await vi.waitFor(() => expect(writes).toHaveLength(2));
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
    token: authoringToken, serverIdentityId: `srv_${'4'.repeat(32)}`,
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
    await vi.waitFor(() => expect(screen.findByTestId('project-deployments.environment.settings.checks-alerts.setup')).not.toBeNull());
  } finally { controller.retire(); context.dispose(); }
});

it('brings the addressed Settings section into view: Open backups lands on Backups, not Servers & build', async () => {
  home = await createSecretSettingsTestHarness({ mode: 'plain', settings: authoringSettings,
    token: authoringToken, serverIdentityId: `srv_${'5'.repeat(32)}`,
    handleRequest: async path => path === '/v3/automations/query'
      ? Response.json({ automations: [], nextCursor: null }) : null });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const context = await captureLazyActionAccountContext(home.scope.serverId);
  const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
  const { DeploymentEnvironmentSettingsPanel } = await import('./DeploymentEnvironmentSettingsPanel');
  const { ModalProvider } = await import('@/modal');
  const initial = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: context.serverIdentityId! }) });
  const detail = { ...initial, runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
  const controller = createDeploymentReadControllerV1({ scope: { ...home.scope, projectSourceId: detail.environment.projectSourceId },
    transport: createDeploymentReadTransport(context.accountLifetime) });
  const revealed: string[] = [];
  try {
    // The scroll boundary: a section host reports which section it holds when the page scrolls it into view.
    await renderScreen(<ModalProvider><DeploymentEnvironmentSettingsPanel detail={detail} controller={controller}
      definitionDocument={{ document: detail.content.definition.kind === 'stored' ? detail.content.definition.document : '', change() {} }}
      demand={{ mounted: false, visible: false, focused: false }} machineName={id => id} environmentTitle={() => null}
      focusSection="backups" /></ModalProvider>, {
      createNodeMock: (element) => {
        const testID = (element.props as { children?: { props?: { testID?: unknown } } }).children?.props?.testID;
        return typeof testID === 'string' && testID.startsWith('project-deployments.environment.settings.')
          ? { scrollIntoView: () => { revealed.push(testID); } } : null;
      },
    });
    await vi.waitFor(() => expect(revealed).toEqual(['project-deployments.environment.settings.backups']));
  } finally { controller.retire(); context.dispose(); }
});

it.each([true, false])('opens configured Backups with Database route available: %s', async hasDatabasePage => {
  let historyBoundary: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>> | null = null;
  let historyReads = 0;
  const serverIdentityId = `srv_${(hasDatabasePage ? 'b' : 'c').repeat(32)}`;
  const base = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: serverIdentityId }) });
  const environmentId = base.environment.id;
  const detail = createDeploymentEnvironmentDetailV1({ ...base, content: { ...base.content,
    backup: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.destinations', localId: 'open' },
      occurrenceId: 'nightly', config: {}, credentialBindings: [], ownership: { environmentId, prefix: 'backup/' },
      sources: [hasDatabasePage ? { kind: 'dump', sourceId: 'database', service: 'postgres', consistency: 'logical' }
        : { kind: 'volume', sourceId: 'app-files', service: 'app', volume: 'files', consistency: 'stopDuringCopy' }],
      retention: { kind: 'keepEverything' } },
    ...(hasDatabasePage ? { template: {
      templateRef: { sourceId: 'apps', itemId: 'postgres', version: '17', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` },
      services: ['postgres'], data: [{ engine: 'postgres', service: 'postgres', port: 5432 }],
    } } : {}),
  } });
  home = await createSecretSettingsTestHarness({ mode: 'plain', settings: authoringSettings, token: authoringToken,
    serverIdentityId, handleRequest: async (path, init) => {
      if (path === `/v1/deployments/environments/${environmentId}`) {
        return Response.json({ ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink) });
      }
      if (path === '/v3/automations/query') {
        return Response.json({ automations: [], nextCursor: null });
      }
      return historyBoundary?.handle(new URL(path, context.endpointUrl), init) ?? null;
    } });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const context = await captureLazyActionAccountContext(home.scope.serverId);
  const { DeploymentEnvironmentSettingsPanel } = await import('./DeploymentEnvironmentSettingsPanel');
  const { ModalProvider } = await import('@/modal');
  const runtimeTargetLink = selectDeploymentRuntimeTargetLinkV1(detail)!;
  const member = runtimeTargetLink.members[0]!;
  historyBoundary = await createExternalActionAccountHttpBoundary({ serverUrl: context.endpointUrl, serverIdentityId,
    accountId: context.accountId, machineId: member.machineId, installationId: member.installationId,
    actionId: 'deployments.backups.history', tokenEpoch: 0, execute: () => {
      historyReads++;
      return { kind: 'history', environmentId, configRevision: 1, history: { entries: [] } };
    } });
  const controller = createDeploymentReadControllerV1({ scope: { ...home.scope, projectSourceId: detail.environment.projectSourceId },
    transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: false, failure: { code: 'not_demanded', retryable: false } }),
    } });
  const section = 'project-deployments.environment.settings.backups';
  const openDatabase = vi.fn();
  try {
    const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentSettingsPanel
      detail={{ ...detail, runtimeTargetLink, memberVersions: {}, secretRevisions: [] }} controller={controller}
      definitionDocument={{ document: '', change() {} }} demand={{ mounted: true, visible: true, focused: true }}
      machineName={id => id} environmentTitle={() => null} focusSection="backups" lifetime={context.accountLifetime}
      review={{ pendingId: null, request() {}, open() {} }} onOpenDatabase={hasDatabasePage ? openDatabase : null}
    /></ModalProvider>);
    try {
      await vi.waitFor(() => expect(screen.findByTestId(`${section}.schedule.on`)).not.toBeNull());
      if (hasDatabasePage) {
        await screen.pressByTestIdAsync(`${section}.database.postgres`);
        expect(openDatabase).toHaveBeenCalledWith('postgres');
        expect(screen.findByTestId(`${section}.status`)).toBeNull();
      } else {
        await vi.waitFor(() => expect(historyReads).toBe(1));
        expect(screen.findByTestId(`${section}.status`)).not.toBeNull();
      }
      await flushHookEffects();
      expect(historyReads).toBe(hasDatabasePage ? 0 : 1);
    } finally { await screen.unmount(); }
  } finally { controller.retire(); context.dispose(); }
});
