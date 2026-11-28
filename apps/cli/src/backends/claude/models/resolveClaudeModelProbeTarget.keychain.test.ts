import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSpy } = vi.hoisted(() => ({ spawnSpy: vi.fn() }));

// `security` is the macOS keychain boundary; everything above it runs for real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnSpy };
});

import { resolveClaudeModelProbeTarget } from './resolveClaudeModelProbeTarget';

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

/** A `security` process that never answers, and stops the way Node stops a spawn whose signal aborts. */
function unresponsiveSecurityProcess(options: Readonly<{ signal?: AbortSignal }> | undefined) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => boolean;
  };
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit('close', null));
    return true;
  };
  options?.signal?.addEventListener('abort', () => {
    child.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    child.kill('SIGTERM');
  }, { once: true });
  return child;
}

describe('resolveClaudeModelProbeTarget saved-login keychain reads', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-probe-keychain-'));
    // The keychain is consulted only for the default `~/.claude` home, so point the home there.
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    spawnSpy.mockImplementation((_command: string, _args: readonly string[], options?: { signal?: AbortSignal }) =>
      unresponsiveSecurityProcess(options));
  });

  afterEach(async () => {
    spawnSpy.mockReset();
    if (ORIGINAL_PLATFORM_DESCRIPTOR) Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('stops an unresponsive keychain read at the discovery deadline', async () => {
    const target = await resolveClaudeModelProbeTarget({
      timeoutMs: 200,
      processEnv: { HOME: homeDir, USERPROFILE: homeDir, PATH: process.env.PATH },
    });

    expect(target).toBeNull();
    const securitySignals = spawnSpy.mock.calls
      .filter(([command]) => command === 'security')
      .map(([, , options]) => (options as { signal?: AbortSignal } | undefined)?.signal);
    expect(securitySignals.length).toBeGreaterThan(0);
    expect(securitySignals.every((signal) => signal?.aborted === true)).toBe(true);
  }, 30_000);
});
