import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createFfmpegBrowserRecordingStreamFrameEncoderFactory } from './ffmpegStreamEncoder';
import type { RecordingSession } from './service';

// Observe unlink at the genuine filesystem boundary, including before its I/O settles.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const recording: RecordingSession = {
  v: 1, recordingId: 'recording', captureKind: 'streamFrameCapture', startedAtMs: 1_000,
  status: 'recording', durationMs: 0, byteSize: 0, frameCount: 0, fps: 12,
  mimeType: 'video/webm', retentionClass: 'preSend', redactionLevel: 'metadataOnly',
  policyState: 'allowed', actionChapters: [], relatedReferences: [],
};

describe('recording encoder output ownership', () => {
  it('waits for close after a spawn error before rejecting admission and deleting partial output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-encoder-spawn-retirement-'));
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      kill: vi.fn(() => false),
    });
    let announceSpawn: () => void = () => {};
    const spawned = new Promise<void>(resolve => { announceSpawn = resolve; });
    let outputPath = '';
    try {
      const factory = createFfmpegBrowserRecordingStreamFrameEncoderFactory({
        workingDirectory: directory, resolveFfmpegBinaryPath: async () => '/fixture/ffmpeg',
        spawnFfmpeg: (_binary, args) => {
          outputPath = args.at(-1)!;
          writeFileSync(outputPath, 'partial output');
          announceSpawn();
          return child;
        },
      });
      let settled = false;
      const result = factory({ recording, outputMimeType: 'video/webm' }).then(
        () => { settled = true; return null; },
        error => { settled = true; return error as Error; },
      );
      await spawned;
      const failure = new Error('spawn failed');
      child.emit('error', failure);
      await vi.waitFor(() => expect(child.kill).toHaveBeenCalled());
      expect(settled).toBe(false);
      expect(rm).not.toHaveBeenCalledWith(outputPath, expect.anything());
      child.emit('close', -2, null);
      expect(await result).toMatchObject({ message: 'Browser recording ffmpeg encoder failed.', cause: failure });
      await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      child.emit('close', -2, null);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['discard', 'empty', 'error', 'stdin-error'] as const)(
    'waits for physical close before removing output after %s', async outcome => {
      const directory = await mkdtemp(join(tmpdir(), 'happier-encoder-retirement-'));
      const child = Object.assign(new EventEmitter(), {
        stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        kill: vi.fn(() => true),
      });
      let outputPath = '';
      try {
        const factory = createFfmpegBrowserRecordingStreamFrameEncoderFactory({
          workingDirectory: directory, resolveFfmpegBinaryPath: async () => '/fixture/ffmpeg',
          spawnFfmpeg: (_binary, args) => {
            outputPath = args.at(-1)!;
            writeFileSync(outputPath, 'owned by the child');
            queueMicrotask(() => child.emit('spawn'));
            return child;
          },
        });
        const encoder = await factory({ recording, outputMimeType: 'video/webm' });
        const failure = new Error('encoder boundary failed');
        if (outcome === 'error' || outcome === 'stdin-error') {
          encoder.appendFrame({ sequence: 1, timestampMs: 1_000,
            payloadKind: 'image_keyframe', payload: Buffer.from('frame') });
          (outcome === 'error' ? child : child.stdin).emit('error', failure);
        }
        const operation = outcome === 'discard'
          ? encoder.discard({ recording, reason: 'user_canceled' })
          : encoder.finish({ recording, frameCount: outcome === 'empty' ? 0 : 1, durationMs: 1_000 });
        // Attach rejection handling while the OS close boundary remains deliberately held.
        const result = operation.then(() => 'discarded' as const, error => error as Error);
        await vi.waitFor(() => expect(child.kill).toHaveBeenCalled());
        expect(rm).not.toHaveBeenCalledWith(outputPath, expect.anything());
        await expect(readFile(outputPath, 'utf8')).resolves.toBe('owned by the child');
        let repeatedDiscardSettled = false;
        const repeatedDiscard = outcome === 'discard'
          ? encoder.discard({ recording, reason: 'user_canceled' }).then(() => { repeatedDiscardSettled = true; })
          : undefined;
        await Promise.resolve();
        expect(repeatedDiscardSettled).toBe(false);
        child.emit('close', null, 'SIGKILL');
        if (outcome === 'discard') expect(await result).toBe('discarded');
        else expect(await result).toMatchObject({ message: 'Browser recording ffmpeg encoder failed.',
          ...((outcome === 'error' || outcome === 'stdin-error') ? { cause: failure } : {}) });
        await repeatedDiscard;
        await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        child.emit('close', null, 'SIGKILL');
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('keeps long Unicode recording IDs and unsafe characters inside distinct valid artifact paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-encoder-identity-'));
    const paths: string[] = [];
    const children: EventEmitter[] = [];
    let nextId = 0;
    try {
      const factory = createFfmpegBrowserRecordingStreamFrameEncoderFactory({
        workingDirectory: directory, resolveFfmpegBinaryPath: async () => '/fixture/ffmpeg',
        randomId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
        spawnFfmpeg: (_binary, args) => {
          paths.push(args.at(-1)!);
          writeFileSync(args.at(-1)!, 'artifact');
          const child = Object.assign(new EventEmitter(), {
            stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
            kill: () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; },
          });
          children.push(child);
          queueMicrotask(() => child.emit('spawn'));
          return child;
        },
      });
      for (const id of ['../'.repeat(35) + ':*?"<>|\\' + '日本語'.repeat(30), 'a'.repeat(200)]) {
        const encoder = await factory({ recording: { ...recording, recordingId: id }, outputMimeType: 'video/webm' });
        await encoder.discard({ recording, reason: 'user_canceled' });
      }
      for (const path of paths) {
        expect(dirname(path)).toBe(join(directory, '.happier', 'tmp', 'browser-recordings'));
        expect(basename(path)).toMatch(/\.webm$/);
        expect(basename(path)).not.toMatch(/[<>:"\\|?*]/);
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(new Set(paths).size).toBe(2);
    } finally {
      for (const child of children) child.emit('close', null, 'SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });
});
