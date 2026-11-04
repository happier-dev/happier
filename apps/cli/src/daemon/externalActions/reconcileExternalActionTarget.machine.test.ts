import axios from 'axios';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { reconcileExternalActionTarget, resolveExternalActionMachineTarget, resolveManagedControlControllerTarget } from './reconcileExternalActionTarget';

it.each([
  ['machines.managed.power.set', { when: 'now', intent: 'stop', expectedRevision: 1 }, true],
  ['machines.managed.power.set', { when: 'after-idle', intent: 'stop' }, false],
  ['machines.managed.delete', { when: 'now', intent: 'delete', expectedRevision: 1, reviewedDependencies: true }, true],
  ['machines.managed.delete', { when: 'after-idle', intent: 'delete', reviewedDependencies: true }, false],
  ['machines.managed.inspect', {}, true],
  ['machines.managed.bootstrap.retry', { expectedIntentRevision: 1 }, true],
  ['machines.managed.controller.update', { expectedRevision: 1, controller: null }, false],
] as const)('selects the CLI executor for %s %j from the retained control classification', async (actionId, args, retained) => {
  const row = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'example.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
    controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
    resource: { contributionRef: { pluginId: 'example.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
    desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
  const read = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: row });
  try {
    expect(await resolveManagedControlControllerTarget({ actionId, rawInput: { homeId: 'home', managedId: 'managed', ...args },
      credentials: { token: 'owner', encryption: null }, serverHttpBaseUrl: 'https://home.test' }))
      .toEqual(retained ? { kind: 'machine', machineId: 'controller' } : null);
    expect(read.mock.calls.length).toBe(retained ? 1 : 0);
  } finally { read.mockRestore(); }
});

it.each([
  { actionId: 'workspace.sync.relationships.list' as const, rawInput: { workspaceRefId: 'source-ref' } },
  { actionId: 'workspace.sync.conflicts.list' as const, rawInput: { controllerMachineId: 'controller', relationshipId: 'relationship', limit: 50 } },
  { actionId: 'workspace.sync.conflict.inspect' as const, rawInput: { controllerMachineId: 'controller', workspaceRefId: 'source-ref', path: 'file.txt' } },
])('admits $actionId without manufacturing a Session execution target', ({ actionId, rawInput }) => {
  expect(getActionSpec(actionId).inputSchema.safeParse(rawInput).success).toBe(true);
  expect(reconcileExternalActionTarget({ actionId,
    rawInput, currentMachineId: '', target: undefined }))
    .toMatchObject({ kind: 'ready' });
});

it('refuses an execution Run retargeting its authenticated receiver with noRunCreated evidence', () => {
  const start = { actionId: 'execution.run.start' as const, rawInput: {
    sessionId: null, machineId: 'worker', cwd: '/worker', intent: 'delegate',
    backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, instructions: 'Inspect this checkout.',
    permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' } };
  expect(getActionSpec(start.actionId).inputSchema.safeParse(start.rawInput).success).toBe(true);
  expect(resolveExternalActionMachineTarget({ ...start, ownerMachineId: 'worker' }))
    .toEqual({ kind: 'ready', machineId: 'worker' });
  expect(resolveExternalActionMachineTarget({ ...start, ownerMachineId: 'source' }))
    .toMatchObject({ kind: 'rejected', execution: { ok: false, errorCode: 'target_not_local',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } } });
});

it('selects a nested worker destination instead of SOURCE and refuses conflicting receiver custody', () => {
  const status = { actionId: 'projects.worker.status' as const,
    rawInput: { workspace: { serverId: 'home', refId: 'source-ref' },
      destination: { kind: 'machine', machineId: 'worker' }, purpose: 'finite' }, fallbackMachineId: 'source' };
  expect(resolveExternalActionMachineTarget(status)).toEqual({ kind: 'ready', machineId: 'worker' });
  expect(resolveExternalActionMachineTarget({ ...status, target: { kind: 'machine', machineId: 'source' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
  expect(reconcileExternalActionTarget({ ...status, target: { kind: 'machine', machineId: 'source' }, currentMachineId: 'source' }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
  expect(reconcileExternalActionTarget({ ...status, target: { kind: 'machine', machineId: 'worker' }, currentMachineId: 'worker' }))
    .toMatchObject({ kind: 'ready', target: { kind: 'machine', machineId: 'worker' } });
});

it.each(['projects.inspect', 'projects.manifest.update'] as const)('routes qualified %s to its checkout Machine instead of the ambient daemon', actionId => {
  const inspect = { actionId,
    rawInput: { workspace: { serverId: 'home', workspaceId: 'worker-ref', machineId: 'worker', rootPath: '/worker' },
      ...(actionId === 'projects.manifest.update' ? { expectedBasis: { kind: 'absent' }, bytes: '{}' } : {}) },
    fallbackMachineId: 'source' };
  expect(resolveExternalActionMachineTarget(inspect)).toEqual({ kind: 'ready', machineId: 'worker' });
  expect(reconcileExternalActionTarget({ ...inspect, target: { kind: 'machine', machineId: 'source' }, currentMachineId: 'source' }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
});

const controller = { machineId: 'controller', installationId: 'installation' };
const contribution = { pluginId: 'acme.compute', localId: 'machine' };
it.each([
  ['machines.provisioners.check', { homeId: 'home', controller, contribution }],
  ['machines.provisioners.options', { homeId: 'home', controller, contribution, selectors: {} }],
  ['machines.managed.acquire', { selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 },
    controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }],
  ['machines.managed.acquire', { selection: { kind: 'one-off', homeId: 'home', controller,
    launch: { provider: contribution, schemaVersion: 1, name: 'worker', choices: {} },
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } }],
] as const)('routes %s through its declared controller and refuses another envelope Machine', (actionId, rawInput) => {
  const request = { actionId, rawInput, fallbackMachineId: 'ambient' };
  expect(resolveExternalActionMachineTarget(request)).toEqual({ kind: 'ready', machineId: 'controller' });
  expect(resolveExternalActionMachineTarget({ ...request, target: { kind: 'machine', machineId: 'ambient' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
  expect(reconcileExternalActionTarget({ ...request, target: { kind: 'machine', machineId: 'ambient' }, currentMachineId: 'ambient' }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
});

it.each([
  ['artifact.publish_from_file', { path: 'report.txt', workspace: { machineId: 'worker', rootPath: '/worker' } }],
  ['projects.prepare', { phase: 'setup', workspace: {
    serverId: 'home', workspaceId: 'worker-ref', machineId: 'worker', rootPath: '/worker' } }],
  ['daemon.filesystem.copy', { kind: 'target_copy',
    source: { serverId: 'home', machineId: 'source', rootPath: '/source', path: 'file' },
    destination: { serverId: 'home', machineId: 'worker', rootPath: '/worker', path: 'file' },
    overwrite: false, recursive: false }],
  ['plugins.settings.get', { pluginId: 'acme.plugin', localId: 'enabled', scope: { kind: 'daemon' },
    target: { kind: 'daemon', serverIdentityId: 'srv_home', machineId: 'worker' } }],
  ['plugins.settings.secret.status', { pluginId: 'acme.plugin', localId: 'credential',
    secretDaemonTarget: { kind: 'daemon', serverIdentityId: 'srv_home', machineId: 'worker' } }],
  ['peerMediation.observability.subscribe', { scope: { kind: 'machine', accountId: 'account', machineId: 'worker' } }],
  ['peerMediation.observability.unsubscribe', { scope: { kind: 'machine', accountId: 'account', machineId: 'worker' } }],
] as const)('routes %s using its semantic nested Machine and refuses conflicting custody', (actionId, rawInput) => {
  expect(getActionSpec(actionId).inputSchema.safeParse(rawInput).success).toBe(true);
  const request = { actionId, rawInput, fallbackMachineId: 'source' };
  expect(resolveExternalActionMachineTarget(request)).toEqual({ kind: 'ready', machineId: 'worker' });
  expect(reconcileExternalActionTarget({ ...request, target: { kind: 'machine', machineId: 'source' }, currentMachineId: 'source' }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
});

it('ignores incidental nested Machine data retained by a permissive Action schema', () => {
  expect(resolveExternalActionMachineTarget({ actionId: 'localServices.inventory.list',
    rawInput: { machineId: 'source', destination: { machineId: 'worker' } }, fallbackMachineId: 'source' }))
    .toEqual({ kind: 'ready', machineId: 'source' });
});

it('selects an inherited spawn Machine before creation choices are resolved while retaining explicit locality', () => {
  const spawn = { actionId: 'session.spawn_new' as const,
    rawInput: { directory: { kind: 'path', path: '/tmp' } }, fallbackMachineId: 'caller-machine' };
  expect(resolveExternalActionMachineTarget(spawn)).toEqual({ kind: 'ready', machineId: 'caller-machine' });
  const selected = { ...spawn, rawInput: { ...spawn.rawInput,
    executionTarget: { serverId: 'home', machineId: 'selected-machine' } } };
  expect(resolveExternalActionMachineTarget(selected)).toEqual({ kind: 'ready', machineId: 'selected-machine' });
  expect(resolveExternalActionMachineTarget({ ...selected, target: { kind: 'machine', machineId: 'other' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local',
      details: { phase: 'target_machine_selection' } } });
  expect(reconcileExternalActionTarget({ ...selected, target: { kind: 'machine', machineId: 'other' },
    currentMachineId: 'other' })).toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local',
      details: { phase: 'target_machine_locality' } } });
  expect(resolveExternalActionMachineTarget({ ...spawn, rawInput: { ...spawn.rawInput, agentTarget: null } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'invalid_parameters' } });
});

it('identifies a conflicting Session selector without disclosing either target', () => {
  expect(reconcileExternalActionTarget({ actionId: 'session.open', rawInput: { sessionId: 'selected-session' },
    target: { kind: 'session', sessionId: 'envelope-session' }, currentMachineId: 'machine' }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local',
      details: { phase: 'target_session_selection' } } });
});

it('binds plugin installation to its semantic Machine at caller selection and actual daemon ingress', () => {
  const install = { actionId: 'plugins.install' as const,
    rawInput: { machineId: 'selected-machine', source: { kind: 'marketplace' as const,
      sourceId: 'marketplace:community-npm', pluginId: 'acme.plugin', packageName: '@acme/plugin', version: '1.0.0' } } };
  expect(resolveExternalActionMachineTarget({ ...install, fallbackMachineId: 'ambient-machine' }))
    .toEqual({ kind: 'ready', machineId: 'selected-machine' });
  expect(reconcileExternalActionTarget({ ...install, currentMachineId: 'selected-machine',
    target: { kind: 'machine', machineId: 'selected-machine' } }))
    .toMatchObject({ kind: 'ready', target: { kind: 'machine', machineId: 'selected-machine' } });
  expect(reconcileExternalActionTarget({ ...install, currentMachineId: 'other-machine',
    target: { kind: 'machine', machineId: 'other-machine' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
});

const input = {
  actionId: 'sessions.external.candidates.list' as const,
  rawInput: { machineId: 'addressed-machine', agentId: 'claude', source: { kind: 'claudeConfig', configDir: '/repo' } },
  fallbackMachineId: 'unrelated-local-machine',
};

it('selects the parsed Machine rather than the ambient local Machine and refuses a conflicting envelope', () => {
  expect(resolveExternalActionMachineTarget(input)).toEqual({ kind: 'ready', machineId: 'addressed-machine' });
  expect(resolveExternalActionMachineTarget({ ...input, target: { kind: 'machine', machineId: 'other' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
  expect(resolveExternalActionMachineTarget({ ...input, ownerMachineId: 'other' }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
});

it('uses authenticated linked Session ownership for operation placement and refuses a different explicit Machine', () => {
  const operation = { actionId: 'sessions.external.operation.status.get' as const,
    rawInput: { sessionId: 'session-1', operationId: 'operation-1', revision: 1 },
    ownerMachineId: 'owning-machine', fallbackMachineId: 'unrelated-local-machine' };
  expect(resolveExternalActionMachineTarget(operation)).toEqual({ kind: 'ready', machineId: 'owning-machine' });
  expect(resolveExternalActionMachineTarget({ ...operation, target: { kind: 'machine', machineId: 'other' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
});

const serviceControl = {
  actionId: 'localServices.actions.stopManaged' as const,
  rawInput: { requestId: 'exact-service-stop', action: 'stop_managed' as const, confirmationNonce: 'reviewed-stop', force: false,
    target: { kind: 'managed_service' as const, machineId: 'addressed-machine', managedServiceId: 'actual-instance' } },
  fallbackMachineId: 'unrelated-local-machine',
};

it('selects the strict service control occurrence Machine and preserves captured-target refusal', () => {
  expect(resolveExternalActionMachineTarget(serviceControl)).toEqual({ kind: 'ready', machineId: 'addressed-machine' });
  expect(resolveExternalActionMachineTarget({ ...serviceControl, target: { kind: 'machine', machineId: 'other' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
  expect(resolveExternalActionMachineTarget({ ...serviceControl, rawInput: { ...serviceControl.rawInput, action: 'restart_managed' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'invalid_parameters' } });
});

it('refuses a service control selecting another Machine at actual daemon ingress', () => {
  expect(reconcileExternalActionTarget({ ...serviceControl, target: { kind: 'machine', machineId: 'other' }, currentMachineId: 'other' }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
  expect(reconcileExternalActionTarget({ ...serviceControl, target: { kind: 'machine', machineId: 'addressed-machine' },
    currentMachineId: 'addressed-machine' }))
    .toMatchObject({ kind: 'ready', target: { kind: 'machine', machineId: 'addressed-machine' } });
});
