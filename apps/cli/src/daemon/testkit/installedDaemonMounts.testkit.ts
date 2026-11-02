import filesystemDefaults, * as filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { vi } from 'vitest';
import * as processBoundary from '@happier-dev/cli-common/process';
import { createLinuxVitalsFixture } from '@/daemon/vitals/readers/linux.testkit';
import { NativeVitalsSampleSchema } from '@/daemon/vitals/readers/nativeSample';

/** The installed daemon's physical mount inventory, not a Storage policy override. */
export async function createInstalledDaemonMountInventory(homeDirectory: string, platform: NodeJS.Platform = process.platform) {
  if (platform === 'darwin' || platform === 'win32') {
    const execute = processBoundary.execFileWithDeadline;
    const native = vi.spyOn(processBoundary, 'execFileWithDeadline').mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (args[1][0] !== 'vitals-sample') return result;
      let output: unknown;
      try { output = JSON.parse(String(result.stdout)); } catch { return result; }
      const parsed = NativeVitalsSampleSchema.safeParse(output);
      if (!parsed.success) return result;
      const stats = await filesystem.statfs(homeDirectory);
      return { ...result, stdout: JSON.stringify({ ...parsed.data, sample: { ...parsed.data.sample,
        volumes: [{ id: 'fixture-home', label: homeDirectory, mount: homeDirectory,
          totalBytes: stats.blocks * stats.bsize, availableBytes: stats.bavail * stats.bsize,
          inodesExhausted: stats.files > 0 && stats.ffree === 0 }],
      } }) };
    });
    return { dispose: async () => { native.mockRestore(); } };
  }
  if (platform !== 'linux') throw new Error(`Unsupported installed daemon mount fixture platform: ${platform}`);
  const fixture = await createLinuxVitalsFixture();
  try {
    const mount = homeDirectory.replaceAll('\\', '\\134').replaceAll(' ', '\\040').replaceAll('\t', '\\011').replaceAll('\n', '\\012');
    await fixture.put('/proc/self/mountinfo', `1 0 8:1 / ${mount} rw - ext4 /dev/sda rw\n`);
    const readContents = filesystem.readFile;
    // Source integration retains Node's immutable ESM namespace; unit/OS
    // boundary compositions expose a configurable Vitest namespace instead.
    const nativeBuiltin = Object.getOwnPropertyDescriptor(filesystem, 'readFile')?.configurable === false;
    const read = vi.spyOn(nativeBuiltin ? filesystemDefaults : filesystem, 'readFile').mockImplementation((...args) => {
      const [path, options] = args;
      return readContents(path === '/proc/self/mountinfo' ? join(fixture.root, 'proc', 'self', 'mountinfo') : path, options);
    });
    if (nativeBuiltin) syncBuiltinESMExports();
    return { dispose: async () => {
      try { read.mockRestore(); if (nativeBuiltin) syncBuiltinESMExports(); } finally { await fixture.cleanup(); }
    } };
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}
