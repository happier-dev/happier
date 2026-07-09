import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { ModelPackManifest } from '@happier-dev/protocol';
import { installModelPackWithHost } from '@happier-dev/voice-modelpacks';

import { createExpoModelPackInstallerHost, reconcileExpoModelPackPromotion } from '@/voice/modelPacks/installer/host.native';
import { createMemFs } from '@/voice/modelPacks/installerTestFs';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

const PACK_DIR = 'file:///docs/happier/voice/modelPacks/resume';

function makeManifest(bytes: Uint8Array): ModelPackManifest {
  return {
    packId: 'resume',
    kind: 'tts_sherpa',
    model: 'kokoro',
    version: 'v1',
    files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sha256: sha256Hex(bytes), sizeBytes: bytes.length }],
  } as ModelPackManifest;
}

function streamResponse(bytes: Uint8Array, status: number): any {
  let idx = 0;
  return {
    ok: true,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (idx === 0) {
            idx = 1;
            return { done: false, value: bytes };
          }
          return { done: true, value: undefined };
        },
      }),
    },
  };
}

describe('Expo native host — real Range resume (FIND-010)', () => {
  it('resumes from a surviving scratch partial with an HTTP Range request', async () => {
    const { fs, files } = createMemFs();
    const full = new Uint8Array(Array.from({ length: 10 }, (_, i) => i + 1));

    // A prior interrupted attempt left a 4-byte partial in the STABLE scratch dir.
    files.set('file:///docs/happier/voice/modelPacks/.resume.scratch/model.bin', full.slice(0, 4));

    let observedRange: string | null = null;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      observedRange = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
      const start = observedRange ? Number(observedRange.replace('bytes=', '').replace('-', '')) : 0;
      return streamResponse(full.slice(start), 206);
    });

    const host = createExpoModelPackInstallerHost({ fs, fetchImpl: fetchImpl as any, timeoutMs: 5000 });
    await installModelPackWithHost({ host, packId: 'resume', manifest: makeManifest(full), signal: new AbortController().signal });

    expect(observedRange).toBe('bytes=4-');
    expect(Array.from(files.get(`${PACK_DIR}/model.bin`)!)).toEqual(Array.from(full));
  });

  it('appends chunks incrementally rather than rewriting the whole staged file (LB-L1)', async () => {
    const { fs, files } = createMemFs();
    const full = new Uint8Array(Array.from({ length: 6 }, (_, i) => i + 1));

    // Spy on File.write to assert append-mode writes (no full-buffer rewrites).
    const writeCalls: Array<{ append: boolean; length: number }> = [];
    const OriginalFile = fs.File;
    class TracingFile extends (OriginalFile as any) {
      write(data: string | Uint8Array, options?: { append?: boolean }) {
        if (typeof data !== 'string') {
          writeCalls.push({ append: Boolean(options?.append), length: data.byteLength });
        }
        return super.write(data, options);
      }
    }
    (fs as any).File = TracingFile;

    // Deliver the body in three separate chunks so multiple appends happen.
    const fetchImpl = vi.fn(async () => {
      const chunks = [full.slice(0, 2), full.slice(2, 4), full.slice(4, 6)];
      let i = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(full.length) : null) },
        body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) },
      } as any;
    });

    const host = createExpoModelPackInstallerHost({ fs, fetchImpl: fetchImpl as any, timeoutMs: 5000 });
    await installModelPackWithHost({ host, packId: 'resume', manifest: makeManifest(full), signal: new AbortController().signal });

    // Every binary write of a downloaded chunk must be an append, and each append
    // is chunk-sized (2 bytes) — never a growing full-file rewrite.
    const chunkAppends = writeCalls.filter((c) => c.append);
    expect(chunkAppends.length).toBeGreaterThanOrEqual(3);
    for (const call of chunkAppends) {
      expect(call.length).toBeLessThanOrEqual(2);
    }
    expect(Array.from(files.get(`${PACK_DIR}/model.bin`)!)).toEqual(Array.from(full));
  });

  it('streams existing partial bytes without reading the whole partial through File.bytes', async () => {
    const { fs, files } = createMemFs();
    const full = new Uint8Array(Array.from({ length: 10 }, (_, i) => i + 1));
    files.set('file:///docs/happier/voice/modelPacks/.resume.scratch/model.bin', full.slice(0, 4));

    const OriginalFile = fs.File;
    class TracingFile extends (OriginalFile as any) {
      get size() {
        return undefined;
      }
      async bytes() {
        if (this.uri.endsWith('/.resume.scratch/model.bin')) {
          throw new Error('partial_bytes_should_not_be_called');
        }
        return super.bytes();
      }
    }
    (fs as any).File = TracingFile;

    let observedRange: string | null = null;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      observedRange = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
      const start = observedRange ? Number(observedRange.replace('bytes=', '').replace('-', '')) : 0;
      return streamResponse(full.slice(start), 206);
    });

    const host = createExpoModelPackInstallerHost({ fs, fetchImpl: fetchImpl as any, timeoutMs: 5000 });
    await installModelPackWithHost({ host, packId: 'resume', manifest: makeManifest(full), signal: new AbortController().signal });

    expect(observedRange).toBe('bytes=4-');
    expect(Array.from(files.get(`${PACK_DIR}/model.bin`)!)).toEqual(Array.from(full));
  });
});

describe('reconcileExpoModelPackPromotion — crash-window recovery (X-M1)', () => {
  it('restores the backup to live when live is missing + backup + intent marker present', () => {
    const { fs, files } = createMemFs();
    const backupRoot = 'file:///docs/happier/voice/modelPacks/.crash.backup';
    files.set(`${backupRoot}/pack.json`, new TextEncoder().encode(JSON.stringify({ version: 'v1' })));
    files.set('file:///docs/happier/voice/modelPacks/.crash.promote-intent', new TextEncoder().encode('{}'));

    const restored = reconcileExpoModelPackPromotion({ fs, packId: 'crash' });
    expect(restored).toBe(true);

    const liveManifest = files.get('file:///docs/happier/voice/modelPacks/crash/pack.json');
    expect(liveManifest).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(liveManifest!)).version).toBe('v1');
    expect(files.has('file:///docs/happier/voice/modelPacks/.crash.promote-intent')).toBe(false);
    expect(files.has(`${backupRoot}/pack.json`)).toBe(false);
  });

  it('drops a stale backup + intent when live already exists', () => {
    const { fs, files } = createMemFs();
    files.set('file:///docs/happier/voice/modelPacks/done/pack.json', new TextEncoder().encode(JSON.stringify({ version: 'v2' })));
    files.set('file:///docs/happier/voice/modelPacks/.done.backup/pack.json', new TextEncoder().encode('{}'));
    files.set('file:///docs/happier/voice/modelPacks/.done.promote-intent', new TextEncoder().encode('{}'));

    const restored = reconcileExpoModelPackPromotion({ fs, packId: 'done' });
    expect(restored).toBe(false);
    expect(files.has('file:///docs/happier/voice/modelPacks/done/pack.json')).toBe(true);
    expect(files.has('file:///docs/happier/voice/modelPacks/.done.backup/pack.json')).toBe(false);
    expect(files.has('file:///docs/happier/voice/modelPacks/.done.promote-intent')).toBe(false);
  });

  it('drops a stale backup even when the intent marker is already gone', () => {
    const { fs, files } = createMemFs();
    files.set('file:///docs/happier/voice/modelPacks/done/pack.json', new TextEncoder().encode(JSON.stringify({ version: 'v2' })));
    files.set('file:///docs/happier/voice/modelPacks/.done.backup/pack.json', new TextEncoder().encode('{}'));

    const restored = reconcileExpoModelPackPromotion({ fs, packId: 'done' });
    expect(restored).toBe(false);
    expect(files.has('file:///docs/happier/voice/modelPacks/done/pack.json')).toBe(true);
    expect(files.has('file:///docs/happier/voice/modelPacks/.done.backup/pack.json')).toBe(false);
  });

  it('is a no-op when no intent marker is present', () => {
    const { fs } = createMemFs();
    expect(reconcileExpoModelPackPromotion({ fs, packId: 'missing' })).toBe(false);
  });
});

describe('Expo native host promote rollback intent safety', () => {
  it('keeps the promote intent when rollback restore fails after live was moved to backup', async () => {
    const { fs, files } = createMemFs();
    const packId = 'resume';
    const full = new Uint8Array([5, 6, 7, 8]);
    const liveRoot = 'file:///docs/happier/voice/modelPacks/resume';
    const scratchRoot = 'file:///docs/happier/voice/modelPacks/.resume.scratch';
    const backupRoot = 'file:///docs/happier/voice/modelPacks/.resume.backup';
    const intentUri = 'file:///docs/happier/voice/modelPacks/.resume.promote-intent';

    files.set(`${liveRoot}/pack.json`, new TextEncoder().encode(JSON.stringify({ version: 'v1' })));
    files.set(`${liveRoot}/model.bin`, new Uint8Array([1, 2, 3, 4]));

    const OriginalDirectory = fs.Directory;
    class FailingDirectory extends (OriginalDirectory as any) {
      move(destination: { uri: string }) {
        if (this.uri === scratchRoot && destination.uri === liveRoot) {
          throw new Error('promote_failed_after_backup');
        }
        if (this.uri === backupRoot && destination.uri === liveRoot) {
          throw new Error('restore_failed');
        }
        return super.move(destination);
      }
    }
    (fs as any).Directory = FailingDirectory;

    const host = createExpoModelPackInstallerHost({
      fs,
      fetchImpl: (async () => streamResponse(full, 200)) as any,
      timeoutMs: 5000,
    });

    await expect(
      installModelPackWithHost({
        host,
        packId,
        manifest: makeManifest(full),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('promote_failed_after_backup');

    expect(files.has(intentUri)).toBe(true);
    expect(files.has(`${backupRoot}/pack.json`)).toBe(true);
    expect(files.has(`${liveRoot}/pack.json`)).toBe(false);
  });
});
