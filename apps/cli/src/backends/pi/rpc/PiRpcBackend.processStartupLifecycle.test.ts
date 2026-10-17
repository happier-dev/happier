import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const artifactBoundary = vi.hoisted(() => ({
  materialize: vi.fn(),
}));
const fsBoundary = vi.hoisted(() => ({
  stat: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsBoundary.stat.mockImplementation(actual.stat);
  return { ...actual, stat: fsBoundary.stat };
});

vi.mock('@/utils/fs/protectedTempTextArtifact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/fs/protectedTempTextArtifact')>();
  return {
    ...actual,
    materializeProtectedTempTextArtifact: (params: Parameters<typeof actual.materializeProtectedTempTextArtifact>[0]) =>
      params.prefix === 'happier-pi-append-system-prompt-'
        ? artifactBoundary.materialize(params)
        : actual.materializeProtectedTempTextArtifact(params),
  };
});

import type { AgentMessage } from '@/agent/core';

import { PiRpcBackend } from './PiRpcBackend';

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function writeFakePi(dir: string, options: Readonly<{ exitAfterState?: boolean; createSession?: boolean; startupActivity?: 'streaming' | 'compacting'; finishFile?: string }> = {}): string {
  const script = join(dir, 'fake-pi-startup.js');
  writeFileSync(script, `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
let created = ${options.createSession !== true};
let active = ${options.startupActivity !== undefined};
const state = () => ({ ...(created ? { sessionId: 'pi-startup' } : {}), model: { id: 'm', provider: 'p' },
  isStreaming: active && ${options.startupActivity === 'streaming'}, isCompacting: active && ${options.startupActivity === 'compacting'} });
const beginActivity = () => { if (active) out({ type: 'agent_start' }); };
if (created) beginActivity();
const finishFile = ${JSON.stringify(options.finishFile ?? null)};
if (finishFile) {
  const fs = require('node:fs');
  fs.watchFile(finishFile, { interval: 10, persistent: false }, stat => {
    if (stat.size === 0) return;
    fs.unwatchFile(finishFile);
    active = false;
    out({ type: 'agent_end' });
  });
}
rl.on('line', line => {
  const command = JSON.parse(line);
  const base = { id: command.id, type: 'response', command: command.type, success: true };
  if (command.type === 'get_state') {
    out({ ...base, data: state() });
    if (${options.exitAfterState === true}) setTimeout(() => process.exit(1), 20);
    return;
  }
  if (command.type === 'new_session') {
    created = true;
    beginActivity();
    return out({ ...base, data: { cancelled: false } });
  }
  if (command.type === 'get_available_models') {
    if (${options.exitAfterState === true}) return;
    return out({ ...base, data: { models: [] } });
  }
  if (command.type === 'get_commands') return out({ ...base, data: { commands: [] } });
  out({ ...base, data: {} });
});
`);
  chmodSync(script, 0o755);
  return script;
}

describe('PiRpcBackend process startup lifecycle', () => {
  const backends: PiRpcBackend[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    artifactBoundary.materialize.mockReset();
    fsBoundary.stat.mockClear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { operation: 'start', createSession: false, startupActivity: 'streaming' },
    { operation: 'start', createSession: true, startupActivity: 'compacting' },
    { operation: 'resume', createSession: false, startupActivity: 'streaming' },
  ] as const)('does not complete $startupActivity provider work during $operation startup (create=$createSession)', async ({ operation, createSession, startupActivity }) => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-startup-active-'));
    dirs.push(dir);
    const finishFile = join(dir, 'finish');
    writeFileSync(finishFile, '');
    const backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [writeFakePi(dir, { createSession, startupActivity, finishFile })],
      env: { PI_CODING_AGENT_DIR: dir },
    });
    backends.push(backend);
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    const opened = operation === 'resume'
      ? await backend.loadSession('pi-startup')
      : await backend.startSession();
    expect(opened).toEqual({ sessionId: 'pi-startup' });
    expect(messages.some((message) => message.type === 'status' && message.status === 'running')).toBe(true);
    expect(messages.filter((message) => message.type === 'status' && message.status === 'idle')).toEqual([]);

    // The native agent_end, rather than session readiness, owns turn completion.
    writeFileSync(finishFile, 'finish');
    await vi.waitFor(() => expect(messages.filter((message) => message.type === 'status' && message.status === 'idle')).toEqual([
      { type: 'status', status: 'idle' },
    ]));
  });

  it('does not publish or spawn an artifact that finishes materializing after disposal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-startup-dispose-'));
    dirs.push(dir);
    const artifact = deferred<{ path: string; cleanup: () => Promise<void> }>();
    const cleanup = vi.fn(async () => undefined);
    artifactBoundary.materialize.mockReturnValueOnce(artifact.promise);
    const backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [writeFakePi(dir)],
      appendSystemPromptText: 'system prompt',
    });
    backends.push(backend);

    const start = backend.startSession();
    await vi.waitFor(() => expect(artifactBoundary.materialize).toHaveBeenCalledOnce());
    await backend.dispose();
    artifact.resolve({ path: join(dir, 'late-artifact.txt'), cleanup });

    await expect(start).rejects.toThrow('disposed');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('shares one protected-artifact preparation across concurrent first-use startup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-startup-single-flight-'));
    dirs.push(dir);
    const artifact = deferred<{ path: string; cleanup: () => Promise<void> }>();
    artifactBoundary.materialize.mockReturnValue(artifact.promise);
    const backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [writeFakePi(dir)],
      appendSystemPromptText: 'system prompt',
    });
    backends.push(backend);

    const first = backend.startSession();
    const second = backend.startSession();
    await vi.waitFor(() => expect(artifactBoundary.materialize).toHaveBeenCalled());
    artifact.resolve({ path: join(dir, 'artifact.txt'), cleanup: async () => undefined });

    await Promise.all([first, second]);
    expect(artifactBoundary.materialize).toHaveBeenCalledOnce();
  });

  it('preserves the five-minute session-open budget after a slow process startup', async () => {
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-startup-budget-'));
    dirs.push(dir);
    const backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [],
    });
    backends.push(backend);

    const observedTimeouts: number[] = [];
    const priv = backend as unknown as {
      connectedBrokerPreflight: Promise<{ ready: true }> | null;
      ensureProcess: () => Promise<void>;
      sendCommand: (command: { type: string }, timeoutMs: number) => Promise<{
        type: 'response';
        command: string;
        success: true;
        data: Record<string, unknown>;
      }>;
    };
    priv.connectedBrokerPreflight = Promise.resolve({ ready: true });
    priv.ensureProcess = async () => {
      nowMs = 61_000;
    };
    priv.sendCommand = async (command, timeoutMs) => {
      if (command.type === 'get_state') observedTimeouts.push(timeoutMs);
      return {
        type: 'response',
        command: command.type,
        success: true,
        data: command.type === 'get_state'
          ? { sessionId: 'pi-slow-startup', model: { id: 'm', provider: 'p' } }
          : {},
      };
    };

    await expect(backend.startSession()).resolves.toEqual({ sessionId: 'pi-slow-startup' });
    expect(observedTimeouts[0]).toBe(239_000);
  });

  it('fails at the aggregate session-open deadline and prevents a late process spawn', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-startup-timeout-'));
    dirs.push(dir);
    const artifact = deferred<{ path: string; cleanup: () => Promise<void> }>();
    const cleanup = vi.fn(async () => undefined);
    artifactBoundary.materialize.mockReturnValueOnce(artifact.promise);
    const backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [writeFakePi(dir)],
      appendSystemPromptText: 'system prompt',
    });
    backends.push(backend);

    const priv = backend as unknown as {
      process: unknown | null;
      processTransitionInFlight: Promise<void> | null;
    };
    const start = backend.startSession();
    const settled = vi.fn();
    void start.then(
      () => settled('resolved'),
      (error: unknown) => settled('rejected', error),
    );
    await vi.waitFor(() => expect(artifactBoundary.materialize).toHaveBeenCalledOnce());
    const transition = priv.processTransitionInFlight;
    expect(transition).not.toBeNull();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await Promise.resolve();
    const settlementAtDeadline = settled.mock.calls[0]?.[0] ?? 'pending';

    artifact.resolve({ path: join(dir, 'late-artifact.txt'), cleanup });
    await transition;
    await expect(start).rejects.toThrow('Pi session open timed out during process startup');
    expect(settlementAtDeadline).toBe('rejected');
    expect(priv.process).toBeNull();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('applies the aggregate process-start deadline when resuming a session', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-resume-startup-timeout-'));
    dirs.push(dir);
    const artifact = deferred<{ path: string; cleanup: () => Promise<void> }>();
    const cleanup = vi.fn(async () => undefined);
    artifactBoundary.materialize.mockReturnValueOnce(artifact.promise);
    const backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [writeFakePi(dir)],
      appendSystemPromptText: 'system prompt',
    });
    backends.push(backend);

    const priv = backend as unknown as {
      process: unknown | null;
      processTransitionInFlight: Promise<void> | null;
    };
    const load = backend.loadSession('pi-startup');
    const settled = vi.fn();
    void load.then(
      () => settled('resolved'),
      (error: unknown) => settled('rejected', error),
    );
    await vi.waitFor(() => expect(artifactBoundary.materialize).toHaveBeenCalledOnce());
    const transition = priv.processTransitionInFlight;
    expect(transition).not.toBeNull();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await Promise.resolve();
    const settlementAtDeadline = settled.mock.calls[0]?.[0] ?? 'pending';

    artifact.resolve({ path: join(dir, 'late-artifact.txt'), cleanup });
    await transition;
    await expect(load).rejects.toThrow('Pi session open timed out during process startup');
    expect(settlementAtDeadline).toBe('rejected');
    expect(priv.process).toBeNull();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('applies the aggregate deadline while discovering a resume session file', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-resume-discovery-timeout-'));
    dirs.push(dir);
    const discovery = deferred<{ isFile: () => boolean }>();
    fsBoundary.stat.mockImplementationOnce(() => discovery.promise);
    const backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [writeFakePi(dir)],
      appendSystemPromptText: 'system prompt',
    });
    backends.push(backend);

    const priv = backend as unknown as { process: unknown | null };
    const load = backend.loadSession(join(dir, 'pi-startup.jsonl'));
    const settled = vi.fn();
    void load.then(
      () => settled('resolved'),
      (error: unknown) => settled('rejected', error),
    );
    await vi.waitFor(() => expect(fsBoundary.stat).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await Promise.resolve();
    const settlementAtDeadline = settled.mock.calls[0]?.[0] ?? 'pending';

    discovery.resolve({ isFile: () => true });
    await expect(load).rejects.toThrow('Pi session open timed out during session file discovery');
    expect(settlementAtDeadline).toBe('rejected');
    expect(artifactBoundary.materialize).not.toHaveBeenCalled();
    expect(priv.process).toBeNull();
  });

  it('cleans the protected artifact when the Pi process cannot launch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-startup-error-'));
    dirs.push(dir);
    const cleanup = vi.fn(async () => undefined);
    artifactBoundary.materialize.mockResolvedValueOnce({
      path: join(dir, 'artifact.txt'),
      cleanup,
    });
    const backend = new PiRpcBackend({
      cwd: dir,
      command: join(dir, 'missing-pi-command'),
      args: [],
      appendSystemPromptText: 'system prompt',
    });
    backends.push(backend);

    await expect(backend.startSession()).rejects.toThrow();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });

  it('cleans the protected artifact when the active Pi process exits unexpectedly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-startup-exit-'));
    dirs.push(dir);
    const cleanup = vi.fn(async () => undefined);
    artifactBoundary.materialize.mockResolvedValueOnce({
      path: join(dir, 'artifact.txt'),
      cleanup,
    });
    const backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [writeFakePi(dir, { exitAfterState: true })],
      appendSystemPromptText: 'system prompt',
    });
    backends.push(backend);

    await expect(backend.startSession()).resolves.toEqual({ sessionId: 'pi-startup' });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });
});
