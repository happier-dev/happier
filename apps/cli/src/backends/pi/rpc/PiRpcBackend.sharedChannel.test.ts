import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { createDeferred } from '@/testkit/async/deferred';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createTestAcpRuntime } from '@/testkit/backends/acpRuntime';
import { ProviderPromptSubmissionRejectedBeforeEffectError } from '@/agent/runtime/providerPromptSubmission';
import { TERMINAL_INPUT_BUSY_TURN_FALLBACK_WAKE_MS } from '@/agent/runtime/terminal/injection/arbiter';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { PI_BRIDGE_CONFIG_PATH_FLAG, PI_BRIDGE_USER_INPUT_MARKER_TYPE } from '@/backends/pi/bridgeExtension/piBridgeExtensionEnv';
import {
  PI_SHARED_CONTROL_BUSY_ERROR,
  PI_SHARED_CONTROL_INDETERMINATE_OUTCOME,
  PI_SHARED_CONTROL_PROMPT_HANDED_OFF,
  PI_SHARED_CONTROL_RESPONSE_TIMEOUT_MS,
} from '@/backends/pi/sharedControl/piSharedControlProtocol';

import { PiRpcBackend } from './PiRpcBackend';
import {
  PiSharedTerminalSessionMismatchError,
  PiSharedTerminalUnavailableError,
  type PiRpcChannel,
  type PiRpcChannelHost,
  type PiRpcChannelListener,
  type PiRpcChannelOpenOptions,
  type PiRpcChannelOpenSpec,
} from './piRpcChannel';

type BridgeCommand = Readonly<{ id: string; type: string; message?: string }>;
type BridgeReply = Readonly<{ success: boolean; data?: unknown; error?: string }>;
type BridgeRecord = Record<string, unknown>;
/**
 * Records the bridge sends for one web prompt; `'response'` marks where the configured response
 * goes, and `{ respond }` sends a specific response there instead.
 */
type PromptScript = ReadonlyArray<BridgeRecord | 'response' | Readonly<{ respond: BridgeReply }>>;

const RPC_ORDER_PROMPT: PromptScript = ['response', { type: 'agent_start' }, { type: 'agent_end', willRetry: false }];

/**
 * The attached transport is the boundary here: this fake stands in for the bridge extension inside
 * an interactive Pi, answering only the shared-mode command set the way the real bridge does.
 * Everything above the channel (RPC protocol, turn lifecycle, mapping) is the real backend.
 */
function createFakeAttachedPi(initialSessionId: string, beforeStateReply?: () => Promise<void> | undefined) {
  let sessionId = initialSessionId;
  // What the bridge's get_state reports as `isStreaming` (a run, including one still preparing).
  let streaming = false;
  let promptReply: BridgeReply = { success: true, data: { disposition: PI_SHARED_CONTROL_PROMPT_HANDED_OFF } };
  let promptScripts: PromptScript[] = [RPC_ORDER_PROMPT];
  const opens: Array<{ spec: PiRpcChannelOpenSpec; options: PiRpcChannelOpenOptions | undefined }> = [];
  const commands: BridgeCommand[][] = [];
  let listener: PiRpcChannelListener | null = null;
  let detachedByBackend = 0;
  let nextOpenFailure: Error | null = null;
  const availabilityListeners = new Set<() => void>();

  const emitOut = (record: Record<string, unknown>): void => {
    if (record.type === 'agent_start') streaming = true;
    if (record.type === 'agent_end') streaming = false;
    listener?.onStdoutLine(JSON.stringify(record));
  };
  const reply = (command: BridgeCommand, result: BridgeReply): void => {
    queueMicrotask(() => emitOut({ id: command.id, type: 'response', command: command.type, ...result }));
  };

  const host: PiRpcChannelHost = {
    kind: 'attached',
    open: async (spec, options) => {
      opens.push({ spec, options });
      if (nextOpenFailure) {
        const failure = nextOpenFailure;
        nextOpenFailure = null;
        throw failure;
      }
      const written: BridgeCommand[] = [];
      commands.push(written);
      const channel: PiRpcChannel = {
        listen: (next) => { listener = next; },
        write: async (line) => {
          const command = JSON.parse(line) as BridgeCommand;
          written.push(command);
          switch (command.type) {
            case 'get_state': {
              await beforeStateReply?.();
              reply(command, {
                success: true,
                data: {
                  sessionId,
                  sessionFile: null,
                  isStreaming: streaming,
                  isCompacting: false,
                  thinkingLevel: 'medium',
                  model: { id: 'model-1', provider: 'provider-1', name: 'Model 1' },
                },
              });
              return;
            }
            case 'get_commands':
              reply(command, { success: true, data: { commands: [] } });
              return;
            case 'get_session_stats':
              reply(command, { success: true, data: { sessionId } });
              return;
            case 'set_thinking_level':
              reply(command, { success: true });
              return;
            case 'abort':
              reply(command, { success: true, data: { didRequestAbort: streaming } });
              return;
            case 'prompt': {
              if (!promptReply.success) {
                reply(command, promptReply);
                return;
              }
              const script = promptScripts.length > 1 ? promptScripts.shift()! : promptScripts[0]!;
              // Pi streams these across event-loop turns; one record per macrotask.
              void (async () => {
                for (const record of script) {
                  await new Promise((resolve) => setImmediate(resolve));
                  if (record === 'response' || 'respond' in record) {
                    const result = record === 'response' ? promptReply : record.respond as BridgeReply;
                    emitOut({ id: command.id, type: 'response', command: 'prompt', ...result });
                  } else {
                    emitOut(record);
                  }
                }
              })();
              return;
            }
            default:
              reply(command, { success: false, error: 'pi_shared_unsupported_command' });
          }
        },
        close: async () => {
          detachedByBackend += 1;
          listener = null;
        },
      };
      return channel;
    },
    onSessionAvailable: (next) => {
      availabilityListeners.add(next);
      return () => { availabilityListeners.delete(next); };
    },
  };

  return {
    host,
    opens,
    commands,
    get detachedByBackend() { return detachedByBackend; },
    emitOut,
    /** `bye` followed by the bridge closing; `reattachable` unless Pi is quitting. */
    detach: (reattachable = true) => {
      const current = listener;
      listener = null;
      current?.onClosed({ kind: 'detached', reattachable });
    },
    replaceSession: (next: string) => { sessionId = next; },
    setStreaming: (next: boolean) => { streaming = next; },
    /** The next open fails, as when the bridge never says hello again. */
    failNextOpen: (error: Error) => { nextOpenFailure = error; },
    /** The host saw the terminal return to the bound session while nothing is attached. */
    announceSessionAvailable: () => { for (const next of availabilityListeners) next(); },
    setPromptReply: (next: BridgeReply) => { promptReply = next; },
    /** One script per web prompt, in order; the last one repeats. */
    setPromptScript: (...next: PromptScript[]) => { promptScripts = next; },
  };
}

const tempDirs: string[] = [];
const backends: PiRpcBackend[] = [];

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createAttachedBackend(fake: ReturnType<typeof createFakeAttachedPi>, env: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'happier-pi-shared-channel-'));
  tempDirs.push(cwd);
  const backend = new PiRpcBackend({
    cwd,
    command: 'pi',
    args: [],
    env,
    happierSessionId: 'happier-session-1',
    toolsBridgeConfigText: JSON.stringify({ probe: true }),
    channelHost: fake.host,
  });
  backends.push(backend);
  const messages: AgentMessage[] = [];
  backend.onMessage((message) => messages.push(message));
  return { backend, messages, cwd };
}

const promptCommands = (fake: ReturnType<typeof createFakeAttachedPi>) => fake.commands.flat().filter((command) => command.type === 'prompt');
const isSessionNotice = (message: AgentMessage) => message.type === 'event' && message.name === 'message';
const flushIo = async (turns = 20) => {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function readFlagValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  expect(index).toBeGreaterThanOrEqual(0);
  return args[index + 1]!;
}

describe('PiRpcBackend over an attached shared-terminal channel', () => {
  it('requires the native terminal to open the exact resume file before attachment', async () => {
    const sessionId = '3afc3fcc-1580-4739-a0f2-ace78f4ca34e';
    const fake = createFakeAttachedPi(sessionId);
    const { backend, cwd } = createAttachedBackend(fake);
    const sessionFile = join(cwd, 'renamed.jsonl');
    writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: sessionId, cwd })}\n`);

    await expect(backend.loadSession(sessionFile)).resolves.toEqual({ sessionId });

    expect(fake.opens[0]?.options?.expectedSession).toEqual({ sessionId, sessionFile });
  });

  it('adopts the terminal session id and never asks Pi to create a session', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend } = createAttachedBackend(fake);

    await expect(backend.startSession()).resolves.toEqual({ sessionId: 'pi-terminal-session' });

    const sent = fake.commands.flat().map((command) => command.type);
    expect(sent).toContain('get_state');
    expect(sent).not.toContain('new_session');
  });

  it('fails closed instead of creating a session when the terminal reports none', async () => {
    const fake = createFakeAttachedPi('');
    const { backend } = createAttachedBackend(fake);

    await expect(backend.startSession()).rejects.toThrow(/did not report a session id/);
    expect(fake.commands.flat().map((command) => command.type)).not.toContain('new_session');
  });

  it('reports terminal-started turns as provider activity with running and idle status', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend, messages } = createAttachedBackend(fake);
    await backend.startSession();
    let providerTurnEvents = 0;
    backend.onProviderTurnEvent(() => { providerTurnEvents += 1; });

    fake.emitOut({
      type: 'extension_ui_request',
      id: 'notify-1',
      method: 'notify',
      message: JSON.stringify({ type: PI_BRIDGE_USER_INPUT_MARKER_TYPE, text: 'typed in the terminal' }),
    });
    fake.emitOut({ type: 'agent_start' });
    fake.emitOut({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello from pi' } });
    fake.emitOut({ type: 'agent_end', willRetry: false });

    expect(messages).toContainEqual({ type: 'user-message', text: 'typed in the terminal' });
    const statuses = messages.filter((message) => message.type === 'status').map((message) => message.status);
    expect(statuses.slice(statuses.indexOf('running'))).toEqual(['running', 'idle']);
    expect(providerTurnEvents).toBeGreaterThanOrEqual(3);
  });

  // Pi's TUI owns the terminal: any runner console output would corrupt its screen.
  it('never writes to the terminal Pi owns when a terminal turn fails', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend, messages } = createAttachedBackend(fake);
    await backend.startSession();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      fake.emitOut({ type: 'agent_start' });
      fake.emitOut({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'model exploded' } });
      fake.emitOut({ type: 'agent_end', willRetry: false });

      expect(messages).toContainEqual(expect.objectContaining({ type: 'status', status: 'error' }));
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
      consoleError.mockRestore();
    }
  });

  it('detaches on dispose without cleaning launch artifacts the live Pi still reads', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend } = createAttachedBackend(fake);
    await backend.startSession();
    const configPath = readFlagValue(fake.opens[0]!.spec.args, `--${PI_BRIDGE_CONFIG_PATH_FLAG}`);
    expect(existsSync(configPath)).toBe(true);

    await backend.dispose();

    expect(fake.detachedByBackend).toBe(1);
    expect(existsSync(configPath)).toBe(true);
    // The host received ownership and releases them once Pi exits.
    await fake.opens[0]!.options?.retainArtifacts?.();
    expect(existsSync(configPath)).toBe(false);
  });

  it('re-attaches after bye and keeps prompting the same session', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend } = createAttachedBackend(fake);
    const { sessionId } = await backend.startSession();

    fake.detach();
    await backend.sendPrompt(sessionId, 'after reload');

    expect(fake.opens).toHaveLength(2);
    expect(fake.opens[1]!.spec.args).toEqual(expect.arrayContaining(['--session', 'pi-terminal-session']));
    expect(fake.commands[1]!.map((command) => command.type)).toContain('prompt');
  });

  it('reuses one recovery channel when multiple callers discover the previous channel is gone', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend } = createAttachedBackend(fake);
    const { sessionId } = await backend.startSession();
    fake.detach(false);
    await Promise.all([
      backend.setSessionConfigOption(sessionId, 'reasoning_effort', 'low'),
      backend.setSessionConfigOption(sessionId, 'reasoning_effort', 'high'),
    ]);
    expect(fake.opens).toHaveLength(2);
    expect(fake.commands[1]?.filter(({ type }) => type === 'set_thinking_level')).toHaveLength(2);
  });

  it('re-attaches on its own after a same-session reload so terminal turns keep reaching Happier', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend, messages } = createAttachedBackend(fake);
    await backend.startSession();

    fake.detach();
    await vi.waitFor(() => expect(fake.opens).toHaveLength(2));
    await vi.waitFor(() => expect(fake.commands[1]!.map((command) => command.type)).toContain('get_state'));
    fake.emitOut({
      type: 'extension_ui_request',
      id: 'notify-after-reload',
      method: 'notify',
      message: JSON.stringify({ type: PI_BRIDGE_USER_INPUT_MARKER_TYPE, text: 'typed after reload' }),
    });

    expect(messages).toContainEqual({ type: 'user-message', text: 'typed after reload' });
  });

  it('does not re-attach after the terminal quits', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend } = createAttachedBackend(fake);
    await backend.startSession();

    fake.detach(false);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fake.opens).toHaveLength(1);
  });

  it.each(['host refusal', 'get_state mismatch'] as const)('rejects before effect when the re-attached terminal is on another session (%s)', async (source) => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend, messages } = createAttachedBackend(fake);
    const { sessionId } = await backend.startSession();

    const unavailable = new PiSharedTerminalSessionMismatchError('The Pi terminal is on another session');
    if (source === 'host refusal') {
      fake.failNextOpen(unavailable);
    } else {
      fake.replaceSession('pi-replaced-session');
    }
    fake.detach();
    await vi.waitFor(() => expect(fake.opens).toHaveLength(2));
    await flushIo();
    expect(messages.filter(isSessionNotice)).toEqual([]);

    if (source === 'host refusal') fake.failNextOpen(unavailable);
    const submission = backend.sendPromptWithAdmission(sessionId, 'must not reach the new session');
    void submission.completion.catch(() => undefined);

    const admission = await submission.admission;
    expect(admission.status).toBe('rejected_before_effect');
    // "Not now", not "never": the row stays retryable once the terminal is back on the session.
    expect(admission.status === 'rejected_before_effect' && admission.error).toBeInstanceOf(ProviderPromptSubmissionRejectedBeforeEffectError);
    expect(admission).toMatchObject({ error: { reason: 'provider_unavailable_before_acceptance' } });
    expect(fake.commands.flat().map((command) => command.type)).not.toContain('prompt');
    // The host already posted the fence notice; the refused re-attach adds none.
    await flushIo();
    expect(messages.filter(isSessionNotice)).toEqual([]);
  });

  it('holds web prompts until an attached channel has passed its session identity check', async () => {
    let releaseStateReply!: () => void;
    const stateReply = new Promise<void>((resolve) => { releaseStateReply = resolve; });
    let delayStateReply = false;
    const fake = createFakeAttachedPi('pi-terminal-session', () => delayStateReply ? stateReply : undefined);
    const { backend } = createAttachedBackend(fake);
    const { sessionId } = await backend.startSession();

    fake.replaceSession('pi-other-session');
    delayStateReply = true;
    fake.detach();
    await vi.waitFor(() => expect(fake.commands[1]?.map((command) => command.type)).toContain('get_state'));

    const submission = backend.sendPromptWithAdmission(sessionId, 'web prompt during session identity check');
    void submission.completion.catch(() => undefined);
    try {
      await flushIo();
      expect(fake.commands[1]!.map((command) => command.type)).toEqual(['get_state']);
    } finally {
      releaseStateReply();
    }

    expect(await submission.admission).toMatchObject({
      status: 'rejected_before_effect',
      error: { reason: 'provider_unavailable_before_acceptance' },
    });
    expect(promptCommands(fake)).toEqual([]);
  });

  it('re-attaches when the host reports the terminal back on its session, so terminal turns mirror again', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend, messages } = createAttachedBackend(fake);
    await backend.startSession();
    fake.detach();
    fake.replaceSession('pi-other-session');
    await vi.waitFor(() => expect(fake.opens).toHaveLength(2));
    await flushIo();

    fake.replaceSession('pi-terminal-session');
    fake.announceSessionAvailable();
    await vi.waitFor(() => expect(fake.opens).toHaveLength(3));
    await vi.waitFor(() => expect(fake.commands[2]!.map((command) => command.type)).toContain('get_state'));
    await flushIo();
    fake.emitOut(userInputMarker('typed after returning'));

    expect(messages).toContainEqual({ type: 'user-message', text: 'typed after returning' });
  });

  it('tells the session when it cannot re-attach to the terminal', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend, messages } = createAttachedBackend(fake);
    await backend.startSession();
    fake.failNextOpen(new PiSharedTerminalUnavailableError('pi_shared_bridge_unavailable'));

    fake.detach();

    await vi.waitFor(() => expect(messages.filter(isSessionNotice)).toHaveLength(1));
  });

  it('never restarts the terminal Pi when auth.json changes', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'happier-pi-shared-agent-'));
    tempDirs.push(agentDir);
    mkdirSync(agentDir, { recursive: true });
    const authPath = join(agentDir, 'auth.json');
    writeFileSync(authPath, '{}');
    // A durable session file is what lets the RPC path restart on an auth change.
    writeFileSync(
      join(agentDir, 'pi-terminal-session.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'pi-terminal-session' })}\n`,
    );
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend } = createAttachedBackend(fake, { PI_CODING_AGENT_DIR: agentDir });
    const { sessionId } = await backend.startSession();

    const later = new Date(Date.now() + 60_000);
    utimesSync(authPath, later, later);
    await backend.sendPrompt(sessionId, 'after login in the terminal');

    expect(fake.opens).toHaveLength(1);
    expect(fake.detachedByBackend).toBe(0);
  });

  it('treats an indeterminate web prompt as possibly delivered, never as rejected', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend } = createAttachedBackend(fake);
    const { sessionId } = await backend.startSession();
    fake.setPromptReply({
      success: false,
      error: 'Unable to confirm delivery to the Pi terminal',
      data: { outcome: PI_SHARED_CONTROL_INDETERMINATE_OUTCOME },
    });

    const submission = backend.sendPromptWithAdmission(sessionId, 'hi');
    const completion = expect(submission.completion).rejects.toThrow();
    expect(await submission.admission).toMatchObject({ status: 'effect_may_have_occurred' });
    await completion;
  });

  it('directs native compaction to the terminal without writing an unsupported command', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend } = createAttachedBackend(fake);
    const { sessionId } = await backend.startSession();

    await expect(backend.compactContext(sessionId, '/compact custom instructions')).rejects.toMatchObject({
      reason: 'provider_rejected_before_acceptance',
      message: expect.stringContaining('Run /compact in the Pi terminal'),
    });
    expect(fake.commands.flat().map(({ type }) => type)).not.toContain('compact');
  });

  it('leaves native compaction and continuation to Pi after handoff', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend } = createAttachedBackend(fake);
    const { sessionId } = await backend.startSession();
    fake.setPromptScript([
      'response',
      { type: 'agent_start' },
      { type: 'agent_end', willRetry: false },
      { type: 'compaction_start', reason: 'threshold', compactionId: 'compact-1' },
      { type: 'compaction_end', reason: 'threshold', compactionId: 'compact-1', willRetry: false, result: { tokensBefore: 1800 } },
    ]);

    const submission = backend.sendPromptWithAdmission(sessionId, 'compact and continue');
    expect(await submission.admission).toEqual({ status: 'terminal_handoff' });
    await submission.completion;
    await flushIo();
    expect(promptCommands(fake)).toHaveLength(1);
  });

  // The terminal can start a run after the web row was handed to the runner but before the bridge
  // sees the prompt. Nothing reached Pi, so the row waits for that run, then runs once.
  it('holds a web prompt while the terminal runs, then sends it once Pi has settled', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend, messages } = createAttachedBackend(fake);
    const { sessionId } = await backend.startSession();
    fake.setPromptScript(
      [{ type: 'agent_start' }, { respond: { success: false, error: PI_SHARED_CONTROL_BUSY_ERROR } }],
      RPC_ORDER_PROMPT,
    );

    const submission = backend.sendPromptWithAdmission(sessionId, 'while the terminal works');
    void submission.completion.catch(() => undefined);
    let admitted: string | null = null;
    void submission.admission.then((outcome) => { admitted = outcome.status; });
    await vi.waitFor(() => expect(promptCommands(fake)).toHaveLength(1));
    await flushIo();
    expect(admitted).toBeNull();
    expect(promptCommands(fake)).toHaveLength(1);

    fake.emitOut({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'terminal answer' } });
    fake.emitOut({ type: 'agent_end', willRetry: false });

    expect((await submission.admission).status).toBe('terminal_handoff');
    await submission.completion;
    expect(promptCommands(fake)).toHaveLength(2);
    // A wait is not a provider failure: no error chip in the transcript.
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'tool-result', isError: true }));
  });

  it('withdraws a held web prompt on Stop without ever sending it to Pi', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend } = createAttachedBackend(fake);
    const { sessionId } = await backend.startSession();
    fake.setPromptScript([{ respond: { success: false, error: PI_SHARED_CONTROL_BUSY_ERROR } }], RPC_ORDER_PROMPT);
    fake.emitOut({ type: 'agent_start' });

    const submission = backend.sendPromptWithAdmission(sessionId, 'stopped before Pi was free');
    void submission.completion.catch(() => undefined);
    await vi.waitFor(() => expect(promptCommands(fake)).toHaveLength(1));
    await backend.cancel(sessionId);
    const admission = await submission.admission;
    fake.emitOut({ type: 'agent_end', willRetry: false });
    await flushIo();

    expect(admission.status).toBe('rejected_before_effect');
    expect(admission).toMatchObject({ error: { reason: 'provider_unavailable_before_acceptance' } });
    expect(promptCommands(fake)).toHaveLength(1);
    expect(fake.commands.flat().map((command) => command.type)).toContain('abort');
  });

  it('withdraws a held web prompt when Stop arrives during reattachment', async () => {
    let reattach = Promise.resolve();
    const fake = createFakeAttachedPi('pi-terminal-session', () => reattach);
    const { backend } = createAttachedBackend(fake);
    const { sessionId } = await backend.startSession();
    fake.setPromptScript([{ respond: { success: false, error: PI_SHARED_CONTROL_BUSY_ERROR } }], RPC_ORDER_PROMPT);
    const submission = backend.sendPromptWithAdmission(sessionId, 'withdraw during reload');
    void submission.completion.catch(() => undefined);
    await vi.waitFor(() => expect(promptCommands(fake)).toHaveLength(1));
    await flushIo();

    const gate = createDeferred();
    reattach = gate.promise;
    fake.detach();
    await vi.waitFor(() => expect(fake.commands[1]?.some(({ type }) => type === 'get_state')).toBe(true));
    let stopped = false;
    const stop = backend.cancel(sessionId).then(() => { stopped = true; });
    await flushIo();
    const stoppedBeforeReattach = stopped;
    fake.setStreaming(true);
    gate.resolve();
    await stop;

    expect(await submission.admission).toMatchObject({
      status: 'rejected_before_effect', error: { reason: 'provider_unavailable_before_acceptance' },
    });
    expect(promptCommands(fake)).toHaveLength(1);
    expect(stoppedBeforeReattach).toBe(true);
    expect(fake.commands[1]?.some(({ type }) => type === 'abort')).toBe(false);
  });

  it('settles a held web prompt before effect when the terminal stops answering', async () => {
    let stateReply = Promise.resolve();
    const fake = createFakeAttachedPi('pi-terminal-session', () => stateReply);
    const { backend } = createAttachedBackend(fake, {
      HAPPIER_PI_RPC_MAX_SILENT_PROBES: '2',
      HAPPIER_PI_RPC_LIVENESS_PROBE_TIMEOUT_MS: '10',
    });
    const { sessionId } = await backend.startSession();
    fake.setPromptScript([{ respond: { success: false, error: PI_SHARED_CONTROL_BUSY_ERROR } }]);
    stateReply = new Promise(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const submission = backend.sendPromptWithAdmission(sessionId, 'held while terminal is unreachable');
      void submission.completion.catch(() => undefined);
      let admission: unknown;
      void submission.admission.then((result) => { admission = result; });
      await flushIo();
      await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_BUSY_TURN_FALLBACK_WAKE_MS + 10);
      expect(admission).toBeUndefined();
      await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_BUSY_TURN_FALLBACK_WAKE_MS + 10);
      expect(admission).toMatchObject({
        status: 'rejected_before_effect', error: { reason: 'provider_unavailable_before_acceptance' },
      });
      expect(promptCommands(fake)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])('keeps a lost handoff response uncertain without aborting or resending (Pi busy: %s)', async (isStreaming) => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend } = createAttachedBackend(fake);
    const { sessionId } = await backend.startSession();
    fake.setPromptScript([]);
    fake.setStreaming(isStreaming);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const submission = backend.sendPromptWithAdmission(sessionId, 'may have reached Pi');
      const completion = expect(submission.completion).rejects.toThrow(/timed out/i);
      await flushIo();
      await vi.advanceTimersByTimeAsync(PI_SHARED_CONTROL_RESPONSE_TIMEOUT_MS);
      await flushIo();

      expect((await submission.admission).status).toBe('effect_may_have_occurred');
      await completion;
      expect(promptCommands(fake)).toHaveLength(1);
      expect(fake.commands.flat().map((command) => command.type)).not.toContain('abort');
    } finally {
      vi.useRealTimers();
    }
  });

  // A busy reason can end without a run or compaction settling (Pi's `_prepareRun` failing after it
  // marked the run active). Like Claude's unified terminal, a bounded fallback re-checks Pi itself.
  it('re-checks a held web prompt against Pi state on the terminal-input fallback wake', async () => {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend } = createAttachedBackend(fake);
    const { sessionId } = await backend.startSession();
    fake.setPromptScript([{ respond: { success: false, error: PI_SHARED_CONTROL_BUSY_ERROR } }], RPC_ORDER_PROMPT);
    fake.setStreaming(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const submission = backend.sendPromptWithAdmission(sessionId, 'held without a settle frame');
      void submission.completion.catch(() => undefined);
      await flushIo();
      expect(promptCommands(fake)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_BUSY_TURN_FALLBACK_WAKE_MS);
      await flushIo();
      // Pi still reports a run: the prompt keeps waiting.
      expect(promptCommands(fake)).toHaveLength(1);

      fake.setStreaming(false);
      await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_BUSY_TURN_FALLBACK_WAKE_MS);
      await flushIo();

      expect(promptCommands(fake)).toHaveLength(2);
    expect((await submission.admission).status).toBe('terminal_handoff');
    } finally {
      vi.useRealTimers();
    }
  });
});

const userInputMarker = (text: string): BridgeRecord => ({
  type: 'extension_ui_request',
  id: `notify-${text}`,
  method: 'notify',
  message: JSON.stringify({ type: PI_BRIDGE_USER_INPUT_MARKER_TYPE, text }),
});

/**
 * An attached bridge acknowledges handoff and projects Pi's user markers and turns.
 * The runtime leaves native turn ownership with Pi for both terminal and Happier input.
 */
describe('ACP runtime over the attached channel with shared-mode event order', () => {
  async function startRuntime(hostOwnsKeepAlive = false) {
    const fake = createFakeAttachedPi('pi-terminal-session');
    const { backend } = createAttachedBackend(fake);
    const sent: ACPMessageData[] = [];
    const committedUserRows: string[] = [];
    const keepAlive = vi.fn();
    const onProviderTurnCompleted = vi.fn();
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => { sent.push(body); },
      sendUserTextMessageCommitted: async (text) => { committedUserRows.push(text); },
      keepAlive,
    });
    const runtime = createTestAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: (thinking) => { if (hostOwnsKeepAlive) keepAlive(thinking, 'local'); },
      keepAliveOwner: hostOwnsKeepAlive ? 'host' : 'runtime',
      promptTurnOwner: 'provider',
      onProviderTurnCompleted,
      ensureBackend: async () => backend,
    });
    await runtime.startOrLoad({ resumeId: null });
    const count = (type: string) => sent.filter((message) => message?.type === type).length;
    return { fake, runtime, sent, committedUserRows, count, keepAlive, onProviderTurnCompleted };
  }

  it('lets the host publish the only presence update for a native Pi turn', async () => {
    const { fake, keepAlive, count } = await startRuntime(true);

    fake.emitOut({ type: 'agent_start' });
    fake.emitOut({ type: 'agent_end', willRetry: false });

    await vi.waitFor(() => expect(count('task_complete')).toBe(1));
    expect(keepAlive.mock.calls).toEqual([[true, 'local'], [false, 'local']]);
  });

  it('projects a prompt handed off by Happier once, using the same native input marker as terminal prompts', async () => {
    const { fake, runtime, committedUserRows, count } = await startRuntime();
    const webMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
    fake.setPromptScript([
      'response',
      { type: 'agent_start' },
      { type: 'message_start', message: webMessage },
      userInputMarker('hi'),
      { type: 'message_end', message: webMessage },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello back' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }], stopReason: 'stop' } },
      { type: 'agent_end', willRetry: false },
    ]);

    await runtime.sendPrompt('hi');
    await vi.waitFor(() => expect(count('task_complete')).toBe(1));

    expect(count('task_started')).toBe(1);
    expect(committedUserRows).toEqual(['hi']);
  });

  it('reports a native model failure after successful handoff in the session', async () => {
    const { fake, runtime, sent } = await startRuntime();
    const webMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
    fake.setPromptScript([
      { type: 'agent_start' },
      'response',
      { type: 'message_start', message: webMessage },
      { type: 'message_end', message: webMessage },
      { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'model exploded' } },
      { type: 'agent_end', willRetry: false },
    ]);

    await expect(runtime.sendPrompt('hi')).resolves.toBeUndefined();
    await vi.waitFor(() => expect(JSON.stringify(sent)).toContain('model exploded'));
  });

  it('lets a web prompt wait behind an adopted terminal run without failing it, then runs the prompt', async () => {
    const { fake, runtime, sent, count } = await startRuntime();
    fake.emitOut({ type: 'agent_start' });
    await vi.waitFor(() => expect(count('task_started')).toBe(1));
    fake.setPromptScript(
      [{ respond: { success: false, error: PI_SHARED_CONTROL_BUSY_ERROR } }],
      [
        'response',
        { type: 'agent_start' },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'web answer' } },
        { type: 'agent_end', willRetry: false },
      ],
    );

    const web = runtime.sendPrompt('from the web');
    await vi.waitFor(() => expect(promptCommands(fake)).toHaveLength(1));
    await flushIo();
    fake.emitOut({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'terminal answer' } });
    fake.emitOut({ type: 'agent_end', willRetry: false });
    await web;
    await vi.waitFor(() => expect(count('task_complete')).toBe(2));

    expect(promptCommands(fake)).toHaveLength(2);
    expect(count('task_started')).toBe(2);
    expect(sent.filter((message) => message?.type === 'turn_failed' || message?.type === 'turn_aborted')).toEqual([]);
  });

  it('fails the terminal run and still delivers the web prompt waiting behind it', async () => {
    const { fake, runtime, sent, count, onProviderTurnCompleted } = await startRuntime();
    fake.emitOut({ type: 'agent_start' });
    await vi.waitFor(() => expect(count('task_started')).toBe(1));
    fake.setPromptScript(
      [{ respond: { success: false, error: PI_SHARED_CONTROL_BUSY_ERROR } }],
      [
        'response',
        { type: 'agent_start' },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'web answer' } },
        { type: 'agent_end', willRetry: false },
      ],
    );
    const web = runtime.sendPrompt('from the web');
    await vi.waitFor(() => expect(promptCommands(fake)).toHaveLength(1));
    await flushIo();
    fake.emitOut({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'terminal model exploded' } });
    expect(count('turn_failed')).toBe(0);
    fake.emitOut({ type: 'agent_end', willRetry: false });
    await web;
    await vi.waitFor(() => expect(onProviderTurnCompleted).toHaveBeenCalledExactlyOnceWith({ assistantText: 'web answer' }));

    const turns = sent.filter((message) => message.type === 'task_started');
    expect(turns).toHaveLength(2);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'turn_failed', id: turns[0]!.id }));
    expect(sent.filter((message) => message.type === 'task_complete').map((message) => message.id)).toEqual([turns[1]!.id]);
    expect(promptCommands(fake)).toHaveLength(2);
  });

  it('cancels a Pi-aborted terminal turn without publishing its partial answer as a completion', async () => {
    const { fake, runtime, sent, count, onProviderTurnCompleted } = await startRuntime();
    fake.emitOut({ type: 'agent_start' });
    fake.emitOut({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial terminal answer' } });
    fake.emitOut({ type: 'agent_end', willRetry: false, aborted: true });
    await runtime.flushTurn();

    const started = sent.find((message) => message.type === 'task_started');
    expect(started).toBeDefined();
    expect(sent).toContainEqual(expect.objectContaining({ type: 'turn_cancelled', id: started!.id }));
    expect(count('task_complete')).toBe(0);
    expect(onProviderTurnCompleted).not.toHaveBeenCalled();
  });

  it.each([false, true])('settles native overflow from the final Pi result (recovered: %s)', async (recovered) => {
    const { fake, runtime, count } = await startRuntime();
    fake.emitOut({ type: 'agent_start' });
    fake.emitOut({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'context_length_exceeded' },
    });
    await flushIo();
    expect(count('turn_failed')).toBe(0);
    if (recovered) {
      fake.emitOut({ type: 'compaction_start', reason: 'overflow' });
      fake.emitOut({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true });
      fake.emitOut({ type: 'agent_start' });
      fake.emitOut({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    }
    fake.emitOut({ type: 'agent_end', willRetry: false });
    await runtime.flushTurn();

    expect(count('turn_failed')).toBe(recovered ? 0 : 1);
    expect(count('task_complete')).toBe(recovered ? 1 : 0);
  });

  it('commits a terminal prompt once when its marker follows agent_start', async () => {
    const { fake, runtime, committedUserRows, count } = await startRuntime();
    const terminalMessage = { role: 'user', content: [{ type: 'text', text: 'from the terminal' }] };

    for (const record of [
      { type: 'agent_start' },
      { type: 'message_start', message: terminalMessage },
      userInputMarker('from the terminal'),
      { type: 'message_end', message: terminalMessage },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'terminal answer' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'terminal answer' }], stopReason: 'stop' } },
      { type: 'agent_end', willRetry: false },
    ]) {
      fake.emitOut(record);
    }
    await vi.waitFor(() => expect(count('task_complete')).toBe(1));

    expect(count('task_started')).toBe(1);
    expect(committedUserRows).toEqual(['from the terminal']);
    expect(runtime.isTurnInFlight()).toBe(false);
  });
});
