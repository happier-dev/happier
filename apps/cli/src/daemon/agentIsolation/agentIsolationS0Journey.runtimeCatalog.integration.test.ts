import { describe, expect, it } from 'vitest';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createActionExecutor, MachineAgentIsolationPreviewResultV1Schema, MachineAgentIsolationSetResultV1Schema,
  type ActionExecutorDeps, type MachineAgentIsolationStatusV1 } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from '@happier-dev/protocol/actions/actionSettings';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { RpcHandlerMap, RpcHandlerContext } from '@/api/rpc/types';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { readAgentIsolationSnapshot } from './agentIsolationPolicy';
import { publishMachineMetadataOnce, readOpenedMachineMetadataSnapshot } from '@/api/machine/machineMetadataPublication';
import type { Machine } from '@/api/types';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

/** Real Action/field/elevation journey; native UID/custody proof remains a live gate. */
describe('S0 Agent isolation Action to target daemon', () => {
  it('retains the reviewed isolation operation while an explicit native Ask is decided in place', async () => {
    await withTempDir('happier-isolation-reviewed-resume-', async directory => {
      const originalRoot = join(directory, 'original'), changedRoot = join(directory, 'changed');
      await Promise.all([mkdir(originalRoot), mkdir(changedRoot)]);
      let roots = [{ rootId: 'original', path: originalRoot }];
      const machine: Machine = { id: 'machine', encryptionMode: 'plain', metadataVersion: 1, daemonStateVersion: 1,
        metadata: { host: 'fixture', platform: 'linux', happyCliVersion: '0.3', homeDir: directory, happyHomeDir: directory,
          agentIsolation: { enabled: false } }, daemonState: { status: 'running', runtimeId: 'daemon', agentIsolation: { kind: 'disabled' } } };
      const codec = createMachineContentCodec(machine);
      let publications = 0;
      const native = createAgentIsolationEffectsBoundary({ installationId: 'installation', installedCli: '/opt/happier/cli/current/happier',
        readRoots: () => roots, readSessionsToReplace: () => 0,
        publishStatus: async status => { machine.daemonState = { ...machine.daemonState!, agentIsolation: status }; } });
      const port = {
        read: async () => readOpenedMachineMetadataSnapshot(machine, true),
        compareAndSwap: (input: Parameters<typeof publishMachineMetadataOnce>[1]) => publishMachineMetadataOnce({
          getMachine: () => machine, codec, expectedDataEncryptionKey: null, isContentCurrent: () => true,
          retireAndRefreshContent: async () => {}, notifyMetadataChanged: () => {
            publications++; roots = [{ rootId: 'changed', path: changedRoot }];
          }, socket: { connected: true, emitWithAck: async (_event, payload) => ({
            result: 'success' as const, version: payload.expectedVersion + 1, metadata: payload.metadata,
          }) },
        }, input),
      };
      const handlers: RpcHandlerMap = new Map();
      registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
        target: () => ({ serverId: 'home', machineId: machine.id, installationId: 'installation', custodianAccountId: 'account' }),
        read: () => readAgentIsolationSnapshot({ metadata: readOpenedMachineMetadataSnapshot(machine, true),
          daemonState: machine.daemonState, runtimeId: 'daemon', platform: 'linux' }),
        captureMetadataPort: () => port, effects: native.effects,
      });
      const ingress: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: machine.id,
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
      let operationIndex = 0;
      const operations = createHostActionOperationRuntime({ serverId: 'home', machineId: machine.id,
        resolveAccountId: async () => 'account', generateOperationId: () => `reviewed-isolation-${++operationIndex}` });
      let confirmations = 0;
      const executor = createActionExecutor({
        runActionOperation: request => operations.runActionOperation(request),
        // The mounted UI supplies the person's answer to the executor's review.
        presentUserActionConfirmation: async ({ actionId, input }) => {
          expect(actionId).toBe('machines.agentIsolation.set');
          expect(input).toMatchObject({ machineId: machine.id, enabled: true,
            expectedMetadataVersion: machine.metadataVersion, expectedPolicy: { enabled: true } });
          expect(native.launches).toHaveLength(0);
          expect(operations.store.get({ accountId: 'account', machineId: machine.id }, 'reviewed-isolation-1'))
            .toMatchObject({ state: 'running' });
          confirmations++;
          return true;
        },
        machineAgentIsolationAction: async ({ actionId, input, context: localActionContext }) => {
          const handler = handlers.get(actionId);
          if (!handler) throw new Error('Isolation registration missing');
          return await handler(input, { ...ingress, localActionContext });
        },
      });
      const run = (rawInput: unknown, explicitAsk: boolean) => {
        const actionId = 'machines.agentIsolation.set';
        const input = getActionSpec(actionId).inputSchema.parse(rawInput);
        return operations.runActionOperation({ actionId, input, context: { ...ingress, surface: 'ui', authority: 'present_user',
          actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'account', actionRequestId: 'reviewed-isolation-request',
          externalActionTarget: { kind: 'machine', machineId: machine.id },
          actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, ...(explicitAsk ? { actions: {
            [actionId]: { approvalRequiredSurfaces: ['ui'] },
          } } : {}) }),
          ...(!explicitAsk ? { presentUserConfirmation: { actionId, inputDigest: computeActionInputApprovalDigestV1(actionId, input),
            requestId: 'reviewed-isolation-request', accountId: 'account', serverId: 'home', target: { kind: 'machine', machineId: machine.id } } } : {}),
        }, execute: owned => executor.execute(actionId, input, owned) });
      };
      const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await handlers.get('machines.agentIsolation.preview')!(
        { machineId: machine.id, enabled: true }, ingress));
      if (preview.kind !== 'ready') throw new Error('Initial isolation review unavailable');
      const first = await run({ machineId: machine.id, enabled: true, expectedPolicy: preview.policy,
        expectedMetadataVersion: preview.metadataVersion, expectedPlanDigest: preview.plan.planDigest }, false);
      expect(first).toMatchObject({ ok: true, result: { kind: 'plan_changed', operationId: 'reviewed-isolation-1' } });
      if (!first.ok) throw new Error(first.errorCode);
      const held = MachineAgentIsolationSetResultV1Schema.parse(first.result);
      if (held.kind !== 'plan_changed') throw new Error('Actual post-publication roots must require review');
      expect(native.launches).toHaveLength(0); expect(confirmations).toBe(0);
      expect(operations.store.get({ accountId: 'account', machineId: machine.id }, 'reviewed-isolation-1'))
        .toMatchObject({ state: 'running', observation: { kind: 'review_required' } });
      const resumed = await run({ machineId: machine.id, enabled: true, expectedPolicy: held.current.policy,
        expectedMetadataVersion: held.current.metadataVersion, expectedPlanDigest: held.current.plan.planDigest }, true);
      expect(resumed).toMatchObject({ ok: true, result: { kind: 'accepted', operationId: 'reviewed-isolation-1' } });
      expect(confirmations).toBe(1);
      expect(native.launches).toHaveLength(1); expect(publications).toBe(1);
      expect(operations.store.list({ accountId: 'account', machineId: machine.id }).items)
        .toMatchObject([{ operationId: 'reviewed-isolation-1', state: 'succeeded' }]);
    });
  });

  it.each(['plain', 'e2ee'] as const)('reviews and applies the exact %s field through the real publication and elevated interpreter', async mode => {
    await withTempDir('happier-isolation-journey-', async fixtureRoot => {
      const root = join(fixtureRoot, 'checkout');
      const privateParent = join(fixtureRoot, 'private-parent');
      const secondRoot = join(privateParent, 'second-checkout');
      const unrelatedRoot = join(fixtureRoot, 'unrelated');
      await Promise.all([mkdir(root), mkdir(secondRoot, { recursive: true }), mkdir(unrelatedRoot)]);
      await chmod(privateParent, 0o700);
      const content = mode === 'plain' ? { encryptionMode: 'plain' as const }
        : { encryptionMode: 'e2ee' as const, encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey' as const };
      const codec = createMachineContentCodec(content);
      const machine: Machine = { ...content, id: 'machine', metadataVersion: 1, daemonStateVersion: 1,
        metadata: { host: 'fixture', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/happier',
          happyHomeDir: '/home/happier/.happier', agentIsolation: { enabled: false } },
        daemonState: { status: 'running', runtimeId: 'daemon', agentIsolation: { kind: 'disabled' } } };
      let publications = 0, reads = 0, sessionsToReplace = 0, statusPublications = 0;
      let locked = false;
      let creationDefault = false, creationViaSocket = false, publishExplicitOffOnNextCas = false, committedWrites = 0;
      let changeRootsAfterPublication = false;
      let changeRootsOnRead = false;
      let admissionCurrent = true, revokeAfterPublication = false;
      let daemonIdentityUnavailable = false;
      let protectedRoots: readonly string[] = [];
      let roots: { rootId: string; path: string }[] | null = [{ rootId: 'checkout', path: root }];
      const native = createAgentIsolationEffectsBoundary({ installationId: 'installation', installedCli: '/opt/happier/cli/current/happier',
        readRoots: () => roots, readSessionsToReplace: () => sessionsToReplace,
        publishStatus: async (status: MachineAgentIsolationStatusV1) => { statusPublications++; machine.daemonState = { ...machine.daemonState!, agentIsolation: status }; } });
      const { mutations, launches, boundaryFailures } = native;
      const port = {
        read: async () => { reads++;
          if (changeRootsOnRead) { changeRootsOnRead = false; roots = [{ rootId: 'during-rereview', path: root }]; }
          return readOpenedMachineMetadataSnapshot(machine, !locked); },
        compareAndSwap: (input: Parameters<typeof publishMachineMetadataOnce>[1]) => publishMachineMetadataOnce({ getMachine: () => machine,
          codec, expectedDataEncryptionKey: null, isContentCurrent: () => true, retireAndRefreshContent: async () => {},
          notifyMetadataChanged: () => { publications++; if (changeRootsAfterPublication) roots = [{ rootId: 'after-cas', path: root }];
            if (revokeAfterPublication) admissionCurrent = false; }, socket: { connected: true, emitWithAck: async (_event, payload) => {
            if (publishExplicitOffOnNextCas) {
              publishExplicitOffOnNextCas = false;
              return { result: 'version-mismatch' as const, version: payload.expectedVersion + 1,
                metadata: codec.encodeStored({ ...machine.metadata!, agentIsolation: { enabled: false } }) };
            }
            committedWrites++;
            return { result: 'success' as const, version: payload.expectedVersion + 1, metadata: payload.metadata };
          } } }, input),
      };
      const handlers: RpcHandlerMap = new Map();
      const options = {
        target: () => ({ serverId: 'home', machineId: machine.id, installationId: 'installation', custodianAccountId: 'account' }),
        read: () => readAgentIsolationSnapshot({ metadata: readOpenedMachineMetadataSnapshot(machine, true),
          daemonState: machine.daemonState, runtimeId: 'daemon', platform: 'linux' }),
        captureMetadataPort: () => port,
        effects: { ...native.effects, get protectedRoots() { return protectedRoots; }, elevation: {
          ...native.effects.elevation,
          observe: async () => {
            if (daemonIdentityUnavailable) throw new Error('Native daemon identity unavailable');
            return await native.effects.elevation.observe();
          },
        } },
      };
      const context: RpcHandlerContext = { signal: new AbortController().signal, transportRequestId: 'isolation-operation',
        machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: machine.id,
          installationId: 'installation', role: 'manage', encryptionMode: mode }, verifyMachineAdmissionCurrent: async () => admissionCurrent };
      // Constructed verified-transport boundary; real mint/context carriage is
      // independently exercised in the managed creation transport corridor.
      const creationAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'creation-boundary-proof', binding: {
        serverIdentityId: 'home', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 },
        actionId: 'machines.agentIsolation.set', requestId: 'creation', requestEnvelopeDigest: 'a'.repeat(43), machineId: machine.id,
        custodianAccountId: 'account', installationId: 'installation', target: { kind: 'machine', machineId: machine.id }, accountEncryptionMode: mode,
        managedContinuation: { managedId: 'managed', creationRequestId: 'creation', expectedIntentRevision: 1,
          controller: { machineId: 'controller', installationId: 'controller-installation' }, acquireRequestEnvelopeDigest: 'a'.repeat(43) },
      } });
      let operationIndex = 0;
      const operationPhases: (string | undefined)[] = [];
      const createOperations = () => createHostActionOperationRuntime({ serverId: 'home', machineId: machine.id,
        custodyBinding: { serverId: 'home', installationId: 'installation' }, resolveAccountId: async () => 'account',
        generateOperationId: () => `isolation-${++operationIndex}`,
        publishSnapshot: snapshot => { operationPhases.push(snapshot.progress?.kind === 'phase' ? snapshot.progress.phase : undefined); } });
      let operations = createOperations();
      registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
        ...options, runActionOperation: request => operations.runActionOperation(request),
      });
      const executor = createActionExecutor({ machineAgentIsolationAction: async ({ actionId, input, context: executionContext }) => {
        const handler = handlers.get(actionId); if (!handler) throw new Error('Isolation registration missing');
        if (actionId === 'machines.agentIsolation.preview') return handler(input, context);
        const result = await operations.observeExecution({ actionId, input, rpcContext: context,
          actionRequestId: executionContext.actionRequestId,
          execute: async localActionContext => ({ ok: true, result: await handler(input, { ...context,
            ...(creationDefault && creationViaSocket ? { callerInputAuthorization: creationAuthorization } : {}),
            localActionContext: { ...localActionContext, ...(creationDefault && !creationViaSocket ? {
              externalActionExecutionAuthorization: creationAuthorization,
            } : {}) } }) }) });
        return result.ok ? result.result : result;
      // Only the actual Machine-RPC boundary is supplied; unrelated Action
      // families are intentionally absent, not replaced with domain mocks.
      } } as ActionExecutorDeps);
      // A fresh dedicated server may have no checkout yet. A known empty
      // census still reviews real account/RunAs setup; unknown roots do not.
      roots = [];
      expect(await executor.execute('machines.agentIsolation.preview', { machineId: machine.id, enabled: true }, { surface: 'cli', serverId: 'home' }))
        .toMatchObject({ ok: true, result: { kind: 'ready', plan: { roots: [], ancestorAcls: [], requiresAdmin: true } } });
      expect(mutations).toEqual([]); expect(publications).toBe(0);
      roots = null;
      expect(await executor.execute('machines.agentIsolation.preview', { machineId: machine.id, enabled: true }, { surface: 'cli', serverId: 'home' }))
        .toMatchObject({ ok: true, result: { kind: 'unavailable' } });
      roots = [{ rootId: 'checkout', path: root }];
      protectedRoots = [`${root}/daemon-private`];
      expect(await executor.execute('machines.agentIsolation.preview', { machineId: machine.id, enabled: true }, { surface: 'cli', serverId: 'home' }))
        .toMatchObject({ ok: true, result: { kind: 'unavailable' } });
      expect(mutations).toEqual([]); expect(publications).toBe(0);
      protectedRoots = [];
      const previewAction = await executor.execute('machines.agentIsolation.preview', { machineId: machine.id, enabled: true }, { surface: 'cli', serverId: 'home' });
      expect(previewAction.ok).toBe(true); if (!previewAction.ok) throw new Error(previewAction.errorCode);
      const preview = MachineAgentIsolationPreviewResultV1Schema.parse(previewAction.result);
      expect(preview.kind).toBe('ready'); if (preview.kind !== 'ready') throw new Error('Native effect review unavailable');
      expect(mutations).toEqual([]); expect(publications).toBe(0); expect(launches).toEqual([]);
      const input = { machineId: machine.id, enabled: true, expectedMetadataVersion: preview.metadataVersion,
        expectedPolicy: preview.policy, expectedPlanDigest: preview.plan.planDigest };
      let releaseNative!: () => void;
      let enteredNative!: () => void;
      const nativeEntered = new Promise<void>(resolve => { enteredNative = resolve; });
      const incumbentSetup = machineNativeEffectAdmission.run({
        operation: { operationId: 'incumbent-machine-setup', kind: 'setup' }, keys: [{ kind: 'machineSetup' }],
      }, async () => { enteredNative(); await new Promise<void>(resolve => { releaseNative = resolve; }); });
      await nativeEntered;
      try {
        // The retained direct RPC reaches the same mutation owner even without
        // an Action observer. It cannot race another admitted root setup.
        await expect(handlers.get('machines.agentIsolation.set')!(input, context))
          .rejects.toMatchObject({ rpcErrorCode: 'effect_in_progress' });
        expect(publications).toBe(0); expect(mutations).toEqual([]);
      } finally { releaseNative(); await incumbentSetup; }
      const actionsSettings = setScopedActionApprovalPreference({ actionId: 'machines.agentIsolation.set',
        scope: { kind: 'machine', machineId: machine.id }, surface: 'cli', mode: 'waived',
        settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) });
      const setContext = { surface: 'cli' as const, serverId: 'home', actionsSettings };
      const unqualifiedStatus = { kind: 'unavailable', code: 'provisioning_unavailable', prerequisite: {
        reason: 'native_effect_pending', requiredFact: 'native_readiness', detail: 'native_readiness_unavailable',
      } };
      // All enrolled roots and exact ancestor traversal changes belong to the
      // same review; a newly admitted checkout invalidates the old approval.
      roots = [{ rootId: 'second', path: secondRoot }, { rootId: 'checkout', path: root }];
      const expandedAction = await executor.execute('machines.agentIsolation.set', input, setContext);
      if (!expandedAction.ok) throw new Error(expandedAction.errorCode);
      const expanded = MachineAgentIsolationSetResultV1Schema.parse(expandedAction.result);
      expect(expanded.kind).toBe('plan_changed');
      if (expanded.kind !== 'plan_changed') throw new Error('New checkout must require review');
      expect(expanded.current.plan.roots.map(entry => entry.path)).toEqual([root, secondRoot]);
      expect(expanded.current.plan.ancestorAcls).toContainEqual({ path: privateParent, add: 'x' });
      expect(expanded.current.plan.roots.map(entry => entry.path)).not.toContain(unrelatedRoot);
      expect(publications).toBe(0); expect(mutations).toEqual([]); expect(launches).toEqual([]);
      roots.reverse();
      const reorderedAction = await executor.execute('machines.agentIsolation.preview', { machineId: machine.id, enabled: true }, { surface: 'cli', serverId: 'home' });
      if (!reorderedAction.ok) throw new Error(reorderedAction.errorCode);
      expect(MachineAgentIsolationPreviewResultV1Schema.parse(reorderedAction.result)).toEqual(expanded.current);
      // Only the reviewed ancestor ACL changing must also force rereview.
      await chmod(privateParent, 0o711);
      expect(await executor.execute('machines.agentIsolation.set', { ...input,
        expectedPlanDigest: expanded.current.plan.planDigest }, setContext))
        .toMatchObject({ ok: true, result: { kind: 'plan_changed', current: { plan: { ancestorAcls: expect.not.arrayContaining([{ path: privateParent, add: 'x' }]) } } } });
      expect(publications).toBe(0); expect(mutations).toEqual([]); expect(launches).toEqual([]);
      roots = [{ rootId: 'changed-checkout', path: root }];
      const changed = await executor.execute('machines.agentIsolation.set', input, setContext);
      expect(changed).toMatchObject({ ok: true, result: { kind: 'plan_changed' } });
      expect(publications).toBe(0); expect(launches).toEqual([]);
      roots = [{ rootId: 'checkout', path: root }];
      sessionsToReplace = 1;
      expect(await executor.execute('machines.agentIsolation.set', input, setContext))
        .toMatchObject({ ok: true, result: { kind: 'plan_changed' } });
      expect(publications).toBe(0); expect(launches).toEqual([]);
      sessionsToReplace = 0;
      locked = true;
      expect(await executor.execute('machines.agentIsolation.set', input, setContext))
        .toMatchObject({ ok: true, result: { kind: 'failed', code: 'locked' } });
      expect(publications).toBe(0); expect(launches).toEqual([]);
      locked = false;
      // A different field advances the incumbent version. The isolation review
      // survives it, and the real field helper rebases the write at publication.
      machine.metadata = { ...machine.metadata!, displayName: 'concurrent rename' }; machine.metadataVersion++;
      const setAction = await executor.execute('machines.agentIsolation.set', input, setContext);
      expect(setAction.ok).toBe(true); if (!setAction.ok) throw new Error(setAction.errorCode);
      const accepted = MachineAgentIsolationSetResultV1Schema.parse(setAction.result);
      expect(accepted).toMatchObject({ kind: 'accepted', metadataVersion: 3, status: unqualifiedStatus });
      if (accepted.kind !== 'accepted') throw new Error('The effect must be accepted');
      expect(operations.store.get({ accountId: 'account', machineId: machine.id }, accepted.operationId))
        .toMatchObject({ actionId: 'machines.agentIsolation.set', state: 'succeeded' });
      expect(operationPhases).toContain('unavailable');
      expect(boundaryFailures).toEqual([]); expect(launches).toHaveLength(1);
      expect(mutations).toContain('workspace-checkout'); expect(publications).toBe(1);
      expect(machine.metadata).toMatchObject({ displayName: 'concurrent rename', agentIsolation: { enabled: true } });
      expect(options.read()).toMatchObject({ enabled: true, status: unqualifiedStatus });
      await expect(authorizeResolvedProjectExecLaunchForHost({
        launch: { command: '/agent', args: ['--stdio'], cwd: root, env: {} },
        agentNativeLaunch: true, signal: context.signal, assertCurrent() {},
        agentIsolation: { read: () => ({ ...options.read(), workspaceRoots: (roots ?? []).map(entry => entry.path) }) },
      })).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
      expect(reads).toBeGreaterThan(0);
      // Provisioning is not a native probe or permission to synthesize effective.
      expect(machine.daemonState?.agentIsolation?.kind).not.toBe('effective');
      // A separately completed desired write can satisfy an old field request.
      // Its returned review must bind the policy it actually asks us to approve.
      const alreadyAppliedContext = { ...setContext, actionRequestId: 'policy-already-applied' };
      const alreadyAppliedAction = await executor.execute('machines.agentIsolation.set', input, alreadyAppliedContext);
      if (!alreadyAppliedAction.ok) throw new Error(alreadyAppliedAction.errorCode);
      const alreadyApplied = MachineAgentIsolationSetResultV1Schema.parse(alreadyAppliedAction.result);
      if (alreadyApplied.kind !== 'plan_changed') throw new Error('Old effects require a fresh current review');
      expect(alreadyApplied.current.policy).toEqual({ enabled: true });
      expect(await executor.execute('machines.agentIsolation.set', { machineId: machine.id, enabled: true,
        expectedPolicy: alreadyApplied.current.policy, expectedMetadataVersion: alreadyApplied.current.metadataVersion,
        expectedPlanDigest: alreadyApplied.current.plan.planDigest }, alreadyAppliedContext))
        .toMatchObject({ ok: true, result: { kind: 'accepted', operationId: alreadyApplied.operationId } });
      expect(publications).toBe(1); expect(launches).toHaveLength(1);
      // A no-op review still binds its field: a competing opposite policy must
      // conflict before digest/elevation, rather than overwrite the contender.
      const sameAction = await executor.execute('machines.agentIsolation.preview', { machineId: machine.id, enabled: true }, { surface: 'cli', serverId: 'home' });
      if (!sameAction.ok) throw new Error(sameAction.errorCode);
      const same = MachineAgentIsolationPreviewResultV1Schema.parse(sameAction.result);
      if (same.kind !== 'ready') throw new Error('Current review unavailable');
      machine.metadata = { ...machine.metadata!, agentIsolation: { enabled: false } }; machine.metadataVersion++;
      expect(await executor.execute('machines.agentIsolation.set', { machineId: machine.id, enabled: true,
        expectedPolicy: same.policy, expectedMetadataVersion: same.metadataVersion, expectedPlanDigest: same.plan.planDigest }, setContext))
        .toMatchObject({ ok: true, result: { kind: 'conflict', policy: { enabled: false } } });
      expect(publications).toBe(1); expect(launches).toHaveLength(1);
      const racePreviewAction = await executor.execute('machines.agentIsolation.preview', { machineId: machine.id, enabled: true }, { surface: 'cli', serverId: 'home' });
      if (!racePreviewAction.ok) throw new Error(racePreviewAction.errorCode);
      const racePreview = MachineAgentIsolationPreviewResultV1Schema.parse(racePreviewAction.result);
      if (racePreview.kind !== 'ready') throw new Error('The post-CAS race needs an admitted review');
      changeRootsAfterPublication = true;
      const retainedContext = { ...setContext, actionRequestId: 'review-after-cas' };
      const parkedAction = await executor.execute('machines.agentIsolation.set', { machineId: machine.id, enabled: true,
        expectedPolicy: racePreview.policy, expectedMetadataVersion: racePreview.metadataVersion,
        expectedPlanDigest: racePreview.plan.planDigest }, retainedContext);
      expect(parkedAction).toMatchObject({ ok: true, result: { kind: 'plan_changed', operationId: expect.any(String),
        current: { policy: { enabled: true } } } });
      if (!parkedAction.ok) throw new Error(parkedAction.errorCode);
      const parked = MachineAgentIsolationSetResultV1Schema.parse(parkedAction.result);
      if (parked.kind !== 'plan_changed' || !parked.operationId) throw new Error('Changed post-CAS effects must retain the operation');
      expect(machine.metadata?.agentIsolation).toEqual({ enabled: true });
      expect(publications).toBe(2); expect(launches).toHaveLength(1);
      expect(operations.store.get({ accountId: 'account', machineId: machine.id }, parked.operationId))
        .toMatchObject({ state: 'running', observation: { kind: 'review_required' } });
      changeRootsAfterPublication = false;
      expect(await executor.execute('machines.agentIsolation.set', { machineId: machine.id, enabled: true,
        expectedPolicy: parked.current.policy, expectedMetadataVersion: parked.current.metadataVersion,
        expectedPlanDigest: racePreview.plan.planDigest }, retainedContext))
        .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
      expect(launches).toHaveLength(1);
      changeRootsOnRead = true;
      const changedAgain = await executor.execute('machines.agentIsolation.set', { machineId: machine.id, enabled: true,
        expectedPolicy: parked.current.policy, expectedMetadataVersion: parked.current.metadataVersion,
        expectedPlanDigest: parked.current.plan.planDigest }, retainedContext);
      expect(changedAgain).toMatchObject({ ok: true, result: { kind: 'plan_changed', operationId: parked.operationId } });
      expect(operations.store.get({ accountId: 'account', machineId: machine.id }, parked.operationId))
        .toMatchObject({ state: 'running', observation: { kind: 'review_required',
          current: { plan: { roots: [{ rootId: 'during-rereview', path: root }] } } } });
      expect(publications).toBe(2); expect(launches).toHaveLength(1);
      if (!changedAgain.ok) throw new Error(changedAgain.errorCode);
      const reviewAgain = MachineAgentIsolationSetResultV1Schema.parse(changedAgain.result);
      if (reviewAgain.kind !== 'plan_changed') throw new Error('Changed effects require another review');
      const resumedAction = await executor.execute('machines.agentIsolation.set', { machineId: machine.id, enabled: true,
        expectedPolicy: reviewAgain.current.policy, expectedMetadataVersion: reviewAgain.current.metadataVersion,
        expectedPlanDigest: reviewAgain.current.plan.planDigest }, retainedContext);
      expect(resumedAction).toMatchObject({ ok: true, result: { kind: 'accepted', operationId: parked.operationId } });
      expect(publications).toBe(2); expect(launches).toHaveLength(2);
      roots = [{ rootId: 'lost-confirmation', path: root }];
      const lostPreviewAction = await executor.execute('machines.agentIsolation.preview', { machineId: machine.id, enabled: true }, { surface: 'cli', serverId: 'home' });
      if (!lostPreviewAction.ok) throw new Error(lostPreviewAction.errorCode);
      const lostPreview = MachineAgentIsolationPreviewResultV1Schema.parse(lostPreviewAction.result);
      if (lostPreview.kind !== 'ready') throw new Error('Lost confirmation requires a reviewed native effect');
      native.loseConfirmation();
      const lostInput = { machineId: machine.id, enabled: true, expectedPolicy: lostPreview.policy,
        expectedMetadataVersion: lostPreview.metadataVersion, expectedPlanDigest: lostPreview.plan.planDigest };
      const lostContext = { ...setContext, actionRequestId: 'lost-confirmation' };
      expect(await executor.execute('machines.agentIsolation.set', lostInput, lostContext))
        .toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
      const lostOperation = operations.store.findByRequestIdentity({ accountId: 'account', machineId: machine.id }, 'machines.agentIsolation.set', 'lost-confirmation');
      expect(lostOperation).toMatchObject({ state: 'running', observation: { kind: 'outcome_uncertain' } });
      expect(await executor.execute('machines.agentIsolation.set', lostInput, lostContext))
        .toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
      expect(publications).toBe(2); expect(launches).toHaveLength(3);
      // The native reply was lost. The old receipt remains unknown:
      // the successor CHECKs the real native state, never reconstructs success
      // or relies on process-local de-duplication to prevent another effect.
      const predecessor = operations;
      const mutationsBeforeReconnect = [...mutations];
      operations = createOperations();
      const successorAction = await executor.execute('machines.agentIsolation.preview',
        { machineId: machine.id, enabled: true }, { surface: 'cli', serverId: 'home' });
      if (!successorAction.ok) throw new Error(successorAction.errorCode);
      const successor = MachineAgentIsolationPreviewResultV1Schema.parse(successorAction.result);
      expect(successor).toMatchObject({ kind: 'ready', policy: { enabled: true }, plan: { requiresAdmin: false },
        status: { kind: 'unavailable', code: 'provisioning_unavailable' } });
      if (successor.kind !== 'ready') throw new Error('Successor CHECK must observe the applied native steps');
      // Completing the observed steps leaves the reviewed native target unchanged.
      expect(successor.plan.planDigest).toBe(lostInput.expectedPlanDigest);
      expect(await executor.execute('machines.agentIsolation.set', lostInput, lostContext))
        .toMatchObject({ ok: true, result: { kind: 'accepted', status: unqualifiedStatus } });
      expect(mutations).toEqual(mutationsBeforeReconnect);
      expect(launches).toHaveLength(3); expect(publications).toBe(2);
      expect(predecessor.store.findByRequestIdentity({ accountId: 'account', machineId: machine.id },
        'machines.agentIsolation.set', 'lost-confirmation')).toBe(lostOperation);
      // Recovery remains available without a Workspace census or native identity.
      // The uninspected RunAs rule must stay in place.
      roots = null;
      daemonIdentityUnavailable = true;
      const offAction = await executor.execute('machines.agentIsolation.preview', { machineId: machine.id, enabled: false }, { surface: 'cli', serverId: 'home' });
      expect(offAction).toMatchObject({ ok: true, result: { kind: 'ready', plan: { roots: [], requiresAdmin: false,
        retirement: expect.arrayContaining([expect.objectContaining({ stepId: 'agent-runas', action: 'retain', reasonCode: 'native_check_unavailable' })]),
      } } });
      if (!offAction.ok) throw new Error(offAction.errorCode);
      const off = MachineAgentIsolationPreviewResultV1Schema.parse(offAction.result);
      if (off.kind !== 'ready') throw new Error('Explicit policy-off recovery must not need workspace provisioning');
      expect(await executor.execute('machines.agentIsolation.set', { machineId: machine.id, enabled: false,
        expectedPolicy: off.policy, expectedMetadataVersion: off.metadataVersion, expectedPlanDigest: off.plan.planDigest },
      { ...setContext, actionRequestId: 'explicit-disable' }))
        .toMatchObject({ ok: true, result: { kind: 'accepted', status: { kind: 'disabled' } } });
      expect(machine.metadata?.agentIsolation).toEqual({ enabled: false });
      expect(publications).toBe(3); expect(launches).toHaveLength(3);
      expect(mutations).toEqual(mutationsBeforeReconnect);
      // A settled explicit disable is already converged. Repeating it must not
      // manufacture an applying transition or wake Machine consumers.
      const settledPublications = statusPublications;
      const settledOffAction = await executor.execute('machines.agentIsolation.preview', { machineId: machine.id, enabled: false }, { surface: 'cli', serverId: 'home' });
      if (!settledOffAction.ok) throw new Error(settledOffAction.errorCode);
      const settledOff = MachineAgentIsolationPreviewResultV1Schema.parse(settledOffAction.result);
      if (settledOff.kind !== 'ready') throw new Error('Settled disable review unavailable');
      expect(await executor.execute('machines.agentIsolation.set', { machineId: machine.id, enabled: false,
        expectedPolicy: settledOff.policy, expectedMetadataVersion: settledOff.metadataVersion,
        expectedPlanDigest: settledOff.plan.planDigest }, { ...setContext, actionRequestId: 'already-disabled' }))
        .toMatchObject({ ok: true, result: { kind: 'unchanged', status: { kind: 'disabled' } } });
      expect(statusPublications).toBe(settledPublications);
      expect(publications).toBe(3); expect(launches).toHaveLength(3);
      // Desired-off alone is not convergence while an existing Agent remains.
      sessionsToReplace = 1;
      const pendingOffAction = await executor.execute('machines.agentIsolation.preview', { machineId: machine.id, enabled: false }, { surface: 'cli', serverId: 'home' });
      if (!pendingOffAction.ok) throw new Error(pendingOffAction.errorCode);
      const pendingOff = MachineAgentIsolationPreviewResultV1Schema.parse(pendingOffAction.result);
      if (pendingOff.kind !== 'ready') throw new Error('Pending replacement review unavailable');
      expect(await executor.execute('machines.agentIsolation.set', { machineId: machine.id, enabled: false,
        expectedPolicy: pendingOff.policy, expectedMetadataVersion: pendingOff.metadataVersion,
        expectedPlanDigest: pendingOff.plan.planDigest }, { ...setContext, actionRequestId: 'disable-pending-agent' }))
        .toMatchObject({ ok: true, result: { kind: 'accepted', status: { kind: 'applying', phase: 'runtime_replacement' } } });
      expect(publications).toBe(3); expect(launches).toHaveLength(3);
      sessionsToReplace = 0;
      // The field may have committed just before its admitted transport retires.
      // That old operation cannot publish runtime state into the new authority.
      roots = [{ rootId: 'checkout', path: root }];
      daemonIdentityUnavailable = false;
      const retiringAction = await executor.execute('machines.agentIsolation.preview', { machineId: machine.id, enabled: true }, { surface: 'cli', serverId: 'home' });
      if (!retiringAction.ok) throw new Error(retiringAction.errorCode);
      const retiring = MachineAgentIsolationPreviewResultV1Schema.parse(retiringAction.result);
      if (retiring.kind !== 'ready') throw new Error('Retirement needs a real admitted review');
      const stateBeforeRetirement = machine.daemonState;
      revokeAfterPublication = true;
      const retired = await executor.execute('machines.agentIsolation.set', { machineId: machine.id, enabled: true,
        expectedPolicy: retiring.policy, expectedMetadataVersion: retiring.metadataVersion,
        expectedPlanDigest: retiring.plan.planDigest }, { ...setContext, actionRequestId: 'retiring-admission' });
      expect(retired).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(publications).toBe(4);
      expect(machine.daemonState).toBe(stateBeforeRetirement);
      expect(launches).toHaveLength(3);
      // Rejoining creation is not permission to replay defaults over a later
      // explicit disable, even if original child receipts are no longer held.
      admissionCurrent = true; revokeAfterPublication = false; creationDefault = true;
      machine.metadata = { ...machine.metadata!, agentIsolation: { enabled: false } }; machine.metadataVersion++;
      const creationAction = await executor.execute('machines.agentIsolation.preview', { machineId: machine.id, enabled: true }, { surface: 'cli', serverId: 'home' });
      if (!creationAction.ok) throw new Error(creationAction.errorCode);
      const creation = MachineAgentIsolationPreviewResultV1Schema.parse(creationAction.result);
      if (creation.kind !== 'ready') throw new Error('Creation recovery review unavailable');
      const creationInput = { machineId: machine.id, enabled: true, expectedPolicy: creation.policy,
        expectedMetadataVersion: creation.metadataVersion, expectedPlanDigest: creation.plan.planDigest };
      const writesBeforeCreation = committedWrites, statusesBeforeCreation = statusPublications;
      expect(await executor.execute('machines.agentIsolation.set', creationInput, { ...setContext, actionRequestId: 'creation-explicit-off' }))
        .toMatchObject({ ok: true, result: { kind: 'unchanged' } });
      expect(committedWrites).toBe(writesBeforeCreation); expect(statusPublications).toBe(statusesBeforeCreation);
      expect(launches).toHaveLength(3);
      // The same restriction survives an unrelated-field rebase where the
      // competing write materializes explicit-off during our first CAS.
      const { agentIsolation: _policy, ...uninitializedMetadata } = machine.metadata!;
      machine.metadata = uninitializedMetadata; machine.metadataVersion++;
      creationViaSocket = true;
      publishExplicitOffOnNextCas = true;
      expect(await executor.execute('machines.agentIsolation.set', creationInput, { ...setContext, actionRequestId: 'creation-off-contention' }))
        .toMatchObject({ ok: true, result: { kind: 'unchanged' } });
      expect(machine.metadata?.agentIsolation).toEqual({ enabled: false });
      expect(committedWrites).toBe(writesBeforeCreation); expect(statusPublications).toBe(statusesBeforeCreation);
      expect(launches).toHaveLength(3);
      machine.metadata = uninitializedMetadata; machine.metadataVersion++;
      expect(await executor.execute('machines.agentIsolation.set', creationInput, { ...setContext, actionRequestId: 'creation-initial-default' }))
        .toMatchObject({ ok: true, result: { kind: 'accepted', status: unqualifiedStatus } });
      expect(machine.metadata?.agentIsolation).toEqual({ enabled: true });
      expect(committedWrites).toBe(writesBeforeCreation + 1);
    });
  });
  it.each(['machines.agentIsolation.preview', 'machines.agentIsolation.set'] as const)(
    'refuses a foreign Home at the receiving %s handler before reading policy', async actionId => {
      const handlers: RpcHandlerMap = new Map();
      let reads = 0;
      registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
        target: () => ({ serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'account' }),
        read: () => { reads++; return { enabled: false, status: { kind: 'disabled' } }; },
      });
      const context: RpcHandlerContext = { signal: new AbortController().signal,
        machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true };
      const handler = handlers.get(actionId);
      if (!handler) throw new Error('The production isolation RPC registration is absent');
      const request = { serverId: 'other-home', machineId: 'machine', enabled: true,
        ...(actionId === 'machines.agentIsolation.set' ? { expectedMetadataVersion: 1,
          expectedPolicy: { enabled: false }, expectedPlanDigest: 'caller-supplied-digest' } : {}) };
      await expect(handler(request, context)).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(reads).toBe(0);
    });

  it.each(['plain', 'e2ee'] as const)('does not invent effect readiness from opened %s policy alone', async mode => {
    const codec = createMachineContentCodec(mode === 'plain' ? { encryptionMode: 'plain' }
      : { encryptionMode: 'e2ee', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey' });
    // Constructed network-boundary content goes through the actual Account-mode
    // codec; no UI writer or substituted metadata mutation is involved.
    const metadata = codec.decodeStored(codec.encodeStored({ agentIsolation: { enabled: false } }));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Opened Machine metadata is required');
    // Canonical untyped RPC transport boundary; Action and handler schemas
    // below still perform the actual input/output admission.
    const handlers: RpcHandlerMap = new Map();
    registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
      target: () => ({ serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'account' }),
      read: () => readAgentIsolationSnapshot({ metadata: { status: 'ready', metadata: { ...metadata }, metadataVersion: 1 },
        daemonState: { runtimeId: 'daemon', agentIsolation: { kind: 'disabled' } }, runtimeId: 'daemon', platform: 'linux' }),
    });
    const context: RpcHandlerContext = { signal: new AbortController().signal,
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: mode },
      verifyMachineAdmissionCurrent: async () => true };
    const executor = createActionExecutor({ machineAgentIsolationAction: async ({ actionId, input }) => {
      const handler = handlers.get(actionId);
      if (!handler) throw new Error('The production isolation RPC registration is absent');
      return await handler(input, context);
    } } as ActionExecutorDeps);
    const result = await executor.execute('machines.agentIsolation.preview', {
      serverId: 'home', machineId: 'machine', enabled: true,
    }, { surface: 'cli', serverId: 'home' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Preview Action failed before the target result: ${result.errorCode}`);
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse(result.result);
    // Opened desired metadata and even current Manage admission cannot stand
    // in for exact root, ACL, replacement and runtime observations.
    expect(preview).toEqual({ kind: 'unavailable', status: { kind: 'unavailable', code: 'provisioning_unavailable' } });
    expect(await executor.execute('machines.agentIsolation.preview', {
      machineId: 'machine', enabled: true,
    }, { surface: 'cli', serverId: 'home' })).toEqual(result);
  });
});
