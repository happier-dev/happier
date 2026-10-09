import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  discoverNativeConfinedWorkspaceSyncRecovery,
  runNativeConfinedWorkspaceSyncApply,
  runNativeConfinedWorkspaceSyncCapture,
  runNativeConfinedWorkspaceSyncDelete,
  runNativeConfinedWorkspaceSyncObserve,
  runNativeConfinedWorkspaceSyncMeasure,
  runNativeConfinedWorkspaceSyncRead,
  runNativeConfinedWorkspaceSyncRecover,
  type WorkspaceSyncNativeConfinedChild,
} from './workspaceSyncNativeConfinedFileSystem';

class FakeChild extends EventEmitter implements WorkspaceSyncNativeConfinedChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

function createHarness(result: Readonly<Record<string, unknown>>) {
  const child = new FakeChild();
  const writes: unknown[] = [];
  let buffered = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    while (buffered.includes('\n')) {
      const newline = buffered.indexOf('\n');
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const parsed = JSON.parse(line) as unknown;
      writes.push(parsed);
      if (writes.length === 1) {
        child.stdout.write(`${JSON.stringify({ v: 1, t: 'workspace-confined-prepared' })}\n`);
      } else if ((parsed as { decision?: unknown }).decision === 'commit') {
        child.stdout.write(`${JSON.stringify(result)}\n`);
        child.stdout.end();
        child.stderr.end();
        queueMicrotask(() => child.emit('close', 0, null));
      }
    }
  });
  return {
    child,
    writes,
    dependencies: {
      platform: 'win32' as const,
      resolveExecutable: () => 'C:\\happier-process-custody.exe',
      spawnChild: vi.fn(() => child),
    },
  };
}

describe('workspaceSyncNativeConfinedFileSystem', () => {
  it('projects only a closed passive byte observation, including an actually empty owned tree', async () => {
    for (const sizeBytes of [0, 21]) {
      const harness = createHarness({ v: 1, t: 'workspace-confined-result', status: 'measured', sizeBytes });
      await expect(runNativeConfinedWorkspaceSyncMeasure({ rootPath: 'C:\\work', relativePath: 'copy' }, harness.dependencies))
        .resolves.toBe(sizeBytes);
      expect(harness.writes[0]).toEqual({ v: 1, rootPath: 'C:\\work', relativePath: 'copy', measureSize: true });
    }
    for (const result of [
      { status: 'measured', sizeBytes: -1 },
      { status: 'measured', sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
      { status: 'measured', sizeBytes: 21, expectation: { kind: 'missing' } },
      { status: 'observed', expectation: { kind: 'directory', fingerprint: 'a'.repeat(64) } },
    ]) {
      const harness = createHarness({ v: 1, t: 'workspace-confined-result', ...result });
      await expect(runNativeConfinedWorkspaceSyncMeasure({ rootPath: 'C:\\work', relativePath: 'copy' }, harness.dependencies))
        .rejects.toMatchObject({ code: 'workspace_root_unsafe' });
    }
  });

  it('allows a native operation to finish preparing beyond fifteen seconds', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      let writes = 0;
      child.stdin.on('data', () => {
        writes += 1;
        if (writes === 2) {
          child.stdout.write(`${JSON.stringify({ v: 1, t: 'workspace-confined-result', status: 'observed', expectation: { kind: 'missing' } })}\n`);
          child.stdout.end();
          child.stderr.end();
          queueMicrotask(() => child.emit('close', 0, null));
        }
      });
      const observation = runNativeConfinedWorkspaceSyncObserve({
        rootPath: 'C:\\work',
        relativePath: 'entry',
      }, {
        platform: 'win32',
        resolveExecutable: () => 'C:\\happier-process-custody.exe',
        spawnChild: () => child,
      });
      const outcome = observation.then(
        (value) => ({ status: 'resolved' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      await vi.advanceTimersByTimeAsync(15_001);
      expect(child.kill).not.toHaveBeenCalled();
      child.stdout.write(`${JSON.stringify({ v: 1, t: 'workspace-confined-prepared' })}\n`);
      await expect(outcome).resolves.toEqual({ status: 'resolved', value: { kind: 'missing' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an absent recovery directory as having no retained records', async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), 'happier-workspace-recovery-parent-'));
    const recoveryDirectory = join(parentDirectory, 'not-created-yet');
    try {
      await expect(discoverNativeConfinedWorkspaceSyncRecovery({ recoveryDirectory })).resolves.toEqual([]);
    } finally {
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });

  it('discovers recovery identities through the native record parser', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'happier-workspace-recovery-'));
    try {
      await writeFile(join(recoveryDirectory, 'workspace-recovery-reviewed.json'), '{native record payload}');
      const harness = createHarness({
        v: 1,
        t: 'workspace-confined-result',
        status: 'recovery_record',
        operationId: 'reviewed',
        rootPath: 'C:\\work',
      });
      await expect(discoverNativeConfinedWorkspaceSyncRecovery({ recoveryDirectory }, harness.dependencies)).resolves.toEqual([{
        operationId: 'reviewed',
        rootPath: 'C:\\work',
        recoveryPath: join(recoveryDirectory, 'workspace-recovery-reviewed.json'),
      }]);
      expect(harness.dependencies.spawnChild).toHaveBeenCalledWith(
        'C:\\happier-process-custody.exe',
        ['workspace-confined-inspect'],
        expect.any(Object),
      );
      expect(harness.writes[0]).toEqual({ v: 1, recoveryDirectory, operationId: 'reviewed' });
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true });
    }
  });

  it('fails closed on a recovery record with an unrecognized native name', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'happier-workspace-recovery-'));
    try {
      await writeFile(join(recoveryDirectory, 'workspace-recovery-unsafe.json.bak'), 'retained');
      await expect(discoverNativeConfinedWorkspaceSyncRecovery({ recoveryDirectory })).rejects.toMatchObject({
        code: 'workspace_root_unsafe',
      });
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true });
    }
  });

  it.runIf(process.env.HAPPIER_RUN_NATIVE_CONFINED_WORKSPACE_SYNC_REAL_INTEGRATION === '1')(
    'uses the staged native helper for read, abort preservation, and committed deletion',
    async () => {
      expect(['darwin', 'win32']).toContain(process.platform);
      const rootPath = await mkdtemp(join(tmpdir(), 'happier-workspace-confinement-'));
      const relativePath = 'loser.txt';
      const filePath = join(rootPath, relativePath);
      const content = Buffer.from('native workspace confinement');
      const authorityError = Object.assign(new Error('root authority changed'), {
        code: 'workspace_root_changed',
      });

      try {
        await writeFile(filePath, content);
        const preview = await runNativeConfinedWorkspaceSyncRead({
          rootPath,
          relativePath,
          maxBytes: 1024,
        });
        expect(preview).toMatchObject({
          status: 'content',
          size: content.byteLength,
        });
        if (preview.status !== 'content') {
          throw new Error(`expected native content preview, received ${preview.status}`);
        }
        expect(preview.content).toEqual(content);

        await expect(runNativeConfinedWorkspaceSyncDelete({
          rootPath,
          relativePath,
          expectedKind: 'file',
          expectedDigest: preview.digest,
          assertCurrentAuthority: async () => { throw authorityError; },
        })).rejects.toBe(authorityError);
        await expect(readFile(filePath)).resolves.toEqual(content);

        await expect(runNativeConfinedWorkspaceSyncDelete({
          rootPath,
          relativePath,
          expectedKind: 'file',
          expectedDigest: preview.digest,
        })).resolves.toBeUndefined();
        await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(rootPath, { recursive: true, force: true });
      }
    },
  );

  it('holds native handles while the canonical authority is checked before preview disclosure', async () => {
    const harness = createHarness({
      v: 1,
      t: 'workspace-confined-result',
      status: 'content',
      size: 5,
      digest: 'a'.repeat(40),
      contentBase64: Buffer.from('hello').toString('base64'),
    });
    let releaseAuthority!: () => void;
    const authority = new Promise<void>((resolve) => { releaseAuthority = resolve; });
    const assertCurrentAuthority = vi.fn(async () => await authority);

    const result = runNativeConfinedWorkspaceSyncRead({
      rootPath: 'C:\\work',
      relativePath: 'src\\index.ts',
      maxBytes: 1024,
      assertCurrentAuthority,
    }, harness.dependencies);

    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    expect(harness.writes[0]).toMatchObject({
      v: 1,
      rootPath: 'C:\\work',
      relativePath: 'src\\index.ts',
      maxBytes: 1024,
    });
    releaseAuthority();
    await expect(result).resolves.toEqual({
      status: 'content',
      size: 5,
      digest: 'a'.repeat(40),
      content: Buffer.from('hello'),
    });
    expect(assertCurrentAuthority).toHaveBeenCalledTimes(1);
    expect(harness.writes[1]).toEqual({ v: 1, decision: 'commit' });
  });

  it('accepts an empty regular-file preview from the native helper', async () => {
    const harness = createHarness({
      v: 1,
      t: 'workspace-confined-result',
      status: 'content',
      size: 0,
      digest: 'a'.repeat(40),
      contentBase64: '',
    });

    await expect(runNativeConfinedWorkspaceSyncRead({
      rootPath: 'C:\\work',
      relativePath: 'empty.txt',
      maxBytes: 1024,
    }, harness.dependencies)).resolves.toEqual({
      status: 'content',
      size: 0,
      digest: 'a'.repeat(40),
      content: Buffer.alloc(0),
    });
  });

  it('aborts without commit when current authority rejects', async () => {
    const harness = createHarness({ v: 1, t: 'workspace-confined-result', status: 'deleted' });
    const authorityError = Object.assign(new Error('root changed'), { code: 'workspace_root_changed' });

    await expect(runNativeConfinedWorkspaceSyncDelete({
      rootPath: 'C:\\work',
      relativePath: 'loser.txt',
      expectedKind: 'file',
      expectedDigest: 'b'.repeat(40),
      assertCurrentAuthority: async () => { throw authorityError; },
    }, harness.dependencies)).rejects.toBe(authorityError);

    expect(harness.writes).toEqual([
      expect.objectContaining({ v: 1, expectedKind: 'file' }),
      { v: 1, decision: 'abort' },
    ]);
    expect(harness.writes).not.toContainEqual({ v: 1, decision: 'commit' });
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it('resolves a successful delete after the native helper commits', async () => {
    const harness = createHarness({ v: 1, t: 'workspace-confined-result', status: 'deleted' });

    await expect(runNativeConfinedWorkspaceSyncDelete({
      rootPath: 'C:\\work',
      relativePath: 'loser.txt',
      expectedKind: 'file',
      expectedDigest: 'b'.repeat(40),
    }, harness.dependencies)).resolves.toBeUndefined();

    expect(harness.writes[1]).toEqual({ v: 1, decision: 'commit' });
  });

  it('fails closed when the packaged native helper is unavailable', async () => {
    await expect(runNativeConfinedWorkspaceSyncRead({
      rootPath: 'C:\\work',
      relativePath: 'preview.txt',
      maxBytes: 1024,
    }, {
      platform: 'win32',
      resolveExecutable: () => null,
      spawnChild: vi.fn(),
    })).rejects.toMatchObject({ code: 'workspace_root_unsafe' });
  });

  it('rejects malformed or padded native results instead of interpreting them', async () => {
    const harness = createHarness({
      v: 1,
      t: 'workspace-confined-result',
      status: 'content',
      size: 5,
      digest: 'a'.repeat(40),
      contentBase64: Buffer.from('hello').toString('base64'),
      extra: true,
    });

    await expect(runNativeConfinedWorkspaceSyncRead({
      rootPath: 'C:\\work',
      relativePath: 'preview.txt',
      maxBytes: 1024,
    }, harness.dependencies)).rejects.toMatchObject({ code: 'workspace_root_unsafe' });
  });

  it('preserves a typed precondition rejection produced before prepare', async () => {
    const child = new FakeChild();
    child.stdin.on('data', () => {
      child.stdout.write(`${JSON.stringify({
        v: 1,
        t: 'workspace-confined-result',
        status: 'error',
        code: 'conflict_changed',
        message: 'conflict loser digest changed',
      })}\n`);
      child.stdout.end();
      child.stderr.end();
      queueMicrotask(() => child.emit('close', 0, null));
    });

    await expect(runNativeConfinedWorkspaceSyncDelete({
      rootPath: 'C:\\work',
      relativePath: 'loser.txt',
      expectedKind: 'file',
      expectedDigest: 'b'.repeat(40),
    }, {
      platform: 'win32',
      resolveExecutable: () => 'C:\\happier-process-custody.exe',
      spawnChild: () => child,
    })).rejects.toMatchObject({
      code: 'conflict_changed',
      message: 'conflict loser digest changed',
    });
  });

  it('decodes native records when a Unicode path is split across stream chunks', async () => {
    const child = new FakeChild();
    let writes = 0;
    child.stdin.on('data', (chunk: Buffer) => {
      const records = chunk.toString('utf8').trim().split('\n');
      for (const record of records) {
        if (!record) continue;
        writes += 1;
        if (writes === 1) {
          child.stdout.write(`${JSON.stringify({ v: 1, t: 'workspace-confined-prepared' })}\n`);
          continue;
        }
        const encoded = Buffer.from(`${JSON.stringify({
          v: 1,
          t: 'workspace-confined-result',
          status: 'error',
          code: 'conflict_changed',
          message: 'recovery remains at café',
          recoveryPath: 'C:\\work\\café',
        })}\n`);
        const split = encoded.indexOf(Buffer.from('é')) + 1;
        child.stdout.write(encoded.subarray(0, split));
        queueMicrotask(() => {
          child.stdout.write(encoded.subarray(split));
          child.stdout.end();
          child.stderr.end();
          queueMicrotask(() => child.emit('close', 0, null));
        });
      }
    });

    await expect(runNativeConfinedWorkspaceSyncDelete({
      rootPath: 'C:\\work',
      relativePath: 'loser.txt',
      expectedKind: 'file',
      expectedDigest: 'b'.repeat(40),
    }, {
      platform: 'win32',
      resolveExecutable: () => 'C:\\happier-process-custody.exe',
      spawnChild: () => child,
    })).rejects.toMatchObject({
      code: 'conflict_changed',
      message: 'recovery remains at café',
      recoveryPath: 'C:\\work\\café',
    });
  });

  it('terminates a helper that exceeds the bounded preview transport', async () => {
    const child = new FakeChild();
    child.stdin.on('data', () => {
      child.stdout.write(Buffer.alloc(2 * 1024 * 1024, 65));
    });

    await expect(runNativeConfinedWorkspaceSyncRead({
      rootPath: 'C:\\work',
      relativePath: 'preview.txt',
      maxBytes: 1024,
    }, {
      platform: 'win32',
      resolveExecutable: () => 'C:\\happier-process-custody.exe',
      spawnChild: () => child,
    })).rejects.toMatchObject({
      code: 'workspace_root_unsafe',
      message: 'native workspace confinement exceeded its output bound',
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('parses complete observation and file-backed capture results', async () => {
    const observed = createHarness({
      v: 1,
      t: 'workspace-confined-result',
      status: 'observed',
      expectation: { kind: 'file', digest: 'a'.repeat(40), executable: true, size: 9 },
    });
    await expect(runNativeConfinedWorkspaceSyncObserve({
      rootPath: 'C:\\work',
      relativePath: 'tool.exe',
    }, observed.dependencies)).resolves.toEqual({
      kind: 'file', digest: 'a'.repeat(40), executable: true, size: 9,
    });

    const captured = createHarness({
      v: 1,
      t: 'workspace-confined-result',
      status: 'captured',
      expectation: { kind: 'directory', fingerprint: 'b'.repeat(64) },
      materialPath: 'C:\\private\\capture\\op-1',
    });
    await expect(runNativeConfinedWorkspaceSyncCapture({
      rootPath: 'C:\\work',
      relativePath: 'tree',
      expected: { kind: 'directory', fingerprint: 'b'.repeat(64) },
      captureDirectory: 'C:\\private\\capture',
      operationId: 'op-1',
    }, captured.dependencies)).resolves.toEqual({
      expectation: { kind: 'directory', fingerprint: 'b'.repeat(64) },
      materialPath: 'C:\\private\\capture\\op-1',
    });
  });

  it('requires missing capture and apply to carry no material', async () => {
    const captured = createHarness({
      v: 1,
      t: 'workspace-confined-result',
      status: 'captured',
      expectation: { kind: 'missing' },
      materialPath: null,
    });
    await expect(runNativeConfinedWorkspaceSyncCapture({
      rootPath: 'C:\\work',
      relativePath: 'gone',
      expected: { kind: 'missing' },
      captureDirectory: 'C:\\private\\capture',
      operationId: 'op-missing',
    }, captured.dependencies)).resolves.toEqual({ expectation: { kind: 'missing' }, materialPath: null });

    const applied = createHarness({ v: 1, t: 'workspace-confined-result', status: 'installed' });
    await expect(runNativeConfinedWorkspaceSyncApply({
      rootPath: 'C:\\work',
      relativePath: 'gone',
      expectedDestination: { kind: 'file', digest: 'c'.repeat(40), executable: false, size: 3 },
      selectedExpectation: { kind: 'missing' },
      materialPath: null,
      recoveryDirectory: 'C:\\private\\recovery',
      operationId: 'op-missing',
    }, applied.dependencies)).resolves.toEqual({ status: 'installed' });
  });

  it('preserves exact recovery dispositions and rejects padded records', async () => {
    const recoveryNeeded = createHarness({
      v: 1,
      t: 'workspace-confined-result',
      status: 'recovery_needed',
      recoveryPath: 'C:\\work\\.happier-conflict-resolution-op-prior',
    });
    await expect(runNativeConfinedWorkspaceSyncApply({
      rootPath: 'C:\\work',
      relativePath: 'entry',
      expectedDestination: { kind: 'missing' },
      selectedExpectation: { kind: 'symlink', target: '../selected' },
      materialPath: 'C:\\private\\capture\\op',
      recoveryDirectory: 'C:\\private\\recovery',
      operationId: 'op',
    }, recoveryNeeded.dependencies)).resolves.toEqual({
      status: 'recovery_needed',
      recoveryPath: 'C:\\work\\.happier-conflict-resolution-op-prior',
    });

    const settled = createHarness({ v: 1, t: 'workspace-confined-result', status: 'settled' });
    await expect(runNativeConfinedWorkspaceSyncRecover({
      rootPath: 'C:\\work',
      recoveryDirectory: 'C:\\private\\recovery',
      operationId: 'op',
    }, settled.dependencies)).resolves.toEqual({ status: 'settled' });
  });
});
