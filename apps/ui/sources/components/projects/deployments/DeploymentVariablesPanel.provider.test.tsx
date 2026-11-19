// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
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
