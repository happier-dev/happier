import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { HappierValidationMessage } from '@happier-dev/plugin-ui/presentation';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { buildDeferredDaemonProjectionSections, PluginProjectedActionV2Schema, PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { EffectiveInputField } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import * as railway from '../../../../../../packages/plugins/deploy-railway/src/index.js';
import { act, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
  renderCustomModals: true, settleTransientConfirmations: false,
}).module);
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/sessionOpsNetworkBoundary'))
  .createSessionOpsSocketIoClientBoundary(importOriginal));

vi.mock('@/components/ui/popover/Popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal as never) as never);

const homes = createHomeGovernanceHarness();
const network = await installSessionOpsNetworkBoundary();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
const { storage } = await import('@/sync/domains/state/storageStore');
const { ModalProvider } = await import('@/modal');
const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
const { useRailwayScopeChoices } = await import('./useRailwayScopeChoices');

const fields = [
  { path: 'projectId', title: 'Railway project', inputType: { pluginId: railway.manifest.id, localId: 'railway-project' },
    widget: 'select', visible: true, required: true, disabled: false },
  { path: 'environmentId', title: 'Railway environment', inputType: { pluginId: railway.manifest.id, localId: 'railway-environment' },
    widget: 'select', visible: true, required: true, disabled: false },
] as const satisfies readonly EffectiveInputField[];
const credential = { service: { pluginId: 'happier.machine.railway', localId: 'railway-account' }, accountId: 'railway-connection' };
const published = [{ manifest: railway.manifest }];

it('reviews a Railway project from the picker and selects the new project and its default environment after approval', async () => {
  const serverId = await homes.addHome({ name: 'Railway picker', serverUrl: 'https://railway-picker.test',
    serverIdentityId: 'srv_railway_picker', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: railway.manifest,
    activate: api => railway.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' }),
    accountLifetime: account.accountLifetime, publishProjection: true });
  const actionsById = Object.fromEntries(Object.entries(installed.projection.actionsById).map(([id, action]) => [id,
    Object.fromEntries(Object.entries(action).filter(([field]) => Object.hasOwn(PluginProjectedActionV2Schema.shape, field))),
  ]));
  const snapshot = buildDeferredDaemonProjectionSections({ protocolVersion: 1, projectionDigest: 'a'.repeat(64), projection:
    PluginProjectionV2Schema.parse({ v: 2, generation: 1, actionsById,
      installedPackagesById: {}, agentsById: {}, settingsById: {}, diagnostics: [] }) });
  network.setRpcResponder(async request => {
    expect(request.method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
    const read = (request.payload as { sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } })?.sectionRead;
    return read ? snapshot.read(read.digest, read.offset, read.includeDigests) : snapshot.manifest;
  });
  storage.setState({ profileScope: account.accountLifetime.scope, profile: { ...storage.getState().profile,
    connectedAccountsV4: [QualifiedConnectedAccountProfileV4Schema.parse({ ref: credential, status: 'connected',
      authenticationModeId: 'token', configurationReady: true, configurationRevision: 'configuration',
      revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] })] } });
  const writes: unknown[] = [];
  const kit = await createPluginTestkit({ manifest: railway.manifest, module: railway, services: { http:
    createPluginHttpFixture({ async request(request) {
      expect(request.url).toBe('https://backboard.railway.com/graphql/v2');
      const payload = JSON.parse(new TextDecoder().decode(request.body));
      expect(payload.query).toContain('projectCreate');
      writes.push(payload.variables);
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ data: { projectCreate: {
        id: 'orders-project', name: 'Order processing', workspaceId: 'workshop',
        baseEnvironment: { id: 'default-environment', name: 'Production' },
      } } })) };
    } }),
  } });
  const machineId = 'controller';
  const installationId = 'controller-installation';
  await publishMachineInventoryForTest(account, [createMachineFixture({ id: machineId, installationId, activeAt: Date.now(), access: {
    custodian: { accountId: account.accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready',
  } })]);
  let handlerInvocations = 0;
  await answerExternalActionAccountForHome(homes, serverId, { actionId: ACTION_INVOKE_ACTION_ID_V1, machineId, installationId,
    tokenEpoch: 0, requesterInvocation: 'required', execute: raw => {
      handlerInvocations++;
      const input = getActionSpec(ACTION_INVOKE_ACTION_ID_V1).inputSchema.parse(raw);
      expect(input.action.pluginId).toBe(railway.manifest.id);
      return kit.invokeAction(input.action.localId, input.input);
    } });
  function Picker() {
    const [values, setValues] = React.useState<Record<string, unknown>>({ workspaceId: 'workshop' });
    const choices = useRailwayScopeChoices({ declarations: published, lifetime: account.accountLifetime, account: credential,
      fields, values, onCreated: created => setValues(current => ({ ...current, ...created })) });
    return <ActionInputFields fields={fields} input={values} editable resolveFieldTestID={field => 'scope.' + field.path}
      resolveChoiceAction={choices.choiceAction} resolveFieldOptions={choices.withCreatedChoices(() => [])} onPatch={setValues} />;
  }
  const screen = await renderScreen(<ModalProvider><Picker /></ModalProvider>);
  try {
    const picker = () => screen.findAllByType(ActionInputFields).find(node => node.props.fields === fields)!;
    const trigger = screen.findAllByType('Pressable').find(node =>
      String(node.props.accessibilityLabel ?? '').startsWith('Railway project:'));
    expect(trigger).toBeDefined();
    await pressTestInstanceAsync(trigger);
    const create = screen.findAllByType('Pressable').find(node =>
      String(node.props.accessibilityLabel ?? '').startsWith('Create Railway project'));
    expect(create).toBeDefined();
    await pressTestInstanceAsync(create);
    const form = () => screen.findAllByType(ActionInputFields).find(node => node.props.fields.some(
      (field: EffectiveInputField) => field.path === 'name'))!;
    expect(form()).toBeDefined();
    await act(async () => form().props.onPatch({ name: 'Order processing' }));
    await screen.pressByTestIdAsync('plugin-contributed-action-form-submit');
    const approval = () => screen.findByTestId('app-shell-confirmation-confirm');
    const issue = () => JSON.stringify({
      error: screen.findAllByType(HappierValidationMessage).find(node => node.props.testID === 'plugin-contributed-action-form-error')?.props.message,
      rpc: network.requests.map(request => request.method),
      routes: [...new Set(homes.requests.map(request => request.path.split('?')[0]))],
      handlerInvocations, writes: writes.length,
    });
    await waitForHomeGovernance(() => expect(approval(), issue()).not.toBeNull());
    expect(writes).toEqual([]);
    await pressTestInstanceAsync(approval());
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(writes, issue()).toHaveLength(1);
      expect(picker().props.input, issue()).toMatchObject({ projectId: 'orders-project', environmentId: 'default-environment' });
    });
    expect(picker().props.resolveFieldOptions(fields[0])).toEqual([{ value: 'orders-project', label: 'Order processing' }]);
    expect(picker().props.resolveFieldOptions(fields[1])).toEqual([{ value: 'default-environment', label: 'Production' }]);
    expect(writes).toEqual([{ input: { name: 'Order processing', workspaceId: 'workshop' } }]);
  } finally {
    await screen.unmount();
    await kit.dispose();
    await installed.dispose();
    account.dispose();
    await homes.reset();
    await network.dispose();
    standardCleanup();
  }
});
