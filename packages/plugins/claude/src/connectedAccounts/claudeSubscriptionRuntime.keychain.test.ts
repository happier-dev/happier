import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { claudeSubscriptionConnectedAccountRuntime as runtime } from './claudeSubscriptionNativeRuntime.js';

const { spawnSpy } = vi.hoisted(() => ({ spawnSpy: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnSpy,
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

describe('Claude native import OS cancellation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    spawnSpy.mockReset();
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
  });

  it('reads the default native Keychain before the file using only a read command', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-import-keychain-'));
    const configDir = join(homeDir, '.claude');
    await mkdir(configDir);
    const credentialPath = join(configDir, '.credentials.json');
    const fileContents = JSON.stringify({ claudeAiOauth: { accessToken: 'file-access' } });
    await writeFile(credentialPath, fileContents);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    const commands: Array<Readonly<{ command: string; args: readonly string[] }>> = [];
    spawnSpy.mockImplementation((command: string, args: readonly string[]) => {
      commands.push({ command, args });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ claudeAiOauth: {
          accessToken: 'keychain-access', refreshToken: 'keychain-refresh', expiresAt: Date.now() + 3_600_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'], subscriptionType: 'max',
        } }));
        child.emit('close', 0);
      });
      return child;
    });
    try {
      const mode = runtime.authentication.modes['native-import'];
      if (!mode || mode.kind !== 'manual') throw new Error('Claude native import is unavailable');
      const values = new Map<string, string>();
      const context = {
        signal: new AbortController().signal,
        attemptCredentials: {
          async get(key: string) { return values.get(key) ?? null; },
          async set(key: string, value: string) { values.set(key, value); },
          async delete(key: string) { values.delete(key); },
        },
      } as Parameters<typeof mode.complete>[1];
      await expect(mode.complete({ fields: { source: 'native' } }, context)).resolves.toMatchObject({ status: 'connected' });
      expect(values.get('accessToken')).toBe('keychain-access');
      expect(values.get('subscriptionType')).toBe('max');
      expect(await readFile(credentialPath, 'utf8')).toBe(fileContents);
      expect(commands.every(({ command, args }) => command === 'security'
        && args[0] === 'find-generic-password' && args.includes('Claude Code-credentials') && args.includes('-w'))).toBe(true);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('carries caller cancellation into an in-flight native keychain read', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-import-abort-'));
    const controller = new AbortController();
    const children: EventEmitter[] = [];
    const readSignals: Array<AbortSignal | undefined> = [];
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(homeDir, '.claude'));
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    spawnSpy.mockImplementation((_command: string, _args: string[], options: { signal?: AbortSignal }) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
      });
      children.push(child);
      readSignals.push(options.signal);
      options.signal?.addEventListener('abort', () => child.emit('error', new DOMException('Aborted', 'AbortError')), { once: true });
      return child;
    });
    const mode = runtime.authentication.modes['native-import'];
    if (!mode || mode.kind !== 'manual') throw new Error('Claude native import is unavailable');
    const values = new Map<string, string>();
    const context = {
      signal: controller.signal,
      attemptCredentials: {
        async get(key: string) { return values.get(key) ?? null; },
        async set(key: string, value: string) { values.set(key, value); },
        async delete(key: string) { values.delete(key); },
      },
    } as Parameters<typeof mode.complete>[1];
    const pending = mode.complete({ fields: { source: 'native' } }, context);
    const outcome = pending.then(() => null, (error: unknown) => error);
    try {
      expect(readSignals.length).toBeGreaterThan(0);
      expect(readSignals.every((signal) => signal === controller.signal)).toBe(true);
    } finally {
      controller.abort();
      for (const child of children) child.emit('close', 1);
      expect(await outcome).toMatchObject({ name: 'AbortError' });
      expect(values.size).toBe(0);
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
