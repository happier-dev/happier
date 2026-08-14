import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PI_BROKER_STATE_PATH_ENV,
  PI_BROKER_LOAD_NONCE_ENV,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  PiBrokerReadinessError,
  ensurePiBrokerExtensionAsset,
  serializePiBrokerSelections,
} from '@/backends/pi/brokerExtension';

import { PiRpcBackend } from './PiRpcBackend';

/**
 * Integration of the fail-closed broker preflight into the Pi prompt path (Option A: daemon is the sole
 * refresher). A brokered Pi session's stored credential carries NO real provider refresh token, so a
 * prompt MUST NOT reach Pi until the broker extension is materialized + loaded and the daemon bridge is
 * reachable — otherwise Pi would attempt a request with a non-functional credential. `sendPrompt`
 * therefore runs the preflight BEFORE touching the Pi process; native + direct-API-key sessions (no
 * broker env) skip the gate entirely.
 */
type PrivateBrokerGateBackend = {
  connectedBrokerPreflight: Promise<unknown> | null;
  options: { env: Record<string, string> };
  process: { kill: (signal?: NodeJS.Signals | number) => boolean } | null;
  sessionId: string | null;
  ensureProcess: () => Promise<void>;
  sendCommand: (command: { type: string; message?: string }) => Promise<unknown>;
  spawnRpcProcess: (params: { args: string[] }) => void;
  stopRpcProcessForRestart: () => Promise<void>;
  restartAndContinue: () => Promise<void>;
  maybeRestartForUpdatedAuthJson: () => Promise<void> | null;
  createPendingTurn: () => Promise<void>;
};

const SESSION_ID = 'pi-session-broker-gate';

describe('PiRpcBackend connected-service broker preflight (fail-closed)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function createGatedBackend(env: Record<string, string>): {
    backend: PiRpcBackend;
    priv: PrivateBrokerGateBackend;
    startSession: () => Promise<{ sessionId: string }>;
    sendPrompt: (text: string) => Promise<void>;
    sendPromptWithAdmission: (text: string) => ReturnType<PiRpcBackend['sendPromptWithAdmission']>;
    trackers: { sentPromptCount: number; ensureProcessReached: boolean; rpcCommandCount: number };
  } {
    const workDir = mkdtempSync(join(tmpdir(), 'happier-pi-broker-gate-'));
    tempDirs.push(workDir);
    const backend = new PiRpcBackend({ cwd: workDir, command: process.execPath, args: [], env });
    const trackers = { sentPromptCount: 0, ensureProcessReached: false, rpcCommandCount: 0 };
    const priv = backend as unknown as PrivateBrokerGateBackend;
    priv.sessionId = SESSION_ID;
    priv.maybeRestartForUpdatedAuthJson = () => null;
    priv.sendCommand = async (command) => {
      trackers.rpcCommandCount += 1;
      if (command.type === 'prompt') trackers.sentPromptCount += 1;
      return { type: 'response', command: command.type, success: true };
    };
    return {
      backend,
      priv,
      trackers,
      startSession: () => backend.startSession(),
      sendPrompt: (text) => backend.sendPrompt(SESSION_ID, text),
      sendPromptWithAdmission: (text) => backend.sendPromptWithAdmission(SESSION_ID, text),
    };
  }

  async function waitForHook(label: string, resolveHook: () => unknown): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (resolveHook()) return;
      await Promise.resolve();
    }
    throw new Error(`${label} hook was not reached`);
  }

  function invokeHook(label: string, hook: (() => void) | null): void {
    if (!hook) throw new Error(`${label} hook was not reached`);
    hook();
  }

  it('throws and never sends a prompt when a brokered session is not ready (daemon bridge unreachable)', async () => {
    const { priv, trackers, sendPromptWithAdmission } = createGatedBackend({
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:claude-pro:',
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
        anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
      }),
      // Bridge target points at a file that does not exist ⇒ the preflight fails closed immediately
      // (no handshake polling, no network).
      [PI_BROKER_STATE_PATH_ENV]: join(tmpdir(), 'happier-pi-broker-gate-no-daemon-state.json'),
    });
    // Guard: if the gate ever lets execution through, reaching the process would surface a distinct
    // error so the assertion below would fail loudly rather than silently passing.
    priv.ensureProcess = async () => {
      trackers.ensureProcessReached = true;
      throw new Error('reached-ensure-process');
    };

    const submission = sendPromptWithAdmission('hello');
    await expect(submission.admission).resolves.toMatchObject({
      status: 'rejected_before_effect',
      error: {
        message: expect.stringMatching(/broker_daemon_bridge_unreachable/),
      },
    });
    await expect(submission.completion).rejects.toThrow(/broker_daemon_bridge_unreachable/);
    // Fail-closed: the gate runs BEFORE the Pi process is touched or any prompt is written.
    expect(trackers.ensureProcessReached).toBe(false);
    expect(trackers.sentPromptCount).toBe(0);
  });

  it('throws before Pi session creation commands when a brokered session is not ready', async () => {
    const { priv, trackers, startSession } = createGatedBackend({
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:claude-pro:',
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
        anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
      }),
      [PI_BROKER_STATE_PATH_ENV]: join(tmpdir(), 'happier-pi-broker-gate-no-daemon-state.json'),
    });
    priv.sessionId = null;
    priv.ensureProcess = async () => {
      trackers.ensureProcessReached = true;
    };

    await expect(startSession()).rejects.toThrow(/broker_daemon_bridge_unreachable/);
    expect(trackers.ensureProcessReached).toBe(true);
    expect(trackers.rpcCommandCount).toBe(0);
  });

  it('fails the broker readiness wait when the exact spawned Pi child exits', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'happier-pi-broker-process-exit-'));
    tempDirs.push(workDir);
    const agentDir = join(workDir, 'pi-agent');
    const brokerStatePath = join(workDir, 'connected-service-broker.state.json');
    writeFileSync(brokerStatePath, JSON.stringify({
      httpPort: 5,
      connectedServiceBrokerRefreshToken: 'scoped',
    }));
    await ensurePiBrokerExtensionAsset(agentDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 50)'],
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        [PI_BROKER_STATE_PATH_ENV]: brokerStatePath,
        [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:claude-pro:',
        [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
          anthropic: {
            serviceId: 'claude-subscription',
            profileId: 'claude-pro',
            accountId: null,
            planType: null,
          },
        }),
      },
    });

    try {
      await expect(backend.startSession()).rejects.toThrow(/broker_process_exited/);
    } finally {
      await backend.dispose();
    }
  });

  it.each([
    { pendingCommand: 'get_state' as const, answerInitialState: false },
    { pendingCommand: 'new_session' as const, answerInitialState: true },
  ])(
    'cancels a pending session-open $pendingCommand RPC after readiness without leaking its request timer',
    async ({ pendingCommand, answerInitialState }) => {
      vi.useFakeTimers();
      const workDir = mkdtempSync(join(tmpdir(), 'happier-pi-session-open-cancel-'));
      tempDirs.push(workDir);
      const backend = new PiRpcBackend({ cwd: workDir, command: process.execPath, args: [], env: {} });
      const controller = new AbortController();
      const observedCommands: string[] = [];
      const priv = backend as unknown as {
        connectedBrokerPreflight: Promise<unknown> | null;
        ensureProcess: () => Promise<void>;
        process: { stdin: { write: (chunk: string, callback?: (error?: Error | null) => void) => boolean } } | null;
        pendingRequests: Map<string, unknown>;
        handleResponse: (response: Record<string, unknown>) => void;
      };

      priv.connectedBrokerPreflight = Promise.resolve({ ready: true });
      priv.ensureProcess = async () => undefined;
      priv.process = {
        stdin: {
          write: (chunk, callback) => {
            callback?.(null);
            const command = JSON.parse(chunk) as { id: string; type: string };
            observedCommands.push(command.type);
            if (answerInitialState && command.type === 'get_state') {
              priv.handleResponse({
                id: command.id,
                type: 'response',
                command: 'get_state',
                success: true,
                data: {},
              });
            }
            return true;
          },
        },
      };

      const openPromise = backend.startSession(undefined, { signal: controller.signal });
      await waitForHook(`${pendingCommand} request`, () => (
        observedCommands.at(-1) === pendingCommand && priv.pendingRequests.size === 1
      ));
      expect(vi.getTimerCount()).toBe(1);

      controller.abort('session-open-cancelled');

      const failure = await openPromise.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PiBrokerReadinessError);
      expect((failure as PiBrokerReadinessError).piBrokerReadinessFailure).toEqual({
        classification: 'pi_broker_readiness_failure',
        reason: 'broker_readiness_cancelled',
        code: 'pi_broker_readiness_failure',
        sanitizedPreview: 'Pi connected-service broker was not ready before provider send',
      });
      expect(priv.pendingRequests.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('is a strict no-op for a native session (no broker env): the prompt proceeds past the preflight', async () => {
    const { priv, trackers, sendPrompt } = createGatedBackend({});
    priv.ensureProcess = async () => {
      trackers.ensureProcessReached = true;
    };
    // Resolve the turn immediately so the prompt path completes without a live Pi process.
    priv.createPendingTurn = () => Promise.resolve();

    await expect(sendPrompt('hello')).resolves.toBeUndefined();
    // The preflight did not gate a native session: execution reached the process and sent the prompt.
    expect(trackers.ensureProcessReached).toBe(true);
    expect(trackers.sentPromptCount).toBe(1);
  });

  it('rechecks broker readiness after an auth restart invalidates the initial prompt preflight', async () => {
    const { backend, priv, trackers, sendPrompt } = createGatedBackend({
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:claude-pro:',
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
        anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
      }),
    });
    priv.connectedBrokerPreflight = Promise.resolve({ ready: true });
    let releaseRestart: (() => void) | null = null;
    priv.maybeRestartForUpdatedAuthJson = async () => {
      await new Promise<void>((resolve) => {
        releaseRestart = resolve;
      });
      priv.connectedBrokerPreflight = Promise.resolve({ ready: false, reason: 'broker_load_nonce_not_observed' });
    };
    priv.ensureProcess = async () => {
      trackers.ensureProcessReached = true;
    };
    priv.createPendingTurn = () => Promise.resolve();

    const promptResult = sendPrompt('hello');
    await waitForHook('auth restart', () => releaseRestart);
    const waitResult = backend.waitForResponseComplete().catch(() => undefined);
    invokeHook('auth restart', releaseRestart);

    await expect(promptResult).rejects.toThrow(/broker_load_nonce_not_observed/);
    await waitResult;
    expect(trackers.ensureProcessReached).toBe(true);
    expect(trackers.sentPromptCount).toBe(0);
  });

  it('rechecks broker readiness after process recovery invalidates the initial prompt preflight', async () => {
    const { backend, priv, trackers, sendPrompt } = createGatedBackend({
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:claude-pro:',
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
        anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
      }),
    });
    priv.connectedBrokerPreflight = Promise.resolve({ ready: true });
    let releaseEnsureProcess: (() => void) | null = null;
    priv.ensureProcess = async () => {
      trackers.ensureProcessReached = true;
      await new Promise<void>((resolve) => {
        releaseEnsureProcess = resolve;
      });
      priv.connectedBrokerPreflight = Promise.resolve({ ready: false, reason: 'broker_load_nonce_not_observed' });
    };
    priv.createPendingTurn = () => Promise.resolve();

    const promptResult = sendPrompt('hello');
    await waitForHook('ensureProcess', () => releaseEnsureProcess);
    const waitResult = backend.waitForResponseComplete().catch(() => undefined);
    invokeHook('ensureProcess', releaseEnsureProcess);

    await expect(promptResult).rejects.toThrow(/broker_load_nonce_not_observed/);
    await waitResult;
    expect(trackers.ensureProcessReached).toBe(true);
    expect(trackers.sentPromptCount).toBe(0);
  });

  it('does not retry a prompt after an ambiguous provider write failure', async () => {
    const { priv, trackers, sendPrompt } = createGatedBackend({
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:claude-pro:',
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
        anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
      }),
    });
    priv.connectedBrokerPreflight = Promise.resolve({ ready: true });
    priv.ensureProcess = async () => {
      trackers.ensureProcessReached = true;
    };
    let restartCount = 0;
    priv.restartAndContinue = async () => {
      restartCount += 1;
      // This mirrors the real respawn boundary: spawn rotates the broker load nonce, clears the old
      // readiness proof, and the next prompt must prove readiness for the new nonce before writing.
      priv.options.env[PI_BROKER_LOAD_NONCE_ENV] = 'nonce-after-restart';
      priv.connectedBrokerPreflight = Promise.resolve({ ready: false, reason: 'broker_load_nonce_not_observed' });
    };
    priv.sendCommand = async (command) => {
      if (command.type === 'prompt') {
        trackers.sentPromptCount += 1;
        if (trackers.sentPromptCount === 1) {
          throw new Error('Failed to write Pi RPC command (prompt): EPIPE');
        }
        throw new Error('second prompt write bypassed broker readiness');
      }
      trackers.rpcCommandCount += 1;
      return { type: 'response', command: command.type, success: true };
    };

    await expect(sendPrompt('hello')).rejects.toThrow(/Failed to write Pi RPC command \(prompt\): EPIPE/);
    expect(trackers.ensureProcessReached).toBe(true);
    expect(restartCount).toBe(0);
    expect(trackers.sentPromptCount).toBe(1);
  });

  it('rechecks broker readiness before provider-affecting steering commands after restart', async () => {
    const { backend, priv, trackers } = createGatedBackend({
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:claude-pro:',
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
        anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
      }),
    });
    priv.process = { kill: () => true };
    priv.connectedBrokerPreflight = Promise.resolve({ ready: true });
    priv.maybeRestartForUpdatedAuthJson = async () => {
      priv.connectedBrokerPreflight = Promise.resolve({ ready: false, reason: 'broker_load_nonce_not_observed' });
    };

    await expect(backend.sendSteerPrompt(SESSION_ID, 'steer')).rejects.toThrow(/broker_load_nonce_not_observed/);
    expect(trackers.rpcCommandCount).toBe(0);
  });

  it('rotates the broker load nonce and resets readiness before every brokered Pi process spawn', async () => {
    const { priv } = createGatedBackend({
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:claude-pro:',
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
        anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
      }),
      [PI_BROKER_STATE_PATH_ENV]: join(tmpdir(), 'happier-pi-broker-gate-no-daemon-state.json'),
    });
    priv.connectedBrokerPreflight = Promise.resolve({ ready: true });
    priv.spawnRpcProcess({ args: ['-e', 'setTimeout(() => {}, 10000)'] });
    const firstNonce = priv.options.env[PI_BROKER_LOAD_NONCE_ENV];
    expect(firstNonce).toMatch(/[0-9a-f-]{36}/);
    expect(priv.connectedBrokerPreflight).toBeNull();

    await priv.stopRpcProcessForRestart();
    priv.connectedBrokerPreflight = Promise.resolve({ ready: true });
    priv.spawnRpcProcess({ args: ['-e', 'setTimeout(() => {}, 10000)'] });
    const secondNonce = priv.options.env[PI_BROKER_LOAD_NONCE_ENV];
    expect(secondNonce).toMatch(/[0-9a-f-]{36}/);
    expect(secondNonce).not.toBe(firstNonce);
    expect(priv.connectedBrokerPreflight).toBeNull();

    await priv.stopRpcProcessForRestart();
  });
});
