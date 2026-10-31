import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ candidate: null as string | null }));
// Only package resolution is replaced; execution, permissions and file lifecycle stay real.
vi.mock('node:module', async importOriginal => {
  const original = await importOriginal<typeof import('node:module')>();
  return { ...original, createRequire: (url: string | URL) => {
    const require = original.createRequire(url);
    return Object.assign((id: string) => id === 'ffmpeg-static' ? boundary.candidate : require(id), require);
  } };
});

import { resolveFfmpegStaticBinaryPath } from './ffmpegStatic';

afterEach(() => { boundary.candidate = null; });

// The executable fixtures use POSIX scripts; native Windows execution is a separate platform check.
describe.skipIf(process.platform === 'win32')('packaged ffmpeg resolution', () => {
  it('checks current execution on each demand and rejects empty-success output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-ffmpeg-probe-'));
    try {
      const binary = join(directory, 'ffmpeg');
      // Readiness can change without the executable changing (for example its runtime
      // dependencies). A marker keeps that boundary real without touching dependencies.
      await writeFile(binary, '#!/bin/sh\nif [ -f "$0.ready" ]; then printf "ffmpeg version fixture\\n"; fi\n', { mode: 0o700 });
      boundary.candidate = binary;
      expect(await resolveFfmpegStaticBinaryPath()).toBeNull();
      await writeFile(`${binary}.ready`, 'ready');
      expect(await Promise.all([resolveFfmpegStaticBinaryPath(), resolveFfmpegStaticBinaryPath()])).toEqual([binary, binary]);
      expect(await resolveFfmpegStaticBinaryPath()).toBe(binary);
      await rm(`${binary}.ready`);
      expect(await resolveFfmpegStaticBinaryPath()).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('observes a missing package member becoming available and its subsequent removal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-ffmpeg-availability-'));
    try {
      const binary = join(directory, 'ffmpeg');
      boundary.candidate = binary;
      expect(await resolveFfmpegStaticBinaryPath()).toBeNull();
      await writeFile(binary, '#!/bin/sh\nprintf "ffmpeg version fixture\\n"\n', { mode: 0o700 });
      expect(await resolveFfmpegStaticBinaryPath()).toBe(binary);
      await rm(binary);
      expect(await resolveFfmpegStaticBinaryPath()).toBeNull();
      boundary.candidate = directory;
      expect(await resolveFfmpegStaticBinaryPath()).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects a non-executable package member and observes an owner repair without a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-ffmpeg-resolution-'));
    try {
      const binary = join(directory, 'ffmpeg');
      await writeFile(binary, '#!/bin/sh\nprintf "ffmpeg version fixture\\n"\n', { mode: 0o600 });
      boundary.candidate = binary;
      expect(await resolveFfmpegStaticBinaryPath()).toBeNull();
      await chmod(binary, 0o700);
      expect(await resolveFfmpegStaticBinaryPath()).toBe(binary);
      await chmod(binary, 0o600);
      expect(await resolveFfmpegStaticBinaryPath()).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
