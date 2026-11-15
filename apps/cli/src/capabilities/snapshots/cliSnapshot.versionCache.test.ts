import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile, utimes, rename, symlink, unlink } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';

import { createProbeTempDir, writeExecutableScript } from '@/capabilities/probes/agentModelsProbe.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { detectCliSnapshotOnDaemonPath as detect, invalidateCliSnapshots as invalidate } from './cliSnapshot';

const processBoundary = vi.hoisted(() => ({ calls: 0, version: '1.2.3', wait: Promise.resolve(), beforeProbe: null as (() => Promise<void>) | null }));

// Only the OS process adapter is replaced; catalog, resolution and filesystem stay real.
vi.mock('@happier-dev/cli-common/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (file: string) => {
    if (file.includes('opencode')) {
      processBoundary.calls++;
      await processBoundary.beforeProbe?.();
    }
    const version = processBoundary.version;
    await processBoundary.wait;
    return { stdout: version ? `opencode ${version}\n` : 'no version\n', stderr: '' };
  } };
});

afterEach(() => { vi.useRealTimers(); });

async function withNativeCli(run: (context: {
  binary: string;
  detect: typeof import('./cliSnapshot')['detectCliSnapshotOnDaemonPath'];
  invalidate: typeof import('./cliSnapshot')['invalidateCliSnapshots'];
}) => Promise<void>, header = '\x7fELFtest-native-fixture') {
  processBoundary.calls = 0;
  processBoundary.version = '1.2.3';
  processBoundary.wait = Promise.resolve();
  processBoundary.beforeProbe = null;
  const fixture = await createProbeTempDir('happier-version-cache');
  const env = createEnvKeyScope(['HOME', 'USERPROFILE', 'PATH', 'HAPPIER_OPENCODE_PATH']);
  try {
    const bin = join(fixture.dir, '.opencode', 'bin');
    await mkdir(bin, { recursive: true });
    const binary = join(bin, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    await writeExecutableScript(binary, 'fixture');
    await writeFile(binary, Buffer.from(header, 'latin1'));
    env.patch({ HOME: fixture.dir, USERPROFILE: fixture.dir, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` });
    delete process.env.HAPPIER_OPENCODE_PATH;
    invalidate();
    await run({ binary, detect, invalidate });
  } finally { invalidate(); env.restore(); await fixture.cleanup(); }
}

const request = { requestedCliNames: ['opencode'] as const, requestedTools: [] };

describe('CLI version reuse', () => {
  it.each(['\x7fELFtest-native-fixture', 'MZtest-native-fixture', '\xfe\xed\xfa\xcftest-native-fixture'])(
    'reuses native versions after snapshot expiry and refreshes changed binaries (%s)', async (header) => {
    await withNativeCli(async ({ binary, detect, invalidate }) => {
      expect((await detect(request)).clis.opencode.version).toBe('1.2.3');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 31_000);
      expect((await detect(request)).clis.opencode.version).toBe('1.2.3');
      expect(processBoundary.calls).toBe(1);
      processBoundary.version = '2.0.0';
      const later = new Date(Date.now() + 60_000);
      await utimes(binary, later, later);
      vi.setSystemTime(Date.now() + 31_000);
      expect((await detect(request)).clis.opencode.version).toBe('2.0.0');
      expect(processBoundary.calls).toBe(2);
      invalidate();
      await detect(request);
      expect(processBoundary.calls).toBe(3);
    }, header);
  });

  it('explicit refresh and verification probe even an unchanged native executable', async () => {
    await withNativeCli(async ({ detect }) => {
      await detect(request);
      processBoundary.version = '2.0.0';
      expect((await detect({ ...request, bypassCache: true })).clis.opencode.version).toBe('2.0.0');
      processBoundary.version = '3.0.0';
      expect((await detect({ ...request, verifyVersion: true })).clis.opencode.version).toBe('3.0.0');
      expect(processBoundary.calls).toBe(3);
    });
  });

  it('shares ordinary concurrent probes across distinct snapshot keys', async () => {
    await withNativeCli(async ({ detect }) => {
      const snapshots = await Promise.all([detect(request), detect({ requestedCliNames: ['opencode', 'codex'] })]);
      expect(snapshots.map(s => s.clis.opencode.version)).toEqual(['1.2.3', '1.2.3']);
      expect(processBoundary.calls).toBe(1);
    });
  });

  it('does not admit a version if an update retargets the executable during its probe', async () => {
    await withNativeCli(async ({ binary, detect }) => {
      const bin = dirname(binary);
      const targetA = join(dirname(bin), 'version-a');
      const targetB = join(dirname(bin), 'version-b');
      await rename(bin, targetA);
      await mkdir(targetB);
      await writeExecutableScript(join(targetB, basename(binary)), '\x7fELFnative-version-b');
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      await symlink(targetA, bin, linkType);
      processBoundary.beforeProbe = async () => {
        processBoundary.beforeProbe = null;
        await unlink(bin);
        await symlink(targetB, bin, linkType);
        processBoundary.version = '2.0.0';
      };
      expect((await detect(request)).clis.opencode.version).toBe('2.0.0');
      await unlink(bin);
      await symlink(targetA, bin, linkType);
      processBoundary.version = '1.2.3';
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 31_000);
      expect((await detect(request)).clis.opencode.version).toBe('1.2.3');
      expect(processBoundary.calls).toBe(2);
    });
  });

  it('re-probes an unclassified native executable override only when it changes', async () => {
    await withNativeCli(async ({ binary, detect }) => {
      process.env.HAPPIER_OPENCODE_PATH = binary;
      expect((await detect(request)).clis.opencode.version).toBe('1.2.3');
      processBoundary.version = '2.0.0';
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 31_000);
      expect((await detect(request)).clis.opencode.version).toBe('1.2.3');
      expect(processBoundary.calls).toBe(1);
      const later = new Date(Date.now() + 60_000);
      await utimes(binary, later, later);
      expect((await detect(request)).clis.opencode.version).toBe('2.0.0');
      expect(processBoundary.calls).toBe(2);
    });
  });

  it('keeps concurrent opaque launcher probes separate when their environment changes', async () => {
    await withNativeCli(async ({ binary, detect }) => {
      await writeFile(binary, '#!/bin/sh\nexec other-provider "$@"\n');
      process.env.HAPPIER_OPENCODE_PATH = binary;
      let release!: () => void;
      processBoundary.wait = new Promise<void>(resolve => { release = resolve; });
      const older = detect(request);
      await vi.waitFor(() => expect(processBoundary.calls).toBe(1));
      processBoundary.wait = Promise.resolve();
      processBoundary.version = '2.0.0';
      process.env.HOME = join(process.env.HOME!, 'different-home');
      process.env.USERPROFILE = process.env.HOME;
      const newer = detect(request);
      try {
        await vi.waitFor(() => expect(processBoundary.calls).toBe(2));
        expect((await newer).clis.opencode.version).toBe('2.0.0');
      } finally { release(); await Promise.all([older, newer]); }
    });
  });

  it('fresh recovery supersedes an in-flight ordinary snapshot', async () => {
    await withNativeCli(async ({ detect }) => {
      let release!: () => void;
      processBoundary.wait = new Promise<void>(resolve => { release = resolve; });
      const older = detect(request);
      await vi.waitFor(() => expect(processBoundary.calls).toBe(1));
      processBoundary.wait = Promise.resolve();
      processBoundary.version = '2.0.0';
      try {
        expect((await detect({ ...request, bypassCache: true })).clis.opencode.version).toBe('2.0.0');
      } finally { release(); await older; }
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 31_000);
      expect((await detect(request)).clis.opencode.version).toBe('2.0.0');
    });
  });

  it('invalidation prevents pending observations from repopulating the cache', async () => {
    await withNativeCli(async ({ detect, invalidate }) => {
      let release!: () => void;
      processBoundary.wait = new Promise<void>(resolve => { release = resolve; });
      const older = detect(request);
      await vi.waitFor(() => expect(processBoundary.calls).toBe(1));
      invalidate();
      release();
      await older;
      processBoundary.wait = Promise.resolve();
      processBoundary.version = '2.0.0';
      expect((await detect(request)).clis.opencode.version).toBe('2.0.0');
    });
  });

  it.each([true, false, 'mixed'] as const)('does not persist a version banner from a failed native process (failure=%s)', async interrupted => {
    await withNativeCli(async ({ binary, detect }) => {
      processBoundary.beforeProbe = async () => {
        if (interrupted === 'mixed') {
          // Later argument variants execute successfully without a version;
          // their install fact cannot certify this failed command's banner.
          processBoundary.beforeProbe = null;
          processBoundary.version = '';
        }
        throw Object.assign(new Error('Version process failed'), {
          stdout: 'opencode 1.2.3\n', stderr: '', ...(interrupted ? { killed: true } : { code: 1 }),
        });
      };
      // Existing inventory keeps best-effort banners, but a failed process must
      // not turn that optional metadata into a persistent native executable fact.
      expect((await detect(request)).clis.opencode.version).toBe('1.2.3');
      processBoundary.beforeProbe = null;
      processBoundary.version = '2.0.0';
      const calls = processBoundary.calls;
      // The banner is not held; the remembered failure waits for a changed executable.
      expect((await detect(request)).clis.opencode.version).toBeUndefined();
      expect(processBoundary.calls).toBe(calls);
      const later = new Date(Date.now() + 60_000);
      await utimes(binary, later, later);
      expect((await detect(request)).clis.opencode.version).toBe('2.0.0');
    });
  });

  it('remembers an unanswered version probe until the executable changes', async () => {
    await withNativeCli(async ({ binary, detect }) => {
      processBoundary.version = '';
      expect((await detect(request)).clis.opencode.version).toBeUndefined();
      const oneProbe = processBoundary.calls;
      vi.useFakeTimers({ toFake: ['Date'] });
      for (let open = 0; open < 3; open++) {
        vi.setSystemTime(Date.now() + 31_000);
        expect((await detect(request)).clis.opencode.version).toBeUndefined();
      }
      expect(processBoundary.calls).toBe(oneProbe);
      // An update fixes the CLI: the changed executable is probed exactly once more.
      processBoundary.version = '2.0.0';
      const later = new Date(Date.now() + 60_000);
      await utimes(binary, later, later);
      expect((await detect(request)).clis.opencode.version).toBe('2.0.0');
      expect((await detect(request)).clis.opencode.version).toBe('2.0.0');
      expect(processBoundary.calls).toBe(oneProbe + 1);
    });
  });

  it('does not retain the old version after an unsuccessful explicit refresh', async () => {
    await withNativeCli(async ({ detect }) => {
      await detect(request);
      processBoundary.version = '';
      expect((await detect({ ...request, bypassCache: true })).clis.opencode.version).toBeUndefined();
      expect((await detect(request)).clis.opencode.version).toBeUndefined();
      processBoundary.version = '2.0.0';
      expect((await detect({ ...request, bypassCache: true })).clis.opencode.version).toBe('2.0.0');
      expect((await detect(request)).clis.opencode.version).toBe('2.0.0');
    });
  });

  it.each([
    ['#!/bin/sh\nexec other-provider "$@"\n', 'other-provider'],
    ['@echo off\r\nother-provider %*\r\n', null],
    ["require('./provider.cjs');\n", 'provider.cjs'],
  ] as const)('keys a script launcher on itself and its target: unchanged reuses, changed re-probes once (%s)', async (launcher, target) => {
      await withNativeCli(async ({ binary, detect }) => {
        const targetPath = target ? join(dirname(binary), target) : null;
        if (targetPath) await writeExecutableScript(targetPath, 'target-v1');
        await writeFile(binary, launcher);
        expect((await detect(request)).clis.opencode.version).toBe('1.2.3');
        processBoundary.version = '2.0.0';
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 31_000);
        // An unchanged launcher and target cost stat calls, not a process.
        expect((await detect(request)).clis.opencode.version).toBe('1.2.3');
        expect(processBoundary.calls).toBe(1);
        const later = new Date(Date.now() + 60_000);
        // An update rewrites the target (npm i -g, vendor update) or else the launcher itself.
        await utimes(targetPath ?? binary, later, later);
        expect((await detect(request)).clis.opencode.version).toBe('2.0.0');
        expect((await detect(request)).clis.opencode.version).toBe('2.0.0');
        expect(processBoundary.calls).toBe(2);
      });
    },
  );
});
