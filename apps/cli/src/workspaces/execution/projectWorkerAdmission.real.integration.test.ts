import axios from 'axios';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineRpcHandlers, type MachineRpcLifecycleRegistration } from '@/api/machine/rpcHandlers';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createPythonPtyRelayProvider } from '@/terminal/pty/pythonRelay';
import type { PtyProvider } from '@/terminal/pty/provider';
import type { TerminalPtyProjectCustody, TerminalPtySessionManager } from '@/terminal/pty/sessions';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { isPidAlive } from '@/testkit/process/spawn';
import { getMachineFinitePolicyV1 } from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import { reviewProjectSetupEffect, type ProjectSetupPreparationInput } from '@/workspaces/projectSetup/projectSetupPreparation';
import { executeProjectSetup, publishProjectFiniteAdmission } from '@/workspaces/projectSetup/projectSetupExecution';
import { createProjectNativeEnvironmentIoForHost } from '@/plugins/runtime/invocation/services/exec';

import { createProjectWorkerAdmission } from './projectWorkerAdmission';

const osBoundary = vi.hoisted(() => ({
  provider: null as PtyProvider | null,
  stop: null as ((...args: Parameters<typeof killProcessTree>) => Promise<void>) | null,
  killActual: null as typeof killProcessTree | null,
}));
// Only OS adapters are replaced. The installed registration creates and
// disposes the real manager, and all lifecycle/queue/setup owners stay real.
vi.mock('@/terminal/pty/provider', async importOriginal => {
  const actual = await importOriginal<typeof import('@/terminal/pty/provider')>();
  return { ...actual, createNodePtyProvider: () => osBoundary.provider ?? actual.createNodePtyProvider() };
});
vi.mock('@/agent/runtime/process/killProcessTree', async importOriginal => {
  const actual = await importOriginal<typeof import('@/agent/runtime/process/killProcessTree')>();
  osBoundary.killActual = actual.killProcessTree;
  return { ...actual, killProcessTree: async (...args: Parameters<typeof killProcessTree>) =>
    osBoundary.stop ? await osBoundary.stop(...args) : await actual.killProcessTree(...args) };
});

// Native POSIX PTY and tree settlement are real. Windows/macOS native carriers
// retain their program-level release checks; no second process fixture is added.
describe.skipIf(process.platform === 'win32')('finite FIFO with real Project process custody', () => {
  it.each([false, true])('closes installed finite ingress but retains registered get/Stop and the PTY until real tree settlement (natural parent exit: %s)', async naturalParentExit => {
    const taskRoot = await mkdtemp(join(tmpdir(), 'happier-worker-custody-'));
    const root = join(taskRoot, 'project');
    await mkdir(join(root, '.happier'), { recursive: true });
    await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
      workspace: { setup: [{ kind: 'command', command: naturalParentExit
        ? 'trap "" HUP; sleep 3600 </dev/null >/dev/null 2>&1 & printf "finite-ready:%s\\n" "$!"'
        : 'printf finite-ready; sleep 3600' }] },
    }));
    const workspace = { id: 'worker-copy', serverId: 'home', machineId: 'target', rootPath: root, projectKey: 'project', createdAtMs: 1 };
    // These are the installed host's accepted facts, not a fabricated Home
    // authorization context. The real manager retains this exact Project root.
    const terminalCustody = {
      serverId: workspace.serverId, requesterAccountId: 'requester', machineId: workspace.machineId,
      installationId: 'worker-installation', workspaceRefId: workspace.id,
      projectKey: projectWorkspaceRefV1(workspace).projectKey, rootPath: workspace.rootPath,
    } satisfies TerminalPtyProjectCustody;
    const preparation: ProjectSetupPreparationInput = {
      workspace, projectAssociation: { workspace, project: { serverId: 'home', projectId: 'project' } },
      requester: { credentials: { token: 'requester-token', encryption: null }, serverHttpBaseUrl: 'https://home.invalid' },
      purpose: 'setup', platform: { os: process.platform, arch: process.arch }, successHomeDir: join(taskRoot, 'completed'),
      nativeIo: { resolveTool: async () => null },
    };
    const native = createPythonPtyRelayProvider({ env: process.env, platform: process.platform });
    if (!native) throw new Error('POSIX PTY relay unavailable');
    const pids: number[] = [];
    const output: string[] = [];
    const launchFailures: string[] = [];
    const childPids = () => output.flatMap(text => [...text.matchAll(/finite-ready:(\d+)/g)].map(match => Number(match[1])));
    const provider: PtyProvider = { spawn(input) {
      let pty: ReturnType<PtyProvider['spawn']>;
      try { pty = native.spawn(input); }
      catch (error) {
        // Observe only the genuine OS launch boundary, without substituting
        // its result or hiding the original error from the process owner.
        launchFailures.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        throw error;
      }
      const index = pids.length;
      pids.push(pty.pid); output.push('');
      pty.onData(data => { output[index] += data; });
      return pty;
    } };
    let stopAttempts = 0;
    // The only controlled failure is the OS tree-stop boundary. All operation,
    // queue, review/trust, launch, terminal and settlement owners remain real.
    osBoundary.provider = provider;
    osBoundary.stop = async (...args) => {
      stopAttempts++;
      if (stopAttempts === 1 || stopAttempts === 3) throw new Error('plugin_exec_termination_incomplete');
      await osBoundary.killActual!(...args);
    };
    let sessions: TerminalPtySessionManager | undefined;
    let registration: MachineRpcLifecycleRegistration | undefined;
    let operations: ReturnType<typeof createHostActionOperationRuntime> | undefined;
    try {
      const review = await reviewProjectSetupEffect(preparation);
      if (review.kind !== 'reviewed') throw new Error(review.code);
      // Authenticated Home transport is the trust boundary, not an internal
      // consent stub. The reply contains the exact current owner's reviewed effect.
      vi.spyOn(axios, 'get').mockImplementation(async (_url, options) => {
        expect(options?.headers?.Authorization).toBe('Bearer requester-token');
        return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      });
      vi.spyOn(axios, 'post').mockImplementation(async (_url, _body, options) => {
        expect(options?.headers?.Authorization).toBe('Bearer requester-token');
        return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: {
          project: preparation.projectAssociation.project, reviewedEffectDigest: review.plan.reviewedEffectDigest, approvedAtMs: 1,
        } } } };
      });
      const admission = createProjectWorkerAdmission({ machineId: workspace.machineId, admissionDrain: createDaemonAdmissionDrain(),
        readPolicy: () => getMachineFinitePolicyV1({ read: async () => ({ status: 'ready', metadataVersion: 1,
          metadata: { finitePolicyV1: { accepting: true, runAtMost: 1 } } }), compareAndSwap: async () => ({ status: 'unavailable' }) }),
      });
      let sequence = 0;
      const operationOwner = createHostActionOperationRuntime({ machineId: workspace.machineId,
        resolveAccountId: async () => 'requester', generateOperationId: () => `process-${++sequence}` });
      operations = operationOwner;
      const rpc = new RpcHandlerManager({ scopePrefix: workspace.machineId, encryptionMode: 'plain' });
      registration = registerMachineRpcHandlers({ rpcHandlerManager: rpc,
        handlers: { spawnSession: async () => ({ type: 'success', sessionId: 'unused' }), stopSession: async () => true, requestShutdown() {} },
        deps: { currentMachineId: workspace.machineId, currentServerId: workspace.serverId,
          actionOperations: operationOwner,
          createProjectFiniteRuntime: async ports => ({ ...ports, serverId: workspace.serverId, machineId: workspace.machineId,
            accountId: 'requester', credentials: preparation.requester.credentials,
            serverHttpBaseUrl: preparation.requester.serverHttpBaseUrl, workerAdmission: admission,
            nativeIo: preparation.nativeIo, resolveWorkspaceExecutionConfig: async () => null,
            environmentIo: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }),
          }),
        },
      });
      const ingress = { signal: new AbortController().signal };
      const installedRuntime = await registration.resolveProjectFiniteRuntime?.(ingress);
      if (!installedRuntime) throw new Error('Missing installed finite runtime');
      sessions = installedRuntime.terminalSessions;
      const installedSessions = sessions;
      const scope = { machineId: workspace.machineId, accountId: 'requester' };
      const invoke = (name: string) => operationOwner.observeExecution({ actionId: 'projects.prepare', actionRequestId: name,
        input: { workspace: { serverId: workspace.serverId, refId: workspace.id }, requestId: name },
        execute: operation => {
          if (!operation.operationAcceptance) throw new Error('Missing canonical operation');
          return admission.execute({ operationId: operation.operationAcceptance.operationId, workspaceRefId: workspace.id,
            signal: operation.signal, accept: handle => {
              publishProjectFiniteAdmission({ workspace, purpose: 'setup', requesterAccountId: 'requester', operation });
              operation.operationAcceptance?.accept(handle);
            },
            run: async reservation => {
              reservation.phase('setup');
              const outcome = await executeProjectSetup({ preparation, requesterAccountId: 'requester', operation,
                terminalCustody,
                terminalSessions: installedSessions, platform: process.platform, hostEnvironment: process.env,
                environmentIo: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }),
              });
              return outcome;
            },
          });
        },
      });
      expect(await invoke('first')).toMatchObject({ ok: true, result: { operation: { operationId: 'process-1', state: 'accepted' } } });
      expect(await invoke('second')).toMatchObject({ ok: true, result: { operation: { operationId: 'process-2', state: 'accepted' } } });
      await expect.poll(async () => {
        const snapshot = operations!.store.get(scope, 'process-1');
        // A compact serialized projection keeps the decisive fields in the
        // assertion output instead of Vitest collapsing the full snapshot.
        return JSON.stringify({
          ready: Boolean(output[0]?.includes('finite-ready') || ['failed', 'cancelled'].includes(snapshot?.state ?? '')),
          state: snapshot?.state ?? null, error: snapshot?.error ?? null,
          observation: snapshot?.observation ?? null, domainRef: snapshot?.domainRef ?? null,
          setupReview: snapshot?.setupReview?.code ?? null,
          load: await admission.load(), spawnedPids: pids, launchFailures,
        });
      }).toContain('"ready":true');
      expect({ operation: operations.store.get(scope, 'process-1'), load: await admission.load(), spawnedPids: pids })
        .toMatchObject({ operation: { state: 'running' }, spawnedPids: [expect.any(Number)] });
      expect(output[0]).toContain('finite-ready');
      if (naturalParentExit) {
        await expect.poll(() => isPidAlive(pids[0]!)).toBe(false);
        expect(childPids()).toHaveLength(1);
        expect(isPidAlive(childPids()[0]!)).toBe(true);
        // Parent exit is not process-tree settlement. The same accepted
        // operation must explain uncertainty without detaching public Stop.
        await expect.poll(() => operations!.store.get(scope, 'process-1')).toMatchObject({
          state: 'running', observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' },
        });
        expect(await admission.load()).toMatchObject({ running: 1, queued: 1 });
        expect(pids).toHaveLength(1);
      }
      expect(installedSessions.getLiveWorkProducer().read()).toMatchObject({ coverage: 'complete', items: [{
        category: 'terminal', state: naturalParentExit ? 'unknown' : 'active', attribution: {
          serverId: terminalCustody.serverId, accountId: terminalCustody.requesterAccountId,
          machineId: terminalCustody.machineId, installationId: terminalCustody.installationId,
        },
      }] });
      expect(operations.runner.cancel(scope, 'process-1')).toEqual({ kind: 'requested' });
      await expect.poll(() => stopAttempts).toBe(1);
      expect(await admission.load()).toMatchObject({ running: 1, queued: 1 });
      expect(pids).toHaveLength(1); expect(isPidAlive(pids[0]!)).toBe(!naturalParentExit);
      if (naturalParentExit) expect(isPidAlive(childPids()[0]!)).toBe(true);
      expect(operations.store.get(scope, 'process-1')).toMatchObject({ state: 'running',
        observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } });
      expect(operations.runner.cancel(scope, 'process-1')).toEqual({ kind: 'requested' });
      await expect.poll(() => stopAttempts).toBe(2);
      await expect.poll(() => pids.length).toBe(2);
      expect(isPidAlive(pids[0]!)).toBe(false);
      expect(operations.store.get(scope, 'process-1')?.state).toBe('cancelled');
      expect(await admission.load()).toMatchObject({ running: 1, queued: 0 });
      await expect.poll(() => output[1]).toContain('finite-ready');
      if (naturalParentExit) {
        await expect.poll(() => isPidAlive(pids[1]!)).toBe(false);
        expect(isPidAlive(childPids()[1]!)).toBe(true);
        await expect.poll(() => operations!.store.get(scope, 'process-2')).toMatchObject({
          state: 'running', observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' },
        });
      }
      const firstAttachment = operations.store.get(scope, 'process-1')?.domainRef;
      if (firstAttachment?.kind !== 'projectCommand' || !firstAttachment.terminalId) throw new Error('Missing retained output attachment');
      const firstOutput = installedSessions.read({ terminalId: firstAttachment.terminalId, cursor: 0, maxBytes: 1000000, maxEvents: 1000 });
      expect(firstOutput).toMatchObject({ ok: true, done: true });
      if (!firstOutput.ok) throw new Error(firstOutput.errorCode);
      expect(firstOutput.events.some(event => event.t === 'data' && event.data.includes('finite-ready'))).toBe(true);
      expect(await invoke('third')).toMatchObject({ ok: true, result: { operation: { operationId: 'process-3', state: 'accepted' } } });
      let retired = false;
      const retirement = registration.dispose().then(() => { retired = true; });
      await expect(registration.resolveProjectFiniteRuntime?.(ingress)).resolves.toBeNull();
      await expect(installedRuntime.isCurrent?.()).resolves.toBe(false);
      await expect.poll(() => stopAttempts).toBe(3);
      await operations.runner.waitForTerminal(scope, 'process-3');
      expect(retired).toBe(false);
      expect(isPidAlive(pids[1]!)).toBe(!naturalParentExit);
      if (naturalParentExit) expect(isPidAlive(childPids()[1]!)).toBe(true);
      expect(await admission.load()).toMatchObject({ running: 1, queued: 0 });
      expect(operations.store.get(scope, 'process-3')?.state).toBe('cancelled');
      expect(operations.store.get(scope, 'process-2')).toMatchObject({ state: 'running',
        observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } });
      expect(installedSessions.list()).toHaveLength(2);
      await expect(rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V1.get, { operationId: 'process-2' }))
        .resolves.toMatchObject({ kind: 'found', operation: { state: 'running' } });
      await expect(rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V1.cancel, { operationId: 'process-2' }))
        .resolves.toMatchObject({ kind: 'requested' });
      await retirement;
      expect(isPidAlive(pids[1]!)).toBe(false);
      if (naturalParentExit) expect(childPids().every(pid => !isPidAlive(pid))).toBe(true);
      expect(pids).toHaveLength(2);
      expect(await admission.load()).toMatchObject({ running: 0, queued: 0 });
      expect(installedSessions.list()).toEqual([]);
    } finally {
      osBoundary.stop = null;
      // Deliver cleanup through retained Stop before any emergency OS kill.
      // Killing an already-unconfirmed root outside that owner cannot prove
      // its descendant settlement and would hide an assertion behind a hang.
      if (operations) {
        const scope = { machineId: workspace.machineId, accountId: 'requester' };
        for (const operationId of ['process-1', 'process-2', 'process-3']) operations.runner.cancel(scope, operationId);
      }
      await registration?.dispose();
      await Promise.all(pids.filter(isPidAlive).map(pid => killProcessTree({ pid })));
      await Promise.all(childPids().filter(isPidAlive).map(pid => killProcessTree({ pid })));
      sessions?.dispose(); osBoundary.provider = null; vi.restoreAllMocks();
      await rm(taskRoot, { recursive: true, force: true });
    }
  });
});
