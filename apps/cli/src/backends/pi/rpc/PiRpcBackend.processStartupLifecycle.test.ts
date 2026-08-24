import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const artifactBoundary = vi.hoisted(() => ({
  materialize: vi.fn(),
}));

vi.mock('@/utils/fs/protectedTempTextArtifact', () => ({
  materializeProtectedTempTextArtifact: artifactBoundary.materialize,
}));

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

function writeFakePi(dir: string, options: Readonly<{ exitAfterState?: boolean }> = {}): string {
  const script = join(dir, 'fake-pi-startup.js');
  writeFileSync(script, `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
const state = { sessionId: 'pi-startup', model: { id: 'm', provider: 'p' } };
rl.on('line', line => {
  const command = JSON.parse(line);
  const base = { id: command.id, type: 'response', command: command.type, success: true };
  if (command.type === 'get_state') {
    out({ ...base, data: state });
    if (${options.exitAfterState === true}) setTimeout(() => process.exit(1), 20);
    return;
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
