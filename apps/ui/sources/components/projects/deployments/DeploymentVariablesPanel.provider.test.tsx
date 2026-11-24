// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/jsonSchemaValidation';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { installBrowserStorageLockBoundary } from '@/dev/testkit/harness/browserStorageLockBoundary';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { resetSavedSecretCatalogEngineForTests } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const routing = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => routing.module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
// Test Renderer paints the real menu inline at the external DOM renderer boundary.
vi.mock('@/utils/web/reactDomCjs', async () => (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/components/ui/popover', async importOriginal => (await import('@/dev/testkit/mocks/popover'))
  .createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 280, placement: 'bottom' }));
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));



const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDeploymentActions } = await import('./deploymentActions');
const { DeploymentVariablesPanel } = await import('./DeploymentVariablesPanel');
const { useEnvironmentSecretBindingsDraft } = await import('./useEnvironmentSecretBindingsDraft');
await import('@/sync/ops/actions/defaultActionExecutor');
let restoreLocks: (() => void) | null = null;
beforeEach(async () => { restoreLocks = installBrowserStorageLockBoundary(); await homes.reset(); resetSavedSecretCatalogEngineForTests(); resetSavedSecretCatalogSnapshotsForTests(); });
afterEach(async () => { await standardCleanup(); restoreLocks?.(); restoreLocks = null; });

it.each([{ settlement: 'saved', choice: 'useOurs' }, { settlement: 'saved', choice: 'keepTheirs' },
  { settlement: 'storage conflict', choice: 'useOurs' }] as const)('reads masked provider metadata and saves $choice with $settlement visible through the public Variables owner', async ({ settlement, choice }) => {
  const serverId = await homes.addHome({ name: 'App Home', serverUrl: `https://variables-${settlement.replace(' ', '-')}-${choice.toLowerCase()}.test`,
    serverIdentityId: `srv_${(settlement === 'storage conflict' ? '9' : choice === 'keepTheirs' ? '8' : '7').repeat(32)}`, accountId: 'owner', currentAccount: true });
  const base = createDeploymentEnvironmentDetailV1();
  const detail = { ...base, environment: { ...base.environment, serverId }, content: { ...base.content,
    bindings: [{ purpose: 'variable' as const, name: 'MODE', phase: 'runtime' as const, source: { kind: 'value' as const, value: 'production' } }] } };
  const targetLink = detail.targetLinks[0]!.targetLink;
  const lifetime = { scope: { serverId, accountId: 'owner' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
  homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, {
    body: { ok: true, environment: detail.environment, targetLinks: [targetLink] } });
  const metadata = { v: 1 as const, variables: [{ key: 'MODE', providerId: 'env-mode', present: true,
    secret: true, owned: true, drift: 'changed' as const, providerRevision: 'provider-revision' }] };
  const reads: unknown[] = [];
  const writes: unknown[] = [];
  await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.observation.get',
    machineId: detail.environment.controllerMachineId, tokenEpoch: 0, execute: raw => {
      const input = DeploymentActionInputSchemasV1['deployments.observation.get'].parse(raw);
      reads.push(input);
      expect(input).toMatchObject({ environmentId: detail.environment.id, targetLinkId: targetLink.id, variables: true });
      return { ok: true, environment: detail.environment, targetLink, providerVariables: metadata,
        credentialPrincipal: { kind: 'account', accountId: 'owner',
          purpose: { consumer: { pluginId: 'happier.deploy-vercel', localId: 'vercel' }, purpose: 'manage' },
          target: { kind: 'account', account: { service: { pluginId: 'happier.deploy-vercel', localId: 'vercel' }, accountId: 'credential' } } } };
    } });
  await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.bindings.set',
    machineId: detail.environment.controllerMachineId, tokenEpoch: 0,
    failure: () => settlement === 'storage conflict' ? { errorCode: 'deployment_conflict', error: 'deployment_conflict',
      effectAttempted: true, details: { providerVariables: { ...metadata, failures: [], persisted: false } } } : null,
    execute: raw => {
      const input = DeploymentActionInputSchemasV1['deployments.bindings.set'].parse(raw);
      writes.push(input);
      const providerVariables = { ...metadata, failures: [], persisted: settlement === 'saved' };
      return settlement === 'saved'
        ? { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1, providerVariables }
        : { ok: false, error: 'deployment_conflict', effectAttempted: true, details: { providerVariables } };
    } });
  const actions = createDeploymentActions(lifetime, detail.environment.projectSourceId);
  function Page({ visible }: Readonly<{ visible: boolean }>) {
    const draft = useEnvironmentSecretBindingsDraft({ environmentId: detail.environment.id, lifetime,
      snapshot: { status: 'ready', value: detail, failure: null }, setBindings: actions.setBindings });
    return <DeploymentVariablesPanel draft={draft} phone environmentName={() => null} sealedOn={null}
      review={{ pendingId: null, request() {}, open() {} }} environmentId={detail.environment.id}
      projectSourceId={detail.environment.projectSourceId} providerTargetLinkId={targetLink.id} providerVariablesActive={visible}
      scope={lifetime.scope} lifetime={lifetime} />;
  }
  const render = (visible: boolean) => <ListPresentationProvider value="page"><Page visible={visible} /></ListPresentationProvider>;
  const screen = await renderScreen(render(false), {
    createNodeMock: () => ({ offsetTop: 0, offsetHeight: 44, scrollTo() {}, getBoundingClientRect: () => new DOMRect(0, 0, 320, 44) }),
  });
  expect(reads).toHaveLength(0);
  await act(async () => { screen.update(render(true)); });
  await measureMountedCollections(screen);
  const key = 'project-deployments.environment.variables.provider.MODE';
  await vi.waitFor(() => expect(screen.findByTestId(key)).not.toBeNull());
  expect(reads).toHaveLength(1);
  expect(screen.getTextContent()).not.toContain('provider-revision');
  await screen.pressByTestIdAsync(`${key}.${choice}`);
  await screen.pressByTestIdAsync('project-deployments.environment.variables.save');
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ providerVariables: { useOurs: choice === 'useOurs' ? ['MODE'] : [], keepTheirs: choice === 'keepTheirs' ? ['MODE'] : [] }, set: [], remove: [] });
  if (settlement === 'storage conflict') {
    await vi.waitFor(() => expect(screen.findByTestId('project-deployments.environment.variables.provider.unpersisted')).not.toBeNull());
    expect(screen.findByTestId('project-deployments.environment.variables.save')).not.toBeNull();
  } else {
    await vi.waitFor(() => expect(reads).toHaveLength(2));
  }
});


it.each(['hydrated', 'header-only'] as const)('adds a scoped Railway database reference from %s links to the reviewed Variables draft', async linkRead => {
  const serverId = await homes.addHome({ name: 'Railway Variables', serverUrl: `https://railway-variables-${linkRead}.test`,
    serverIdentityId: `srv_${(linkRead === 'hydrated' ? 'a' : 'c').repeat(32)}`, accountId: 'owner', currentAccount: true });
  const { plugin: railwayData } = await import('../../../../../../packages/plugins/deployment-railway/src/manifest');
  const { manifest: railwayRuntime } = await import('../../../../../../packages/plugins/deploy-railway/src/manifest');
  const runtimeTitle = 'Connected Railway';
  const runtimeTarget = railwayRuntime.contributes.deploymentTargets![0]!;
  const declarations = [{ manifest: railwayData.manifest }, { manifest: { ...railwayRuntime,
    contributes: { ...railwayRuntime.contributes, deploymentTargets: [{ ...runtimeTarget, title: runtimeTitle }] } },
  }];
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
  const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployments/testing/v1');
  const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
  const context = await captureLazyActionAccountContext(serverId);
  const lifetime = context.accountLifetime;
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: railwayData.manifest,
    activate: api => railwayData.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' }),
    accountLifetime: lifetime, publishProjection: true });
  const base = createDeploymentEnvironmentDetailV1();
  const environment = { ...base.environment, serverId };
  const connectedAccount = { service: { pluginId: 'happier.machine.railway', localId: 'railway-account' }, accountId: 'railway-account' };
  const projectId = 'shop-project';
  const railwayEnvironmentId = 'staging-id';
  const adopted = (role: 'runtime' | 'data', linkId: string, localId: string, pluginId: string, serviceId: string, environmentId: string) => ({
    targetLink: createDeploymentTargetLinkHeaderV1({ id: linkId, environmentId: environment.id, role,
      targetKind: role === 'runtime' ? 'railway' : 'railway-postgresql', machines: [], members: [], contentArtifactId: `artifact-${linkId}`,
      source: { kind: 'plugin', contribution: { pluginId, localId } } }),
    content: { providerIdentity: { providerAccountId: projectId, providerResourceId: serviceId, providerEnvironment: environmentId },
      providerEnvironment: { kind: 'native' as const, selection: { projectId, environmentId, serviceId } },
      preparedNative: { projectName: linkId },
      credentialPrincipal: { kind: 'account' as const, accountId: 'owner',
        purpose: { consumer: { pluginId, localId: role === 'runtime' ? 'service-link' : 'postgresql-link' }, purpose: 'cloud-api' },
        target: { kind: 'account' as const, account: connectedAccount } },
    },
  });
  const app = adopted('runtime', 'railway-app', 'runtime', 'happier.deploy.railway', 'app-service', railwayEnvironmentId);
  const other = adopted('data', 'other-database', 'postgresql', railwayData.manifest.id, 'other-service', 'production-id');
  const selected = adopted('data', 'orders-database', 'postgresql', railwayData.manifest.id, 'orders-service', railwayEnvironmentId);
  const detached = { targetLink: createDeploymentTargetLinkHeaderV1({
    ...selected.targetLink, id: 'detached-database', contentArtifactId: 'artifact-detached-database', state: 'detached', detachedAtMs: 1,
  }) };
  const databaseLinks = [other, selected];
  if (linkRead === 'header-only') {
    for (const { targetLink, content } of databaseLinks) {
      await context.createArtifactDocument({ artifactId: targetLink.contentArtifactId,
        header: { kind: 'deployment-target-link.v1', title: content.preparedNative.projectName }, body: JSON.stringify(content) });
    }
  }
  const detail = { ...base, environment: { ...environment, runtimeTargetLinkId: app.targetLink.id },
    targetLinks: [app, detached, ...databaseLinks.map(row => linkRead === 'hydrated' ? row : { targetLink: row.targetLink })],
    content: { ...base.content, bindings: [] }, runtimeTargetLink: null, memberVersions: {}, secretRevisions: [], builtInUrls: [] };
  const observations: unknown[] = [];
  const admissionFailures: string[] = [];
  const writes: unknown[] = [];
  const reference = '${{Orders.DATABASE_URL}}';
  const referenceAction = railwayData.manifest.contributes.actions.find(action => action.id === 'postgresql-connection-reference')!;
  const validReferenceInput = compilePluginJsonSchema(referenceAction.inputSchema);
  homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, {
    body: { ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink) } });
  await answerExternalActionAccountForHome(homes, serverId, { actionId: 'action.invoke', requesterInvocation: 'required',
    machineId: detail.environment.controllerMachineId, tokenEpoch: 0,
    failure: output => typeof output === 'object' && output !== null && 'code' in output && typeof output.code === 'string'
      ? { errorCode: output.code, error: output.code } : null,
    execute: raw => {
      const invocation = getActionSpec('action.invoke').inputSchema.parse(raw);
      observations.push(invocation);
      const input = invocation.input;
      if (!validReferenceInput(input)) {
        admissionFailures.push('invalid_parameters');
        return { code: 'invalid_parameters' };
      }
      const stored = input && typeof input === 'object' && 'targetLinkId' in input
        ? databaseLinks.find(row => row.targetLink.id === input.targetLinkId) : undefined;
      if (!stored || !input || typeof input !== 'object' || !('preparedNative' in input)
        || !sameStrictJsonValue(input.preparedNative, stored.content.preparedNative)) {
        admissionFailures.push('deployment_access_denied');
        return { code: 'deployment_access_denied' };
      }
      if (stored !== other) return { reference };
      admissionFailures.push('target_mismatch');
      return { code: 'target_mismatch' };
    } });
  await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.bindings.set',
    machineId: detail.environment.controllerMachineId, tokenEpoch: 0, execute: raw => {
      writes.push(DeploymentActionInputSchemasV1['deployments.bindings.set'].parse(raw));
      return { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 };
    } });
  const actions = createDeploymentActions(lifetime, detail.environment.projectSourceId);
  function Page() {
    const draft = useEnvironmentSecretBindingsDraft({ environmentId: detail.environment.id, lifetime,
      snapshot: { status: 'ready', value: detail, failure: null }, setBindings: actions.setBindings });
    return <DeploymentVariablesPanel draft={draft} phone environmentName={() => null} sealedOn={null}
      review={{ pendingId: null, request() {}, open() {} }} environmentId={detail.environment.id}
      projectSourceId={detail.environment.projectSourceId} providerTargetLinkId={app.targetLink.id} providerVariablesActive={false}
      scope={lifetime.scope} lifetime={lifetime} providerDatabase={{ detail, declarations, inspect: actions.inspectPlatformTarget }} />;
  }
  const databaseArtifactIds = new Set([...databaseLinks, detached].map(row => row.targetLink.contentArtifactId));
  const databaseReads = () => homes.requestsFor('/v1/artifacts/read').map(request => request.input)
    .filter(input => input && typeof input === 'object' && 'artifactIds' in input
      && Array.isArray(input.artifactIds) && input.artifactIds.some(id => databaseArtifactIds.has(id)));
  const beforeReads = databaseReads().length;
  const screen = await renderScreen(<ListPresentationProvider value="page"><Page /></ListPresentationProvider>, {
    createNodeMock: element => element.type === 'div' ? document.createElement('div')
      : ({ offsetTop: 0, offsetHeight: 44, scrollTo() {}, getBoundingClientRect: () => new DOMRect(0, 0, 320, 44) }),
  });
  try {
    const add = 'project-deployments.environment.variables.add';
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    expect(observations).toEqual([]);
    expect(databaseReads()).toHaveLength(beforeReads);
    await screen.pressByTestIdAsync(add);
    const menu = () => screen.findAllByType(DropdownMenu).find(node => node.props.items?.some((item: { id: string }) => item.id === 'providerDatabase'));
    await vi.waitFor(() => expect(menu()?.props.open).toBe(true));
    expect(menu()!.props.items.find((item: { id: string }) => item.id === 'providerDatabase')?.title).toContain(runtimeTitle);
    await act(async () => menu()!.props.onSelect('providerDatabase'));
    await act(async () => screen.changeTextByTestId(`${add}.name`, 'APP_DATABASE'));
    const { ValueFieldSelect } = await import('@/components/ui/forms/ValueFieldSelect');
    const selector = () => screen.findAllByType(ValueFieldSelect).find(node => node.props.testID === `${add}.railwayDatabase.source`)!;
    expect(selector().props.selectedId).toBeNull();
    expect(selector().props.items.map(({ id }: { id: string }) => id)).toEqual(databaseLinks.map(row => row.targetLink.id));
    expect(databaseReads().slice(beforeReads)).toEqual(
      linkRead === 'header-only' ? [{ artifactIds: databaseLinks.map(row => row.targetLink.contentArtifactId) }] : [],
    );
    expect(observations).toEqual([]);
    await act(async () => selector().props.onSelect(other.targetLink.id));
    await screen.pressByTestIdAsync(`${add}.save`);
    await vi.waitFor(() => expect(screen.findByTestId(`${add}.railwayDatabase.failed`)).not.toBeNull());
    expect(admissionFailures).toEqual(['target_mismatch']);
    expect(writes).toEqual([]);
    await act(async () => selector().props.onSelect(selected.targetLink.id));
    await screen.pressByTestIdAsync(`${add}.save`);
    await vi.waitFor(() => expect(screen.findByTestId('project-deployments.environment.variables.save')).not.toBeNull());
    expect(writes).toEqual([]);
    expect(observations).toEqual([expect.objectContaining({ input: expect.objectContaining({ targetLinkId: other.targetLink.id }) }),
      expect.objectContaining({ action: { pluginId: railwayData.manifest.id, localId: 'postgresql-connection-reference' },
        input: expect.objectContaining({ targetLinkId: selected.targetLink.id, providerIdentity: selected.content.providerIdentity,
          preparedNative: selected.content.preparedNative,
          runtimeProviderIdentity: app.content.providerIdentity, runtimeProviderEnvironment: app.content.providerEnvironment }) })]);
    await screen.pressByTestIdAsync('project-deployments.environment.variables.save');
    await vi.waitFor(() => expect(writes).toEqual([expect.objectContaining({ environmentId: detail.environment.id,
      set: [{ purpose: 'variable', name: 'APP_DATABASE', phase: 'runtime', grantRef: expect.any(String),
        source: { kind: 'value', value: reference } }], remove: [] })]));
  } finally { await screen.unmount(); await installed.dispose(); context.dispose(); }
});

it('draws no At provider column when the provider read failed, only the retryable notice (RAILWAY-VISUAL-ACCEPT D3)', async () => {
  const serverId = await homes.addHome({ name: 'Failed Provider Read', serverUrl: 'https://variables-provider-failed.test',
    serverIdentityId: `srv_${'b'.repeat(32)}`, accountId: 'owner', currentAccount: true });
  const base = createDeploymentEnvironmentDetailV1();
  const detail = { ...base, environment: { ...base.environment, serverId }, content: { ...base.content,
    bindings: [{ purpose: 'variable' as const, name: 'MODE', phase: 'runtime' as const, source: { kind: 'value' as const, value: 'production' } }] } };
  const targetLink = detail.targetLinks[0]!.targetLink;
  const lifetime = { scope: { serverId, accountId: 'owner' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
  homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, {
    body: { ok: true, environment: detail.environment, targetLinks: [targetLink] } });
  await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.observation.get',
    machineId: detail.environment.controllerMachineId, tokenEpoch: 0,
    failure: () => ({ errorCode: 'provider_unavailable', error: 'provider_unavailable' }),
    execute: () => { throw new Error('The failed read has no result'); } });
  const actions = createDeploymentActions(lifetime, detail.environment.projectSourceId);
  function Page() {
    const draft = useEnvironmentSecretBindingsDraft({ environmentId: detail.environment.id, lifetime,
      snapshot: { status: 'ready', value: detail, failure: null }, setBindings: actions.setBindings });
    return <DeploymentVariablesPanel draft={draft} phone={false} environmentName={() => null} sealedOn={null}
      review={{ pendingId: null, request() {}, open() {} }} environmentId={detail.environment.id}
      projectSourceId={detail.environment.projectSourceId} providerTargetLinkId={targetLink.id} providerVariablesActive
      scope={lifetime.scope} lifetime={lifetime} />;
  }
  const screen = await renderScreen(<ListPresentationProvider value="page"><Page /></ListPresentationProvider>, {
    createNodeMock: () => ({ offsetTop: 0, offsetHeight: 44, scrollTo() {}, getBoundingClientRect: () => new DOMRect(0, 0, 1200, 44) }),
  });
  await measureMountedCollections(screen);
  await vi.waitFor(() => expect(screen.findByTestId('project-deployments.environment.variables.provider.unavailable')).not.toBeNull());
  await measureMountedCollections(screen);
  const text = screen.getTextContent();
  expect(text).toContain('Value from');
  expect(text).not.toContain('At provider');
});
