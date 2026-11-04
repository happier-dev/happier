import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pruneRetainedVersions } from './pruneRetainedVersions.js';

describe('installed payload retention', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.skipIf(process.platform === 'win32').each(['support.so', ''])('takes one native census per prune while protecting scripts and open payload paths: %s', async (openRelativePath) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-version-census-'));
    const versions = join(home, 'cli', 'versions');
    const ids = ['6.0.0', '5.0.0', '4.0.0', '3.0.0', '2.0.0', '1.0.0'];
    try {
      const tools = join(home, 'tools');
      const censusLog = join(home, 'census.log');
      await mkdir(tools);
      // Native commands are the OS boundary; the shell, policy and removals stay real.
      await writeFile(join(tools, 'ps'), '#!/bin/sh\nprintf "ps\\n" >> "$census_log"\nprintf "%s\\n" "external-node $script_path"\n', { mode: 0o755 });
      await writeFile(join(tools, 'lsof'), '#!/bin/sh\nprintf "lsof\\n" >> "$census_log"\nprintf "p1234\\nn%s\\n" "$open_path"\n', { mode: 0o755 });
      vi.stubEnv('PATH', tools);
      vi.stubEnv('census_log', censusLog);
      vi.stubEnv('script_path', join(versions, '1.0.0', 'entry.mjs'));
      vi.stubEnv('open_path', join(versions, '2.0.0', openRelativePath));
      for (const id of ids) await mkdir(join(versions, id), { recursive: true });
      await writeFile(join(versions, '1.0.0', 'entry.mjs'), 'export {};');
      if (openRelativePath) await writeFile(join(versions, '2.0.0', openRelativePath), 'support');
      const warnings: string[] = [];
      const result = await pruneRetainedVersions({
        componentId: 'happier-cli', processEnv: { ...process.env, HAPPIER_FIRST_PARTY_INSTALL_HOME: home },
        orderedVersionIdsNewestFirst: ids, currentVersionId: '6.0.0', previousVersionId: '5.0.0',
        onWarning: message => { warnings.push(message); },
      });
      expect((await readFile(censusLog, 'utf8')).trim().split('\n')).toEqual(['ps', 'lsof']);
      expect(result).toEqual({ keptVersionIds: ['6.0.0', '5.0.0'], prunedVersionIds: ['4.0.0', '3.0.0'], skippedVersionIds: ['2.0.0', '1.0.0'] });
      expect((await readdir(versions)).sort()).toEqual(['1.0.0', '2.0.0', '5.0.0', '6.0.0']);
      expect(warnings).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32').each([
    { status: 0, output: 'p1234\nn/tmp/open\nlsof: permission denied' },
    { status: 1, output: 'lsof: permission denied' },
    { status: 2, output: '' },
    { status: 127, output: '' },
    { status: 1, output: '', psStatus: 1 },
  ])('retains a payload when native use observation is live or inconclusive: $status/$output', async ({ status, output, psStatus = 0 }) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-version-use-'));
    const versions = join(home, 'cli', 'versions');
    try {
      const tools = join(home, 'tools');
      await mkdir(tools);
      // lsof is the genuine OS boundary; retain real retention and filesystem effects.
      await writeFile(join(tools, 'lsof'), `#!/bin/sh\nprintf '%s' '${output}'\nexit ${status}\n`, { mode: 0o755 });
      await writeFile(join(tools, 'ps'), `#!/bin/sh\nprintf fixture-process\nexit ${psStatus}\n`, { mode: 0o755 });
      vi.stubEnv('PATH', tools);
      for (const id of ['1.0.0', '2.0.0', '3.0.0']) await mkdir(join(versions, id), { recursive: true });
      const result = await pruneRetainedVersions({
        componentId: 'happier-cli', processEnv: { ...process.env, HAPPIER_FIRST_PARTY_INSTALL_HOME: home },
        orderedVersionIdsNewestFirst: ['3.0.0', '2.0.0', '1.0.0'], currentVersionId: '3.0.0', previousVersionId: '2.0.0',
      });
      expect(result.skippedVersionIds).toEqual(['1.0.0']);
      expect((await readdir(versions)).sort()).toEqual(['1.0.0', '2.0.0', '3.0.0']);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === 'win32')('retains a loaded script until its process exits even when Node is outside the payload', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-live-version-'));
    const versions = join(home, 'cli', 'versions');
    const processEnv = { ...process.env, HAPPIER_FIRST_PARTY_INSTALL_HOME: home };
    const ids = ['1.0.0', '2.0.0', '3.0.0', '4.0.0'];
    try {
      const tools = join(home, 'tools');
      await mkdir(tools);
      // This case proves real PID/argv protection after Node closes its script.
      // Keep lsof's unrelated mount permissions outside that process-lifetime test.
      await writeFile(join(tools, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      vi.stubEnv('PATH', `${tools}:${process.env.PATH}`);
      for (const id of ids) {
        await mkdir(join(versions, id), { recursive: true });
        await writeFile(join(versions, id, 'runtime'), id);
      }
      const script = join(versions, '1.0.0', 'entry.mjs');
      await writeFile(script, 'process.send("ready"); setInterval(() => {}, 1000);');
      const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const exited = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
      try {
        await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); });
        expect(child.pid).toBeGreaterThan(0);
        const result = await pruneRetainedVersions({
          componentId: 'happier-cli', processEnv, orderedVersionIdsNewestFirst: [...ids].reverse(),
          currentVersionId: '4.0.0', previousVersionId: '3.0.0',
        });
        expect(result.prunedVersionIds).toEqual(['2.0.0']);
        expect(result.skippedVersionIds).toEqual(['1.0.0']);
        expect((await readdir(versions)).sort()).toEqual(['1.0.0', '3.0.0', '4.0.0']);
      } finally { child.kill(); await exited; }
      await pruneRetainedVersions({
        componentId: 'happier-cli', processEnv, orderedVersionIdsNewestFirst: ['4.0.0', '3.0.0', '1.0.0'],
        currentVersionId: '4.0.0', previousVersionId: '3.0.0',
      });
      expect((await readdir(versions)).sort()).toEqual(['3.0.0', '4.0.0']);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
