import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { normalizeCodeIntelligenceSettings } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { startCodeIntelligenceWorker } from '@/daemon/codeIntelligence/codeIntelligenceWorker';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineCodeIntelligenceRpcHandlers } from './rpcHandlers.codeIntelligence';

const execFile = promisify(execFileCallback);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await execFile('git', ['init', '-b', 'main', path]);
  await execFile('git', ['-C', path, '-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '--allow-empty', '-m', 'initial']);
}

describe('code intelligence machine RPC', () => {
  it('registers repositories only inside the machine RPC filesystem access policy', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ci-rpc-')));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const allowedRoot = join(root, 'allowed');
    await initRepo(join(allowedRoot, 'shop'));
    await initRepo(join(root, 'private', 'secrets-repo'));

    const worker = await startCodeIntelligenceWorker({
      dbPath: join(root, 'state', 'ci.sqlite'),
      readSettings: async () => normalizeCodeIntelligenceSettings({ enabled: true }),
      writeSettings: async (raw) => normalizeCodeIntelligenceSettings(raw),
      resolveApiKey: async () => null,
      resolveSessionProviders: async () => [],
      listProcesses: async () => [],
      watchDirectory: () => () => undefined,
      fetchImpl: (async () => { throw new Error('no network'); }) as typeof fetch,
      nowMs: Date.now,
      sweepIntervalMs: 60 * 60 * 1000,
    });
    cleanups.push(() => worker.stop());

    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => handlers.set(method, handler),
    } as unknown as RpcHandlerManager;
    registerMachineCodeIntelligenceRpcHandlers({
      rpcHandlerManager,
      worker,
      deps: { accessPolicy: { kind: 'restrictedRoots', roots: [allowedRoot] }, workingDirectory: allowedRoot },
    });
    const register = handlers.get(RPC_METHODS.DAEMON_CODE_INTELLIGENCE_REPOSITORY_REGISTER)!;

    expect(await register({ path: join(root, 'private', 'secrets-repo') })).toMatchObject({ ok: false, errorCode: 'path_not_allowed' });
    expect(await register({ path: join(allowedRoot, 'shop') })).toMatchObject({ ok: true, repository: { displayName: 'shop' } });

    const snapshot = worker.getSnapshot({});
    expect(snapshot.ok && snapshot.repositories.map((repository) => repository.displayName)).toEqual(['shop']);
  });
});
