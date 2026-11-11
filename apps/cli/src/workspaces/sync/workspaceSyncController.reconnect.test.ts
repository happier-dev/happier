import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { WorkspaceSyncController } from './workspaceSyncController';
import { createWorkspaceSyncMutagenAdapter } from './workspaceSyncMutagenAdapter';
import { createWorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import { computeWorkspaceSyncPolicyDigest } from './workspaceSyncTypes';
import { listenWorkspaceSyncBroker } from './transport/workspaceSyncBroker';
import { WorkspaceSyncBrokerClient } from './transport/workspaceSyncBrokerClient.testkit';
import { deriveWorkspaceSyncEndpointId, type MutagenSessionSummaryV1 } from './transport/workspaceSyncBrokerProtocol';

describe('Workspace Sync native reconnect settlement', () => {
  it.each(['resume', 'flush'] as const)('releases the controller queue when a %s endpoint fails before native acknowledgement', async failedCommand => {
    const root = await mkdtemp(join(tmpdir(), 'wsr-'));
    const alphaRoot = join(root, 'alpha');
    const betaRoot = join(root, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = {
      v: 1 as const, relationshipId: 'reconnect', controllerMachineId: 'machine',
      alphaWorkspaceRefId: 'alpha', betaWorkspaceRefId: 'beta', mode: 'keep_synced' as const,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      enabled: true, createdAtMs: 1, updatedAtMs: 1,
    };
    const endpoint = (role: 'alpha' | 'beta') => ({
      protocol: 'external' as const, host: deriveWorkspaceSyncEndpointId(relationship.relationshipId, role), path: '' as const,
      state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
    });
    let native: MutagenSessionSummaryV1 | null = null;
    const agents: PassThrough[] = [];
    let refuseAgent = false;
    let endpointFailed!: () => void;
    const failure = new Promise<void>(resolve => { endpointFailed = resolve; });
    let flushStarted!: () => void;
    const started = new Promise<void>(resolve => { flushStarted = resolve; });
    const resolveWorkspaceRef = (id: string) => ({ machineId: 'machine', rootPath: id === 'alpha' ? alphaRoot : betaRoot });
    const secret = randomBytes(32);
    const controller = new WorkspaceSyncController({
      adapter: createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef,
        send: (command, signal, operationId) => broker.command(command, { signal, operationId }) }),
      lifecycle: { start: async () => undefined, stop: async () => undefined },
      localMachineId: 'machine', resolveWorkspaceRef,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(root, 'locks') }),
      openLocalWorkspaceAgentStream: async () => {
        // Mutagen agent process/pipe boundary. All controller, broker and adapter logic is real.
        if (refuseAgent) {
          throw Object.assign(new Error('Target daemon lost its retained ingress'), { code: 'peer_unavailable' });
        }
        const stream = new PassThrough();
        agents.push(stream);
        return { stream, stop: async () => { stream.destroy(); } };
      },
    });
    const broker = await listenWorkspaceSyncBroker({ socketPath: join(root, 'broker.sock'), launchSecret: secret,
      openExternalStream: context => controller.openExternalStream(context) });
    const client = new WorkspaceSyncBrokerClient({ endpointPath: broker.socketPath,
      brokerInstanceId: broker.brokerInstanceId, launchNonce: broker.launchNonce, launchSecret: secret, sidecarPid: process.pid });
    const holdUntilCancelled = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      signal.throwIfAborted();
    };
    const commands: string[] = [];
    client.onCommand(async (command, signal) => {
      commands.push(command.t);
      if (command.t === 'list') return { sessions: native ? [native] : [], nextCursor: null };
      if (command.t === 'create') {
        native = { identifier: 'native-reconnect', name: command.session.name, labels: command.session.labels,
          alpha: endpoint('alpha'), beta: endpoint('beta'), mode: command.session.mode,
          paused: false, status: 'watching', successfulCycles: 1, conflictCount: 0 };
      }
      if (command.t === failedCommand) {
        if (failedCommand === 'resume') {
          refuseAgent = true;
          await client.openStream(deriveWorkspaceSyncEndpointId(relationship.relationshipId, 'beta')).catch(() => undefined);
          endpointFailed();
        } else {
          flushStarted();
        }
        // A native command can remain pending after its endpoint has failed.
        // Its existing cancellation ABI must release the native serial queue.
        await holdUntilCancelled(signal);
      }
      if (command.t === 'terminate') { native = null; return { ok: true }; }
      return native;
    });
    const cancellation = new AbortController();
    let running: Promise<unknown> | undefined;
    try {
      await client.connectControl();
      await controller.ensure(relationship);
      if (failedCommand === 'resume') {
        native = { ...native!, status: 'disconnected', beta: { ...endpoint('beta'), state: null } };
      } else {
        await client.openStream(deriveWorkspaceSyncEndpointId(relationship.relationshipId, 'beta'));
      }
      let outcome: unknown;
      running = controller.flush(relationship.relationshipId, cancellation.signal).catch(error => { outcome = error; });
      if (failedCommand === 'resume') await failure;
      else {
        await started;
        agents[0]!.destroy(Object.assign(new Error('Target daemon stopped'), { code: 'peer_unavailable' }));
      }
      // Drain actual socket work, without a product timer or a test timeout deciding settlement.
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(outcome).toMatchObject({ code: 'peer_unavailable' });
      await running;
      await controller.terminate(relationship.relationshipId);
      expect(native).toBeNull();
      expect(commands.filter(command => command === failedCommand)).toHaveLength(1);
    } finally {
      cancellation.abort();
      await running;
      await client.close();
      await controller.shutdown();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
