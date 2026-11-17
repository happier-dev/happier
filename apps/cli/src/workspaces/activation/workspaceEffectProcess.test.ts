import { Duplex, PassThrough } from 'node:stream';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { runWorkspaceEffectWorker } from './workspaceEffectWorker';
import { runWorkspaceEffectChannel } from './workspaceEffectProcess';
import type { MaterializedProjectCheckout } from './materializeProjectCheckout';

it('performs the canonical checkout through an admitted native byte channel', async () => {
  await withTempDir('native-workspace-channel-', async workspaceRoot => {
    const rootPath = join(workspaceRoot, 'checkout');
    await mkdir(rootPath);
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = Duplex.from({ readable: output, writable: input });
    const signal = new AbortController().signal;
    const worker = runWorkspaceEffectWorker([], { input, output, signal, currentDirectory: () => workspaceRoot })
      .finally(() => output.end());
    let result: MaterializedProjectCheckout | undefined;
    let failure: unknown;
    const outcome = await runWorkspaceEffectChannel({ channel, signal, id: 'checkout',
      effect: { workspaceRoot, workspaceRefId: 'checkout', existingRootPath: rootPath, generation: 1, plugins: [], contributions: {},
        request: { serverId: 'home', machineId: 'controller', source: { kind: 'workspace', workspaceId: 'source' }, materialization: { kind: 'attach' } } },
      services: { onEffectsIssued: async () => {}, complete: async (value: MaterializedProjectCheckout) => { result = value; },
        fail: async (error: Error) => { failure = error; } }, refusal: code => new Error(code) });
    await worker;
    expect(failure).toBeUndefined();
    expect(outcome).toEqual({ settled: true, exitedCleanly: true });
    expect(result).toMatchObject({ rootPath, directory: rootPath });
  });
});
