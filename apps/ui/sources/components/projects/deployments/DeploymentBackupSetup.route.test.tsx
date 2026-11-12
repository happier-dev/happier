// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentBackupConfigurationV1Schema } from '@happier-dev/deployment-protocol';
import { selectDeploymentRuntimeTargetLinkV1 } from '@happier-dev/deployments';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/backup-destinations/src/manifest';
import { BACKUP_RECEIVER_RECIPE } from '../../../../../../packages/plugins/machine-recipes/src/backupReceiver';
import { BACKUP_RECEIVER_RECIPE_REF_V1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import { SFTP_BACKUP_DESTINATION_REF_V1 } from '@happier-dev/protocol/plugins/contributions/backupDestinations';
import { deploymentBackupPolicyV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { createWorkflowAutomationDetailFixture, createWorkflowAutomationHttpBoundary } from '@/dev/testkit/harness/workflowAutomationHttpBoundary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
const modal = vi.hoisted(() => ({ show: vi.fn(() => 'backup-setup') }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: modal }).module);
const route = vi.hoisted(() => ({ environmentId: 'environment-staging', push: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
  params: () => ({ deploymentEnvironment: route.environmentId, deploymentSetup: 'backups' }),
  router: { push: route.push },
}).module);
const transport = vi.hoisted(() => ({ read: vi.fn() }));
// The daemon RPC is the only substituted producer; catalog admission and setup remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
  (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(request => transport.read(request)));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { formatAutomationScheduleLabel } = await import('@/components/automations/list/automationListFormatting');
const { t } = await import('@/text');
const { formatMachineBytes } = await import('@/components/machines/vitals/machineVitalsPresentation');
const { Item } = await import('@/components/ui/lists/Item');
const { DeploymentBackupSetup, DeploymentBackupSetupSheet, DeploymentBackupDestinationRow, DeploymentBackupScheduleRow } = await import('./DeploymentBackupControls');
const { ValueFieldSelect } = await import('@/components/ui/forms/ValueFieldSelect');
const { EnvironmentMachineChoice } = await import('./EnvironmentMachineChoice');
const { MachineSetupRecipeInputs } = await import('@/components/settings/machines/managed/MachineSetupRecipeInputs');
const { HappierInputField } = await import('@happier-dev/plugin-ui/presentation');
afterEach(() => { standardCleanup(); modal.show.mockClear(); transport.read.mockReset(); });

it('opens the canonical restore-drill starter for this Home without starting a restore', async () => {
  const detail = { ...createDeploymentEnvironmentDetailV1(), runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
  const configuration = DeploymentBackupConfigurationV1Schema.parse({ configRevision: 1,
    destinationRef: SFTP_BACKUP_DESTINATION_REF_V1, occurrenceId: 'sftp', config: {}, credentialBindings: [],
    sources: [{ kind: 'volume', sourceId: 'content', service: 'web', volume: 'content', consistency: 'stopDuringCopy' }],
    ownership: { environmentId: detail.environment.id, prefix: '' }, retention: { kind: 'keepEverything' } });
  const screen = await renderScreen(<DeploymentBackupScheduleRow detail={detail} configuration={configuration}
    actions={null} testID="backups" />);
  try {
    await screen.pressByTestIdAsync('backups.drill');
    expect(route.push).toHaveBeenCalledWith({ pathname: '/workflows/new', params: {
      example: 'restore-drill', serverId: detail.environment.serverId,
    } });
    expect(transport.read).not.toHaveBeenCalled();
  } finally { await screen.unmount(); route.push.mockClear(); }
});

it('shows a failed schedule read with its code, request id and Retry, not a bare Unavailable', async () => {
  const detail = { ...createDeploymentEnvironmentDetailV1(), runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
  const configuration = DeploymentBackupConfigurationV1Schema.parse({ configRevision: 1,
    destinationRef: SFTP_BACKUP_DESTINATION_REF_V1, occurrenceId: 'sftp', config: {}, credentialBindings: [],
    sources: [{ kind: 'volume', sourceId: 'content', service: 'web', volume: 'content', consistency: 'stopDuringCopy' }],
    ownership: { environmentId: detail.environment.id, prefix: '' }, retention: { kind: 'keepEverything' } });
  const { HappyError } = await import('@/utils/errors/errors');
  // The page's actions owner is the injected seam; its read refuses as the Action front door does.
  const backupScheduleSets = vi.fn(async () => { throw new HappyError('internal_error', false,
    { code: 'internal_error', requestId: '5b2057fb-request' }); });
  const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
  const screen = await renderScreen(<DeploymentBackupScheduleRow detail={detail} configuration={configuration}
    actions={{ backupScheduleSets } as never} testID="backups" />);
  try {
    const card = () => screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'backups.schedule.failed');
    await vi.waitFor(() => expect(card()).toBeDefined());
    expect(card()!.props.diagnosticCode).toBe('internal_error');
    expect(card()!.props.diagnosticDetail).toContain('5b2057fb-request');
    await act(async () => { card()!.props.action.onPress(); });
    await vi.waitFor(() => expect(backupScheduleSets).toHaveBeenCalledTimes(2));
  } finally { await screen.unmount(); }
});

it('reads local path capacity on the runtime Machine before Test, on path changes and when the saved destination reopens', async () => {
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Backup path capacity', serverUrl: 'https://backup-capacity.test',
    accountId: 'alice', currentAccount: true });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const account = await captureLazyActionAccountContext(serverId);
  const initial = createDeploymentEnvironmentDetailV1();
  const runtime = selectDeploymentRuntimeTargetLinkV1(initial);
  if (!runtime) throw new Error('Expected runtime target fixture');
  const runtimeMachineId = 'backup-runtime-machine';
  const replacementMachineId = 'replacement-runtime-machine';
  const detail = { ...initial, environment: { ...initial.environment, serverId },
    runtimeTargetLink: { ...runtime, machines: [runtimeMachineId],
      members: runtime.members.map(member => ({ ...member, machineId: runtimeMachineId })) },
    memberVersions: {}, secretRevisions: [] };
  await publishMachineInventoryForTest(account.accountLifetime.scope, [
    createMachineFixture({ id: runtimeMachineId, activeAt: Date.now() }),
    createMachineFixture({ id: replacementMachineId, activeAt: Date.now() }),
    createMachineFixture({ id: detail.environment.controllerMachineId, activeAt: Date.now() }),
  ]);
  const definition = PLUGIN_MANIFEST.contributes.backupDestinations?.find(entry => entry.id === 'local');
  if (!definition) throw new Error('Expected local destination');
  const destination = { id: `${PLUGIN_MANIFEST.id}/${definition.id}`, pluginId: PLUGIN_MANIFEST.id,
    pluginVersion: PLUGIN_MANIFEST.version, definition };
  const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
    familiesById: { backupDestinations: { family: 'backupDestinations', entriesById: { [destination.id]: destination } } } });
  const reads: Array<{ machineId: string; path: string }> = [];
  let settlePreviousPath: ((value: unknown) => void) | undefined;
  transport.read.mockImplementation((request: { method: string; machineId: string; payload: { path: string } }) => {
    if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
      return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection });
    if (request.method === 'daemon.storage.path.capacity.get') {
      reads.push({ machineId: request.machineId, path: request.payload.path });
      if (request.payload.path === '/pending') return new Promise(resolve => { settlePreviousPath = resolve; });
      return request.payload.path === '/unavailable' ? { status: 'unknown', path: '/unavailable', reason: 'path_not_found' }
        : { status: 'known', path: request.payload.path, freeBytes: request.payload.path === '/full' ? 0
          : request.machineId === replacementMachineId ? 8192 : 4096,
          observedAt: 1794300000000, volume: { volumeId: 'archive', mountPath: '/archive-disk', label: 'Archive' } };
    }
    throw new Error(`Capacity review must not run a repository effect: ${request.method}`);
  });
  const configure = vi.fn<React.ComponentProps<typeof DeploymentBackupSetupSheet>['configure']>();
  const common = { detail, destination, lifetime: account.accountLifetime, machine: runtimeMachineId,
    testID: 'capacity-setup', sourceChoices: [{ kind: 'volume' as const, sourceId: 'content', service: 'web', volume: 'content', consistency: 'stopDuringCopy' as const }],
    review: { pendingId: null, request() {}, open() {} }, configure, onChanged() {}, onClose() {} };
  const screen = await renderScreen(<DeploymentBackupSetupSheet {...common} />);
  const changePath = (path: string) => act(async () => screen.findAllByType(HappierInputField)
    .find(field => field.props.field.path === 'path')!.props.onChange(path));
  try {
    await changePath('/backups');
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(formatMachineBytes(4096, 'storage')));
    await changePath('/pending');
    await vi.waitFor(() => expect(settlePreviousPath).toBeDefined());
    await changePath('/full');
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(formatMachineBytes(0, 'storage')));
    await act(async () => settlePreviousPath?.({ status: 'known', path: '/pending', freeBytes: 65536, observedAt: 1794300000000 }));
    expect(screen.getTextContent()).toContain(formatMachineBytes(0, 'storage'));
    expect(screen.getTextContent()).not.toContain(formatMachineBytes(65536, 'storage'));
    await changePath('/unavailable');
    // An unreadable path is the page's failure line: it names where, and keeps the typed cause behind Details (VISUAL-136 E3).
    await vi.waitFor(() => expect(screen.findAllByProps({ diagnosticCode: 'path_not_found' }).length).toBeGreaterThan(0));
    expect(screen.getTextContent()).not.toContain('path_not_found');
    expect(reads).toEqual(['/backups', '/pending', '/full', '/unavailable'].map(path => ({ machineId: runtimeMachineId, path })));
    expect(configure).not.toHaveBeenCalled();
    const configuration = DeploymentBackupConfigurationV1Schema.parse({ configRevision: 1,
      destinationRef: { pluginId: destination.pluginId, localId: definition.id }, occurrenceId: definition.id,
      config: { path: '/backups' }, credentialBindings: [], sources: common.sourceChoices,
      ownership: { environmentId: detail.environment.id, prefix: '' }, retention: { kind: 'keepEverything' } });
    await act(async () => screen.update(<DeploymentBackupDestinationRow detail={detail} configuration={configuration}
      lifetime={account.accountLifetime} actions={null} testID="capacity-saved" />));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(formatMachineBytes(4096, 'storage')));
    expect(reads.at(-1)).toEqual({ machineId: runtimeMachineId, path: '/backups' });
    expect(reads).toHaveLength(5);
    await act(async () => screen.update(<DeploymentBackupDestinationRow detail={{ ...detail, runtimeTargetLink: {
      ...detail.runtimeTargetLink, machines: [replacementMachineId],
      members: detail.runtimeTargetLink.members.map(member => ({ ...member, machineId: replacementMachineId })),
    } }} configuration={configuration} lifetime={account.accountLifetime} actions={null} testID="capacity-saved" />));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(formatMachineBytes(8192, 'storage')));
    expect(reads.at(-1)).toEqual({ machineId: replacementMachineId, path: '/backups' });
    await act(async () => screen.update(<DeploymentBackupDestinationRow detail={{ ...detail, runtimeTargetLink: null }}
      configuration={configuration} lifetime={account.accountLifetime} actions={null} testID="capacity-saved" />));
    expect(screen.getTextContent()).not.toContain(formatMachineBytes(4096, 'storage'));
    expect(screen.getTextContent()).not.toContain(formatMachineBytes(8192, 'storage'));
    expect(reads).toHaveLength(6);
  } finally { await screen.unmount(); account.dispose(); }
});

it('shows unknown local capacity before effects and keeps zero capacity eligible for Keep everything', async () => {
  const initial = createDeploymentEnvironmentDetailV1();
  const detail = { ...initial, runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
  const definition = PLUGIN_MANIFEST.contributes.backupDestinations?.find(entry => entry.id === 'local');
  if (!definition) throw new Error('Expected canonical local destination');
  const destination = { id: `${PLUGIN_MANIFEST.id}/${definition.id}`, pluginId: PLUGIN_MANIFEST.id,
    pluginVersion: PLUGIN_MANIFEST.version, definition };
  const configure = vi.fn<React.ComponentProps<typeof DeploymentBackupSetupSheet>['configure']>(async input => input.intent === 'test'
    ? { kind: 'tested', test: { kind: 'reachable', repositoryId: 'a'.repeat(64) },
      review: { capacity: { status: 'known', path: '/backups/repository', freeBytes: 0, observedAt: 1794300000000,
        volume: { volumeId: 'archive', mountPath: '/archive-disk', label: 'Archive' } } } }
    : { kind: 'configured', environmentId: detail.environment.id, revision: 2,
      configuration: DeploymentBackupConfigurationV1Schema.parse(input.configuration) });
  const screen = await renderScreen(<DeploymentBackupSetupSheet detail={detail} destination={destination}
    machine="Backup Machine" testID="local-setup" configure={configure}
    sourceChoices={[{ kind: 'volume', sourceId: 'content', service: 'web', volume: 'content', consistency: 'stopDuringCopy' }]}
    review={{ pendingId: null, request() {}, open() {} }} onChanged={() => {}} onClose={() => {}} />);
  try {
    expect(screen.findAllByType(Item).find(row => row.props.testID === 'local-setup.capacityReview')?.props.title)
      .toBe(t('projects.deployments.settingsSections.setupCapacityUnknown'));
    expect(configure).not.toHaveBeenCalled();
    await act(async () => screen.findAllByType(HappierInputField).find(field => field.props.field.path === 'path')!.props.onChange('/backups'));
    await screen.pressByTestIdAsync('local-setup.test');
    expect(screen.getTextContent()).toContain(formatMachineBytes(0, 'storage'));
    expect(screen.findAllByType(Item).find(row => row.props.testID === 'local-setup.capacity')?.props.subtitle)
      .toContain('/archive-disk');
    await screen.pressByTestIdAsync('local-setup.save');
    expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ intent: 'save',
      configuration: expect.objectContaining({ retention: { kind: 'keepEverything' } }) }));
  } finally { await screen.unmount(); }
});

it('shows the saved custom schedule for the stable Environment before a deployment exists', async () => {
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Scheduled backups', serverUrl: 'https://scheduled-backups.test',
    serverIdentityId: `srv_${'6'.repeat(32)}`, accountId: 'alice', currentAccount: true });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const account = await captureLazyActionAccountContext(serverId);
  const initial = createDeploymentEnvironmentDetailV1();
  const detail = { ...initial, environment: { ...initial.environment, serverId }, runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
  const configuration = DeploymentBackupConfigurationV1Schema.parse({ configRevision: 1,
    destinationRef: SFTP_BACKUP_DESTINATION_REF_V1, occurrenceId: 'sftp', config: {}, credentialBindings: [],
    sources: [{ kind: 'volume', sourceId: 'content', service: 'web', volume: 'content', consistency: 'stopDuringCopy' }],
    ownership: { environmentId: detail.environment.id, prefix: '' }, retention: { kind: 'keepEverything' } });
  const starter = getWorkflowStarterExamplesV1().find(entry => entry.key === 'nightly-backups');
  if (!starter) throw new Error('Expected canonical Nightly starter');
  const schedule = { kind: 'cron' as const, scheduleExpr: '30 3 * * *', everyMs: null, timezone: 'Europe/Amsterdam' };
  const initialRow = createWorkflowAutomationDetailFixture({ id: 'custom-backup-schedule', revision: 1,
    triggerId: 'custom-nightly', definition: starter.definition });
  const automations = createWorkflowAutomationHttpBoundary();
  automations.rows.set(initialRow.id, AutomationDefinitionDetailSchema.parse({ ...initialRow,
    executionRecipe: { ...initialRow.executionRecipe, workflow: { t: 'plain', v: {
      workspace: { directory: '~' }, executionTarget: { kind: 'detached_run' }, inlineDefinition: starter.definition,
      inputs: { backupEnvironment: { serverId: account.accountLifetime.scope.serverId, environmentId: detail.environment.id },
        backupPolicy: deploymentBackupPolicyV1(configuration), verificationLevel: 'manifestReadBack' } } } },
    triggers: initialRow.triggers.map(trigger => ({ ...trigger, schedule })) }));
  homes.answer(serverId, 'POST /v3/automations/query', { select: async (input, request) => {
    const response = await automations.handle(new URL(request.url), { ...request.init, body: JSON.stringify(input) });
    if (!response) throw new Error('Expected canonical Automation read boundary');
    const body: unknown = await response.json();
    expect(body).toEqual(expect.objectContaining({ automations: [expect.objectContaining({ id: initialRow.id })] }));
    return { status: response.status, body };
  } });
  const { createDeploymentActions } = await import('./deploymentActions');
  const actions = createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId);
  const screen = await renderScreen(<DeploymentBackupScheduleRow detail={detail} configuration={configuration}
    actions={actions} testID="backups" />);
  try {
    await vi.waitFor(() => expect(screen.findAllByType(Item).find(row => row.props.testID === 'backups.schedule')?.props.subtitle)
      .toContain(formatAutomationScheduleLabel({ schedule })));
    expect(automations.creates).toEqual([]);
  } finally { await screen.unmount(); account.dispose(); }
});

it('sets up another Machine through its receiver recipe and retains settled credentials from Test to Save', async () => {
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Receiver setup', serverUrl: 'https://receiver-setup.test',
    serverIdentityId: `srv_${'9'.repeat(32)}`, accountId: 'alice', currentAccount: true });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const account = await captureLazyActionAccountContext(serverId);
  const initial = createDeploymentEnvironmentDetailV1();
  const detail = { ...initial, environment: { ...initial.environment, serverId }, runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
  const receiver = createMachineFixture({ id: 'receiver', installationId: 'receiver-installation', activeAt: Date.now() });
  await publishMachineInventoryForTest(account.accountLifetime.scope, [
    createMachineFixture({ id: detail.environment.controllerMachineId, activeAt: Date.now() }), receiver,
  ]);
  const definition = PLUGIN_MANIFEST.contributes.backupDestinations?.find(entry => entry.id === SFTP_BACKUP_DESTINATION_REF_V1.localId);
  if (!definition) throw new Error('Expected canonical SFTP destination');
  const destination = { id: `${PLUGIN_MANIFEST.id}/${definition.id}`, pluginId: PLUGIN_MANIFEST.id,
    pluginVersion: PLUGIN_MANIFEST.version, definition };
  const recipeRef = BACKUP_RECEIVER_RECIPE_REF_V1;
  const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {
    machineRecipes: { family: 'machineRecipes', entriesById: { [`${recipeRef.pluginId}/${recipeRef.recipeId}`]: {
      id: `${recipeRef.pluginId}/${recipeRef.recipeId}`, pluginId: recipeRef.pluginId, pluginVersion: '1.0.0',
      definition: { id: recipeRef.recipeId, ...BACKUP_RECEIVER_RECIPE },
    } } },
  } });
  transport.read.mockImplementation((request: { method: string }) => {
    if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
      return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection });
    throw new Error(`Reviewing receiver inputs must not execute an effect: ${request.method}`);
  });
  const receiverInputs = { username: 'archive', chrootPath: '/srv/archive', repositoryPath: '/srv/archive/repository',
    endpoint: { host: '100.100.1.2', port: 2222 }, connection: { host: 'sender', address: '100.100.1.1' },
    administrator: { username: 'root', host: 'administrator', address: '100.100.1.3' }, sshServiceUnit: 'ssh.service' };
  const senderIdentity = { publicKey: 'ssh-ed25519 cHVibGlj', sshPrivateKey: { kind: 'secret' as const,
    ref: 'happier:shared-secret:v1:sender-key', resourceRevision: 1 }, repositoryPassword: { kind: 'secret' as const,
    ref: 'happier:shared-secret:v1:repository-password', resourceRevision: 2 } };
  const configure = vi.fn<React.ComponentProps<typeof DeploymentBackupSetupSheet>['configure']>(async input => input.intent === 'test'
    ? { kind: 'tested', test: { kind: 'reachable', repositoryId: 'a'.repeat(64) },
      destinationSetup: { ...input.destinationSetup!, senderIdentity }, setupOperation: { operationId: 'receiver-setup' } }
    : { kind: 'configured', environmentId: detail.environment.id, revision: 2,
      configuration: DeploymentBackupConfigurationV1Schema.parse(input.configuration) });
  const screen = await renderScreen(<DeploymentBackupSetupSheet detail={detail} destination={destination}
    lifetime={account.accountLifetime} machine="Controller" testID="receiver-setup"
    sourceChoices={[{ kind: 'volume', sourceId: 'content', service: 'web', volume: 'content', consistency: 'stopDuringCopy' }]}
    review={{ pendingId: null, request() {}, open() {} }} configure={configure} onChanged={() => {}} onClose={() => {}} />);
  try {
    const select = screen.findAllByType(ValueFieldSelect).find(entry => entry.props.testID === 'receiver-setup.destination');
    expect(select).toBeDefined();
    expect(select!.props.items.some((entry: { id: string }) => entry.id === 'anotherMachine')).toBe(true);
    await act(async () => select!.props.onSelect('anotherMachine'));
    await act(async () => screen.findAllByType(EnvironmentMachineChoice)[0]!.props.onChoose(receiver.id));
    await vi.waitFor(() => expect(screen.findAllByType(MachineSetupRecipeInputs)).toHaveLength(1));
    const recipe = screen.findAllByType(MachineSetupRecipeInputs)[0]!;
    expect(recipe.props.suppliedInputKeys).toEqual(['senderPublicKey']);
    await act(async () => recipe.props.onChange({ items: [{ kind: 'setupRecipe', selection: { ref: recipeRef, inputs: receiverInputs } }] }));
    await screen.pressByTestIdAsync('receiver-setup.test');
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ intent: 'test', destinationSetup: {
      kind: 'anotherMachine', machineId: receiver.id, expectedInstallationId: receiver.installationId, receiverInputs },
      configuration: expect.objectContaining({ destinationRef: SFTP_BACKUP_DESTINATION_REF_V1 }) }));
    await screen.pressByTestIdAsync('receiver-setup.save');
    expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ intent: 'save',
      destinationSetup: expect.objectContaining({ senderIdentity }) }));
  } finally { await screen.unmount(); account.dispose(); }
});

it('opens the existing backup setup sheet for the exact readiness Environment without a write or Session', async () => {
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Backup setup', serverUrl: 'https://backup-setup.test',
    serverIdentityId: `srv_${'7'.repeat(32)}`, accountId: 'alice', currentAccount: true });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const account = await captureLazyActionAccountContext(serverId);
  const initial = createDeploymentEnvironmentDetailV1();
  const detail = { ...initial, runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1(initial), memberVersions: {}, secretRevisions: [],
    content: { ...initial.content, template: { templateRef: { sourceId: 'catalog', itemId: 'postgres', version: '1',
      ref: { kind: 'version' as const, version: '1' } }, definition: { kind: 'stored' as const, contentRevision: 1,
      composeDigest: `sha256:${'a'.repeat(64)}` }, services: ['db'], data: [{ engine: 'postgres' as const, service: 'db' }] } } };
  const machineId = detail.environment.controllerMachineId;
  await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({ id: machineId, activeAt: Date.now() })]);
  const destination = PLUGIN_MANIFEST.contributes.backupDestinations?.find(entry => entry.id === 's3');
  if (!destination) throw new Error('Expected canonical S3 destination');
  const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
    familiesById: { backupDestinations: { family: 'backupDestinations', entriesById: {
      [`${PLUGIN_MANIFEST.id}/${destination.id}`]: { id: `${PLUGIN_MANIFEST.id}/${destination.id}`,
        pluginId: PLUGIN_MANIFEST.id, pluginVersion: PLUGIN_MANIFEST.version, definition: destination },
    } } } });
  transport.read.mockImplementation((request: { method: string }) => {
    if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
      return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection });
    throw new Error(`Opening backup setup must not execute an effect: ${request.method}`);
  });
  const { createDeploymentActions } = await import('./deploymentActions');
  const actions = createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId);
  const sourceChoices = [{ kind: 'dump' as const, sourceId: 'db', service: 'db', consistency: 'logical' as const }];
  homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, {
    body: { ok: true, environment: detail.environment, targetLinks: [] },
  });
  await answerExternalActionAccountForHome(homes, serverId, { machineId,
    actionId: 'deployments.environments.update', tokenEpoch: 0, execute: raw => {
      expect(raw).toMatchObject({ mode: 'preview', defaultsFor: 'backups' });
      expect(raw).not.toHaveProperty('patch');
      return { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision,
        creationDefaults: { values: { retainPreviousDeployments: 1 }, sources: {} }, backupSourceChoices: sourceChoices };
    } });
  const screen = await renderScreen(<DeploymentBackupSetup detail={detail} serverId={serverId} testID="backups"
    review={{ pendingId: null, request() {}, open() {} }} machineName={id => id} onChanged={() => {}}
    actions={actions} lifetime={account.accountLifetime} />);
  try {
    await vi.waitFor(() => expect(modal.show).toHaveBeenCalledWith(expect.objectContaining({
      component: DeploymentBackupSetupSheet, props: expect.objectContaining({ detail,
        sourceChoices }),
    })));
    await act(async () => screen.update(<DeploymentBackupSetup detail={detail} serverId={serverId} testID="backups"
      review={{ pendingId: null, request() {}, open() {} }} machineName={id => id} onChanged={() => {}}
      actions={actions} lifetime={account.accountLifetime} />));
    expect(modal.show).toHaveBeenCalledTimes(1);
    expect(homes.requests.filter(request => request.path.includes('/sessions'))).toEqual([]);
  } finally { await screen.unmount(); account.dispose(); }
});

it('keeps the descriptor name and same-disk warning visible for a configured local destination', async () => {
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Local backup', serverUrl: 'https://local-backup.test',
    serverIdentityId: `srv_${'8'.repeat(32)}`, accountId: 'alice', currentAccount: true });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const account = await captureLazyActionAccountContext(serverId);
  const initial = createDeploymentEnvironmentDetailV1();
  const detail = { ...initial, environment: { ...initial.environment, serverId }, runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
  const machineId = detail.environment.controllerMachineId;
  await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({ id: machineId, activeAt: Date.now() })]);
  const destination = PLUGIN_MANIFEST.contributes.backupDestinations?.find(entry => entry.id === 'local');
  if (!destination) throw new Error('Expected canonical local destination');
  const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
    familiesById: { backupDestinations: { family: 'backupDestinations', entriesById: {
      [`${PLUGIN_MANIFEST.id}/${destination.id}`]: { id: `${PLUGIN_MANIFEST.id}/${destination.id}`,
        pluginId: PLUGIN_MANIFEST.id, pluginVersion: PLUGIN_MANIFEST.version, definition: destination },
    } } } });
  transport.read.mockImplementation((request: { method: string }) => {
    if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
      return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection });
    throw new Error(`Destination summary must not run an effect: ${request.method}`);
  });
  const configuration = DeploymentBackupConfigurationV1Schema.parse({ configRevision: 1,
    destinationRef: { pluginId: PLUGIN_MANIFEST.id, localId: destination.id }, occurrenceId: destination.id,
    config: { path: '/backups' }, credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
    sources: [{ kind: 'volume', sourceId: 'content', service: 'web', volume: 'content', consistency: 'stopDuringCopy' }],
    ownership: { environmentId: detail.environment.id, prefix: '' }, retention: { kind: 'keepEverything' } });
  const screen = await renderScreen(<DeploymentBackupDestinationRow detail={detail} configuration={configuration} actions={null} testID="backups" />);
  try {
    await vi.waitFor(() => expect(screen.findAllByType(Item).find(row => row.props.testID === 'backups.destination')?.props.title).toBe(destination.title));
    expect(screen.findAllByType(Item).some(row => row.props.testID === 'backups.destination.localWarning')).toBe(true);
    expect(homes.requests.filter(request => request.path.includes('/actions/'))).toEqual([]);
  } finally { await screen.unmount(); account.dispose(); }
});
