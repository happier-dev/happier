import * as React from 'react';
import { afterAll, expect, it, vi } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { HappierInputField, HappierValidationMessage } from '@happier-dev/plugin-ui/presentation';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { PluginProjectedActionV2Schema, PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { EffectiveInputField } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import * as railway from '../../../../../../packages/plugins/deploy-railway/src/index.js';
import { TechnicalDetailsDisclosure } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { act, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture, createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
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
afterAll(() => network.dispose());
const { EncryptionCache } = await import('@/sync/encryption/encryptionCache');
const { MachineEncryption } = await import('@/sync/encryption/machineEncryption');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
const { storage } = await import('@/sync/domains/state/storageStore');
const { ModalProvider } = await import('@/modal');
const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
const { useActionFieldCreation } = await import('./useActionFieldCreation');
const { createActionInputForm } = await import('@/components/plugins/actions/actionInputForm');
const { ActionInputFormModal } = await import('@/components/plugins/actions/ActionInputFormModal');

const fields = [
  { path: 'projectId', title: 'Railway project', createNew: {
    action: { pluginId: railway.manifest.id, localId: 'project-create' },
    initialInput: { workspaceId: { path: 'workspaceId' } },
    result: { valuePath: 'project.id', labelPath: 'project.name' },
    alsoSelect: { environmentId: { valuePath: 'environmentSelection', labelPath: 'environment.name' } },
    duplicateName: { path: 'name', message: 'A project with that name already exists.',
      source: { kind: 'railway-workspace', inputPath: 'workspaceId' } },
  }, inputType: { pluginId: 'com.example.picker', localId: 'projects' },
    widget: 'select', visible: true, required: true, disabled: false },
  { path: 'environmentId', title: 'Railway environment', optionsDraftDependencies: ['projectId'], createNew: {
    action: { pluginId: railway.manifest.id, localId: 'environment-create' },
    initialInput: { projectId: { path: 'projectId', required: true } },
    result: { valuePath: 'id', labelPath: 'name' },
    duplicateName: { path: 'name', message: 'An environment with that name already exists.' },
  }, inputType: { pluginId: 'com.example.picker', localId: 'environments' },
    widget: 'select', visible: true, required: true, disabled: false },
] as const satisfies readonly EffectiveInputField[];
const credential = { service: { pluginId: 'happier.machine.railway', localId: 'railway-account' }, accountId: 'railway-connection' };
const published = [{ manifest: railway.manifest }];

it.each(['blank', 'duplicate', 'duplicate environment', 'available', 'standalone form'] as const)('handles %s in the declared choice creator', async (scenario) => {
  network.resetRequests();
  installHomeGovernanceBoundaries(homes);
  const credentials = { token: createAccountTokenForTests('owner', { currentAccount: true }),
    secret: encodeBase64(new Uint8Array(32).fill(17), 'base64url') };
  const serverId = await homes.addHome({ name: 'Railway picker', serverUrl: 'https://railway-picker.test',
    serverIdentityId: 'srv_railway_picker', accountId: 'owner', currentAccount: true, accountEncryptionMode: 'e2ee', credentials });
  homes.answer(serverId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
  const account = await captureLazyActionAccountContext(serverId);
  const machineId = 'controller';
  const { encryption } = await account.resolveAccountEncryption();
  if (!encryption) throw new Error('Expected encrypted Account test credentials');
  const encryptor = await encryption.openEncryption(null);
  const cipher = new MachineEncryption(machineId, encryptor, new EncryptionCache());
  const content = { mode: 'e2ee' as const, cipher };
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: railway.manifest,
    activate: api => railway.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' }),
    accountLifetime: account.accountLifetime, publishProjection: true });
  const actionsById = Object.fromEntries(Object.entries(installed.projection.actionsById).map(([id, action]) => [id,
    Object.fromEntries(Object.entries(action).filter(([field]) => Object.hasOwn(PluginProjectedActionV2Schema.shape, field))),
  ]));
  const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, actionsById,
    installedPackagesById: {}, agentsById: {}, settingsById: {}, diagnostics: [] });
  network.setRpcAckResponder(async request => {
    expect(request.method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
    const decoded = await socketRpcCodec.decodeRequestParams(content, request.payload, `${request.targetId}:${request.method}`);
    const result = { protocolVersion: 1, projection };
    return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
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
      if (payload.query.includes('workspaces')) return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ data: {
        me: { workspaces: [{ id: 'workshop', name: 'Workshop' }] }, externalWorkspaces: [],
      } })) };
      expect(payload.query).toContain('projectCreate');
      writes.push(payload.variables);
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ data: { projectCreate: {
        id: 'orders-project', name: 'Order processing', workspaceId: 'workshop',
        baseEnvironment: null, environments: { edges: [{ node: { id: 'default-environment', name: 'production' } }] },
      } } })) };
    } }),
  } });
  const installationId = 'controller-installation';
  let handlerInvocations = 0;
  const boundary = await answerExternalActionAccountForHome(homes, serverId, { actionId: ACTION_INVOKE_ACTION_ID_V1, machineId, installationId,
    tokenEpoch: 0, requesterInvocation: 'required', execute: raw => {
      handlerInvocations++;
      const input = getActionSpec(ACTION_INVOKE_ACTION_ID_V1).inputSchema.parse(raw);
      expect(input.action.pluginId).toBe(railway.manifest.id);
      return kit.invokeAction(input.action.localId, input.input);
    } });
  const installationPublicKey = boundary.machine.installationPublicKey;
  if (!installationPublicKey) throw new Error('Expected a published test installation key');
  const metadata = createMachineMetadataFixture({ installationPublicKey });
  boundary.machine.metadata = encodeBase64((await encryptor.encrypt([metadata]))[0]!, 'base64');
  await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({ id: machineId, installationId,
    installationPublicKey, metadata, activeAt: Date.now(), storageMode: 'e2ee',
    dataEncryptionKey: boundary.machine.dataEncryptionKey, access: boundary.machine.access })]);
  const existing = { value: 'existing-orders', label: 'Warehouse orders',
    source: { kind: 'railway-workspace', locator: 'workshop' } };
  const staging = { value: 'existing-staging', label: 'Staging' };
  const neighboring = { value: 'neighboring-orders', label: 'Order processing',
    source: { kind: 'railway-workspace', locator: 'another-workspace' } };
  const environmentScenario = scenario === 'duplicate environment';
  const resolveOptions = (field: { path?: string }) =>
    field.path === 'projectId' ? [existing, neighboring] : environmentScenario ? [staging] : [];
  function Picker() {
    const [values, setValues] = React.useState<Record<string, unknown>>(environmentScenario ? { projectId: existing.value } : {});
    const choices = useActionFieldCreation({ declarations: published, lifetime: account.accountLifetime, enabled: true, account: credential,
      fields, values, onCreated: created => setValues(current => ({ ...current, ...created })) });
    return <ActionInputFields fields={fields} input={values} editable resolveFieldTestID={field => 'scope.' + field.path}
      resolveChoiceAction={field => choices.choiceAction(field, choices.withCreatedChoices(resolveOptions))}
      resolveFieldOptions={choices.withCreatedChoices(resolveOptions)} onPatch={setValues} />;
  }
  const standalone = scenario === 'standalone form';
  const standaloneForm = createActionInputForm({
    presentation: {
      title: 'External plugin settings', description: null,
      inputHints: { fields: [
        { ...fields[0], inputType: undefined, options: [existing, neighboring] },
        { ...fields[1], inputType: undefined, options: [] },
      ] },
    },
    accountLifetime: account.accountLifetime,
    initialInput: { credentialRef: credential },
    submit: async () => ({ ok: true }),
  });
  const screen = await renderScreen(<ModalProvider>{standalone
    ? <ActionInputFormModal form={standaloneForm} onClose={() => {}} pickerContext={{
      accountLifetime: account.accountLifetime,
      serverId,
      pluginUiProjection: installed.projection,
    }} />
    : <Picker />}</ModalProvider>);
  try {
    const picker = () => screen.findAllByType(ActionInputFields).find(node =>
      node.props.fields.some((field: EffectiveInputField) => field.path === 'environmentId'))!;
    const trigger = screen.findAllByType('Pressable').find(node =>
      String(node.props.accessibilityLabel ?? '').startsWith(environmentScenario ? 'Railway environment:' : 'Railway project:'));
    expect(trigger).toBeDefined();
    await pressTestInstanceAsync(trigger);
    const create = screen.findAllByType('Pressable').find(node =>
      String(node.props.accessibilityLabel ?? '').startsWith(environmentScenario ? 'Create Railway environment' : 'Create Railway project'));
    expect(create).toBeDefined();
    await pressTestInstanceAsync(create);
    const form = () => screen.findAllByType(ActionInputFields).find(node => node.props.fields.some(
      (field: EffectiveInputField) => field.path === 'name'))!;
    expect(form()).toBeDefined();
    if (!environmentScenario) {
      expect(form().props.input.workspaceId).toBeUndefined();
      await act(async () => form().props.onPatch({ workspaceId: 'workshop' }));
    }
    const submitDisabled = () => {
      const submit = screen.findByTestId('plugin-contributed-action-form-submit');
      return submit.props.disabled ?? submit.props.accessibilityState?.disabled;
    };
    // A duplicate name is said once, under the name field it is about, not at the form's foot.
    const nameIssue = () => screen.findAllByType(HappierInputField).find(node => node.props.field.path === 'name')?.props.issue;
    if (scenario !== 'available' && !standalone) {
      if (scenario === 'duplicate') {
        await act(async () => form().props.onPatch({ name: '  WAREHOUSE orders  ' }));
        const validation = screen.findAllByType(HappierValidationMessage)
          .filter(node => node.props.message === 'A project with that name already exists.');
        expect(validation).toHaveLength(1);
        expect(nameIssue()).toBe('A project with that name already exists.');
      } else if (environmentScenario) {
        await act(async () => form().props.onPatch({ name: '  STAGING  ' }));
        expect(screen.findAllByType(HappierValidationMessage)
          .filter(node => node.props.message === 'An environment with that name already exists.')).toHaveLength(1);
        expect(nameIssue()).toBe('An environment with that name already exists.');
      } else {
        // A blank name says what goes there, and says nothing else until it is typed.
        expect(screen.findAllByType(HappierInputField).find(node => node.props.field.path === 'name')?.props.field.placeholder)
          .toBeTruthy();
        expect(nameIssue()).toBeUndefined();
        expect(submitDisabled()).toBe(true);
        await act(async () => form().props.onPatch({ name: '  ' }));
      }
      expect(submitDisabled()).toBe(true);
      expect(handlerInvocations).toBe(0);
      expect(writes).toEqual([]);
      await act(async () => form().props.onPatch({ name: 'Order processing' }));
      expect(submitDisabled()).not.toBe(true);
      expect(screen.findAllByType(HappierValidationMessage)).toHaveLength(0);
      return;
    }
    await act(async () => form().props.onPatch({ name: 'Order processing' }));
    await screen.pressByTestIdAsync('plugin-contributed-action-form-submit');
    const approval = () => screen.findByTestId('app-shell-confirmation-confirm');
    const issue = () => JSON.stringify({
      error: screen.findAllByType(HappierValidationMessage).find(node => node.props.testID === 'plugin-contributed-action-form-error')?.props.message,
      code: screen.findAllByType(TechnicalDetailsDisclosure).find(node => node.props.testID === 'plugin-contributed-action-form-error-details')
        ?.props.lines.find((line: { key: string }) => line.key === 'code')?.value,
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
      expect(picker().props.input, issue()).toMatchObject({ projectId: 'orders-project', environmentId: {
        kind: 'native', selection: { projectId: 'orders-project', environmentId: 'default-environment' },
      } });
    });
    const { fields: renderedFields, resolveFieldOptions } = picker().props;
    expect(resolveFieldOptions(renderedFields[0])).toEqual([existing, neighboring, { value: 'orders-project', label: 'Order processing',
      source: { kind: 'railway-workspace', locator: 'workshop' } }]);
    expect(resolveFieldOptions(renderedFields[1])).toEqual([{
      value: { kind: 'native', selection: { projectId: 'orders-project', environmentId: 'default-environment' } }, label: 'production',
    }]);
    expect(writes).toEqual([{ input: { name: 'Order processing', workspaceId: 'workshop' } }]);
  } finally {
    await screen.unmount();
    await kit.dispose();
    await installed.dispose();
    account.dispose();
    await homes.reset();
    standardCleanup();
  }
});
