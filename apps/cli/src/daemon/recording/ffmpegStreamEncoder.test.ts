import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createFfmpegBrowserRecordingStreamFrameEncoderFactory, resolveRecordingOutputFormat } from './ffmpegStreamEncoder';
import type { RecordingSession } from './service';

// Observe unlink at the genuine filesystem boundary, including before its I/O settles.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const probe = vi.hoisted(() => ({ encoders: ' V..... libx264 H.264 encoder\n', calls: 0, softwareUnavailable: false, webmUnavailable: false }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: vi.fn((_path: string, _args: readonly string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    probe.calls++;
    const available = _args.includes('-encoders') || (_args.includes('libx264') && !probe.softwareUnavailable)
      || (_args.includes('libvpx') && !probe.webmUnavailable);
    callback(available ? null : new Error('encoder unavailable'), probe.encoders, '');
  }),
}));

const recording: RecordingSession = {
  v: 1, recordingId: 'recording', captureKind: 'streamFrameCapture', startedAtMs: 1_000,
  status: 'recording', durationMs: 0, byteSize: 0, frameCount: 0, fps: 12,
  mimeType: 'video/webm', retentionClass: 'preSend', redactionLevel: 'metadataOnly',
  policyState: 'allowed', actionChapters: [], relatedReferences: [],
};

describe('recording encoder output ownership', () => {
  it.each(['drained', 'closed'] as const)('settles a backpressured stop when the pipe is %s', async outcome => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-encoder-drain-'));
    let releaseWrite: (() => void) | undefined;
    let outputPath = '';
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          if (!releaseWrite) releaseWrite = callback;
          else queueMicrotask(callback);
        },
        final(callback) { callback(); queueMicrotask(() => child.emit('close', 0, null)); },
      }),
      kill: () => true,
    });
    try {
      const factory = createFfmpegBrowserRecordingStreamFrameEncoderFactory({
        workingDirectory: directory, resolveFfmpegBinaryPath: async () => '/fixture/ffmpeg',
        spawnFfmpeg: (_binary, args) => {
          outputPath = args.at(-1)!;
          writeFileSync(outputPath, 'encoded recording');
          queueMicrotask(() => child.emit('spawn'));
          return child;
        },
      });
      const encoder = await factory({ recording, outputMimeType: 'video/webm' });
      encoder.appendFrame({ sequence: 1, timestampMs: 1_000, payloadKind: 'image_keyframe', payload: Buffer.from('frame') });
      const result = encoder.finish({ recording, frameCount: 1, durationMs: 160 });
      if (outcome === 'drained') {
        releaseWrite!();
        const artifact = await result;
        expect(artifact.byteSize).toBe(Buffer.byteLength('encoded recording'));
        expect(artifact.source.kind).toBe('local-file');
        await expect(readFile(outputPath, 'utf8')).resolves.toBe('encoded recording');
        await artifact.cleanup?.();
      } else {
        child.emit('close', 0, null);
        await expect(result).rejects.toMatchObject({ failureCause: { errorClass: 'Error', nativeErrorCode: 'exit_0' } });
      }
      await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      child.emit('close', 0, null);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('shares one capability read and refreshes it when the executable identity changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-encoder-capabilities-'));
    const binary = join(directory, 'managed-encoder');
    try {
      writeFileSync(binary, 'first identity');
      const before = probe.calls;
      const formats = await Promise.all([resolveRecordingOutputFormat(binary), resolveRecordingOutputFormat(binary)]);
      expect(formats.map(format => format.mimeType)).toEqual(['video/mp4', 'video/mp4']);
      expect(probe.calls - before).toBe(2);
      probe.encoders = ' V..... libvpx VP8 encoder\n';
      writeFileSync(binary, 'replacement executable identity');
      expect(await resolveRecordingOutputFormat(binary)).toMatchObject({ mimeType: 'video/webm', encoder: 'libvpx', container: 'webm' });
      expect(probe.calls - before).toBe(4);
    } finally {
      probe.encoders = ' V..... libx264 H.264 encoder\n';
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('falls back to truthful WebM when listed software H.264 cannot produce MP4', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-software-encoder-'));
    const binary = join(directory, 'encoder');
    try {
      writeFileSync(binary, 'software build with unavailable runtime dependency');
      probe.softwareUnavailable = true;
      probe.encoders = ' V..... libx264 H.264 encoder\n V..... libvpx VP8 encoder\n';
      expect(await resolveRecordingOutputFormat(binary)).toMatchObject({ mimeType: 'video/webm', encoder: 'libvpx', container: 'webm' });
    } finally {
      probe.softwareUnavailable = false;
      probe.encoders = ' V..... libx264 H.264 encoder\n';
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])('refuses recording when WebM is listed=%s but no encoder is usable', async listed => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-unavailable-encoder-'));
    const binary = join(directory, 'encoder');
    try {
      writeFileSync(binary, 'build without a usable encoder');
      probe.encoders = listed ? ' V..... libvpx VP8 encoder\n' : '';
      probe.webmUnavailable = true;
      const spawnFfmpeg = vi.fn();
      const factory = createFfmpegBrowserRecordingStreamFrameEncoderFactory({
        workingDirectory: directory, resolveFfmpegBinaryPath: async () => binary, spawnFfmpeg,
      });
      expect(await factory.resolveOutputMimeType?.()).toBeNull();
      await expect(factory({ recording, outputMimeType: 'video/webm' })).rejects.toMatchObject({ code: 'encoder_unavailable' });
      expect(spawnFfmpeg).not.toHaveBeenCalled();
    } finally {
      probe.webmUnavailable = false;
      probe.encoders = ' V..... libx264 H.264 encoder\n';
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps WebM when a listed hardware encoder cannot encode on this machine', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-hardware-encoder-'));
    const binary = join(directory, 'encoder');
    try {
      writeFileSync(binary, 'hardware build');
      probe.encoders = ' V..... h264_nvenc H.264 encoder\n V..... libvpx VP8 encoder\n';
      expect(await resolveRecordingOutputFormat(binary)).toMatchObject({ mimeType: 'video/webm', encoder: 'libvpx' });
    } finally {
      probe.encoders = ' V..... libx264 H.264 encoder\n';
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the executable encoder capability for MP4 and rejects abrupt partial output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-h264-'));
    const binary = join(directory, 'managed-encoder');
    writeFileSync(binary, 'executable identity');
    let outputPath = '';
    let args: readonly string[] = [];
    const child = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      kill: () => true,
    });
    try {
      const factory = createFfmpegBrowserRecordingStreamFrameEncoderFactory({
        workingDirectory: directory, resolveFfmpegBinaryPath: async () => binary,
        spawnFfmpeg: (_binary, invocation) => {
          args = invocation;
          outputPath = args.at(-1)!;
          writeFileSync(outputPath, 'partial');
          queueMicrotask(() => child.emit('spawn'));
          return child;
        },
      });
      const encoder = await factory({ recording, outputMimeType: 'video/webm' });
      expect(execFile).toHaveBeenCalledWith(binary, ['-hide_banner', '-encoders'], expect.anything(), expect.anything());
      expect(args).toContain('libx264');
      expect(args).toContain('mp4');
      expect(args).toContain('frag_keyframe+empty_moov+default_base_moof');
      expect(outputPath).toMatch(/\.mp4$/);
      encoder.appendFrame({ sequence: 1, timestampMs: 1_000, payloadKind: 'image_keyframe', payload: Buffer.from('frame') });
      child.stderr.write('Error while opening encoder: private /workspace/file token-value\n');
      child.emit('close', null, 'SIGKILL');
      await expect(encoder.finish({ recording, frameCount: 1, durationMs: 80 })).rejects.toMatchObject({
        failureCause: { phase: 'recording.encoder', nativeErrorCode: 'signal_sigkill', nativeErrorReason: 'encoder_initialization_failed' },
        outcome: { exitCode: null, signal: 'SIGKILL', stderrClass: 'encoder_initialization_failed', format: { encoder: 'libx264', container: 'mp4' } },
      });
      await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      child.emit('close', null, 'SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });

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
        stderr: new PassThrough(),
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
        const failure = Object.assign(new Error('encoder boundary failed'), { code: 'EPIPE' });
        if (outcome === 'error' || outcome === 'stdin-error') {
          encoder.appendFrame({ sequence: 1, timestampMs: 1_000,
            payloadKind: 'image_keyframe', payload: Buffer.from('frame') });
          (outcome === 'error' ? child : child.stdin).emit('error', failure);
        }
        const operation = outcome === 'discard'
          ? encoder.discard({ recording, reason: 'user_canceled' })
          : encoder.finish({ recording, frameCount: outcome === 'empty' ? 0 : 1, durationMs: 1_000 });
        if (outcome === 'empty') child.stderr.write('Invalid data found when processing input\n');
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
          ...(outcome === 'empty' ? { failureCause: expect.objectContaining({ nativeErrorReason: 'no_frames_captured' }) } : {}),
          ...((outcome === 'error' || outcome === 'stdin-error') ? { cause: failure, failureCause: expect.objectContaining({ errorCode: 'EPIPE' }) } : {}) });
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
