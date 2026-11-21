import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { readDeploymentActionOperationRequestIdV1, type DeploymentTargetLinkActionInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { createHostActionOperationRuntime } from './createHostActionOperationRuntime';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';
import { prepareProjectOpenReceiptPersistence } from './projectOpenReceiptPersistence';

const scope = { accountId: 'requester', machineId: 'controller' } as const;
const actionId = 'deployments.targets.link';
const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  targetId: 'runtime', role: 'runtime', machines: [{ machineId: 'runtime-machine', installationId: 'runtime-installation' }],
  requestKey: 'link-request' };

const credential = { service: { pluginId: 'example.platform', localId: 'account' }, accountId: 'connection' };
const recovery = { serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  requestKey: 'link-request', targetId: 'runtime', role: 'runtime', targetKind: 'platform', machines: [], provisioned: true,
  source: { kind: 'plugin', contribution: { pluginId: 'example.platform', localId: 'runtime' } },
  provider: { credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: {
    pluginId: 'example.platform', localId: 'create' }, purpose: 'deploy.manage' },
    target: { kind: 'account', account: credential } },
    providerIdentity: { providerAccountId: 'native-account', providerResourceId: 'returned-id', providerEnvironment: 'production' },
    providerEnvironment: { kind: 'native', selection: { kind: 'production' } }, preparedNative: { projectName: 'reviewed-name' } } };
const provisionedResult = { ok: false, error: 'deployment_link_incomplete', recovery };

function runnerFor(store: ReturnType<typeof createActionOperationStore>) {
  const spec = getActionSpec(actionId);
  return createActionOperationRunner({ store, generateOperationId: () => 'link-operation',
    resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation,
      operationReentry: spec.operationReentry }) });
}

describe('deployment target link operation retention', () => {
  it.each(['age', 'overflow'] as const)('retains native creation evidence past activity %s while association remains prunable', boundary => {
    let clock = 1_000;
    const store = createActionOperationStore({ now: () => clock });
    for (const operationId of ['native-create', 'ordinary-association']) {
      store.create({ operationId, actionId, requestId: operationId, scope, title: 'Link',
        cancellation: 'unsupported', inputIdentity: '{}', domainRef: {
          kind: 'deploymentTargetLink', serverId: 'home', environmentId: 'environment',
          requestKey: operationId, purpose: operationId === 'native-create' ? 'create' : 'associate' } });
      store.fail(operationId, { errorCode: 'action_outcome_unknown', error: 'Coordinator lost', effectAttempted: true });
    }
    for (const operationId of ['native-associated', 'native-incomplete', 'native-no-flag', 'provider-unknown', 'known-refusal']) {
      store.create({ operationId, actionId, requestId: operationId, scope, title: 'Link',
        cancellation: 'unsupported', inputIdentity: '{}', domainRef: {
          kind: 'deploymentTargetLink', serverId: 'home', environmentId: 'environment',
          requestKey: operationId === 'native-incomplete' ? provisionedResult.recovery.requestKey : operationId, purpose: 'create' } });
      if (operationId === 'native-associated') store.succeed(operationId, {
        ok: true, environmentId: 'environment', revision: 2, targetLinkId: 'runtime', targetLinkRevision: 1 });
      else if (operationId === 'native-incomplete') store.succeed(operationId, provisionedResult);
      else store.fail(operationId, operationId === 'known-refusal'
        ? { errorCode: 'action_not_admitted', error: 'Native request refused', effectAttempted: true }
        : { errorCode: operationId === 'provider-unknown' ? 'outcome_unknown' : 'action_outcome_unknown',
          error: 'Native acknowledgement unavailable' });
    }
    clock += boundary === 'age' ? 24 * 60 * 60 * 1_000 + 1 : 1;
    for (let index = 0; index < 51; index++) {
      const operationId = 'history-' + index;
      store.create({ operationId, actionId: 'projects.script.run', scope, title: 'Script',
        cancellation: 'unsupported', inputIdentity: '{}' });
      store.succeed(operationId, {});
    }
    expect(store.get(scope, 'native-create')).toMatchObject({ state: 'failed',
      error: { errorCode: 'action_outcome_unknown', effectAttempted: true } });
    expect(store.get(scope, 'ordinary-association')).toBeNull();
    expect(store.get(scope, 'native-associated')).toBeNull();
    expect(store.get(scope, 'known-refusal')).toBeNull();
    expect(store.get(scope, 'native-incomplete')).toMatchObject({ result: provisionedResult });
    expect(store.get(scope, 'native-no-flag')).toMatchObject({ state: 'failed', error: { errorCode: 'action_outcome_unknown' } });
    expect(store.get(scope, 'provider-unknown')).toMatchObject({ state: 'failed', error: { errorCode: 'outcome_unknown' } });
  });

  it('persists admission before effect and replays the retained terminal result after restart', async () => {
    const credential = { service: { pluginId: 'example.platform', localId: 'account' }, accountId: 'connection' };
    const input: DeploymentTargetLinkActionInputV1 = { serverId: 'home', environmentId: 'environment', expectedRevision: 1, requestKey: 'link-request',
      targetId: 'runtime', role: 'runtime', targetKind: 'platform', machines: [],
      source: { kind: 'plugin', contribution: { pluginId: 'example.platform', localId: 'runtime' } },
      providerCreate: { credentialRef: credential,
        credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: {
          pluginId: 'example.platform', localId: 'create' }, purpose: 'deploy.manage' },
          target: { kind: 'account', account: credential } },
        providerAccountId: 'native-account', providerEnvironment: { kind: 'native', selection: { kind: 'production' } }, resourceName: 'reviewed-name',
        sourceMethod: 'upload' } };
    const directory = await mkdtemp(join(tmpdir(), 'link-operation-'));
    try {
      const open = () => prepareProjectOpenReceiptPersistence({ directory: join(directory, 'receipts'),
        keyPath: join(directory, 'key.json'), accountId: 'custodian', machineId: scope.machineId });
      const runtime = createHostActionOperationRuntime({ machineId: scope.machineId, serverId: 'home',
        resolveAccountId: async () => scope.accountId, generateOperationId: () => 'link-operation',
        projectOpenReceiptPersistence: await open() });
      let effects = 0;
      const result = { ok: true, environmentId: 'environment', revision: 2, targetLinkId: 'runtime', targetLinkRevision: 1 };
      const request = { actionId, requestId: readDeploymentActionOperationRequestIdV1(actionId, input), scope, input,
        execute: async () => {
          const retained = (await open()).retained;
          expect(retained).toHaveLength(1);
          expect(retained[0]).toMatchObject({ snapshot: { operationId: 'link-operation', requestId: readDeploymentActionOperationRequestIdV1(actionId, input),
              domainRef: { kind: 'deploymentTargetLink', serverId: 'home', environmentId: 'environment', requestKey: 'link-request', purpose: 'create' } },
            inputIdentity: createCanonicalJsonSigningInput(input) });
          effects++;
          return { ok: true as const, result };
        } };
      const hostRequest = { actionId, input, execute: request.execute, context: {
        actionCaller: { kind: 'host' as const }, serverId: 'home', runtimeAccountId: scope.accountId,
        actionRequestId: 'first-transport-envelope' } };
      expect(await runtime.runActionOperation(hostRequest)).toEqual({ ok: true, result });
      expect(await runtime.runActionOperation({ ...hostRequest, context: { ...hostRequest.context,
        actionRequestId: 'second-transport-envelope' } })).toEqual({ ok: true, result });
      const restarted = createActionOperationStore({ projectOpenReceiptPersistence: await open() });
      expect(await runnerFor(restarted).observe(request)).toEqual({ ok: true, result });
      expect(effects).toBe(1);
      expect(getActionSpec(actionId).executionPlacement).toBe('machine');
      expect(restarted.get({ ...scope, accountId: 'custodian' }, 'link-operation')).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('never replays creation when a started link loses its coordinator', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'link-operation-unknown-'));
    try {
      const open = () => prepareProjectOpenReceiptPersistence({ directory: join(directory, 'receipts'),
        keyPath: join(directory, 'key.json'), accountId: 'custodian', machineId: scope.machineId });
      const store = createActionOperationStore({ projectOpenReceiptPersistence: await open() });
      store.create({ operationId: 'lost-link', actionId, requestId: input.requestKey, scope,
        title: 'Link', cancellation: 'unsupported', inputIdentity: createCanonicalJsonSigningInput(input) });
      store.markRunning('lost-link');
      const restarted = createActionOperationStore({ projectOpenReceiptPersistence: await open() });
      let effects = 0;
      expect(await runnerFor(restarted).observe({ actionId, requestId: input.requestKey, scope, input,
        execute: async () => { effects++; return { ok: true, result: {} }; } }))
        .toMatchObject({ ok: false, errorCode: 'action_outcome_unknown', effectAttempted: true });
      expect(effects).toBe(0);
      expect(restarted.get(scope, 'lost-link')).toMatchObject({ state: 'failed' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('retains validated provider coordinates before association and preserves them through cold interruption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'link-operation-coordinates-'));
    let release!: () => void;
    const finish = new Promise<void>(resolve => { release = resolve; });
    let checkpoint!: () => void;
    const checkpointed = new Promise<void>(resolve => { checkpoint = resolve; });
    const result = provisionedResult;
    let pending: Promise<unknown> | undefined;
    try {
      const open = () => prepareProjectOpenReceiptPersistence({ directory: join(directory, 'receipts'),
        keyPath: join(directory, 'key.json'), accountId: 'custodian', machineId: scope.machineId });
      const persistence = await open();
      const writes = vi.spyOn(persistence, 'save'); // Observe the real filesystem boundary.
      const store = createActionOperationStore({ projectOpenReceiptPersistence: persistence });
      pending = runnerFor(store).observe({ actionId, requestId: input.requestKey, scope, input,
        execute: async context => {
          context.publishOwnerUpdate({ outcome: { ok: true, result } });
          for (let index = 0; index < 100; index++) {
            context.updateProgress({ phase: 'association', label: String(index) });
          }
          checkpoint();
          await finish;
          return { ok: true, result };
        } });
      await checkpointed;
      expect(writes).toHaveBeenCalledTimes(2); // Admission and provider coordinates; progress is transient.
      expect((await open()).retained[0]?.snapshot).toMatchObject({ state: 'running', result });
      const restarted = createActionOperationStore({ projectOpenReceiptPersistence: await open() });
      expect(restarted.get(scope, 'link-operation')).toMatchObject({ state: 'failed', result,
        error: { errorCode: 'action_outcome_unknown', effectAttempted: true } });
      expect(createActionOperationStore({ projectOpenReceiptPersistence: await open() }).get(scope, 'link-operation'))
        .toEqual(restarted.get(scope, 'link-operation'));
      let effects = 0;
      expect(await runnerFor(restarted).observe({ actionId, requestId: input.requestKey, scope, input,
        execute: async () => { effects++; return { ok: true, result: {} }; } }))
        .toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
      expect(effects).toBe(0);
    } finally { release(); await pending; await rm(directory, { recursive: true, force: true }); }
  });

});
