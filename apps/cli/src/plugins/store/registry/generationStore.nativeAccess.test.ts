import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, vi } from 'vitest';

import { ensurePluginStoreDirectories } from '../paths';
import { createImmutablePluginGenerationRecordFromSource, prepareImmutablePluginGeneration } from './generationStore';

// Native UID and filesystem permissions are the system boundary under test.
it.skipIf(process.platform !== 'linux')('lets a member UID load installed SCM code while custodian plugin state stays private', async () => {
  // The executor's TMPDIR can itself be beneath its private home. This native
  // Linux test needs an OS-accessible parent for the separate installation.
  const root = await mkdtemp('/tmp/happier-plugin-native-code-');
  const custodianHome = join(root, 'custodian');
  const home = join(custodianHome, '.happier');
  const source = join(root, 'source');
  vi.stubEnv('HOME', custodianHome);
  vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', join(root, 'managed-payload'));
  const run = promisify(execFile);
  try {
    await chmod(root, 0o711);
    await mkdir(custodianHome, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    await writeFile(join(custodianHome, '.npmrc'), 'custodian-registry-config', { mode: 0o644 });
    await mkdir(join(custodianHome, 'unrelated-project'), { mode: 0o755 });
    await writeFile(join(custodianHome, 'unrelated-project', '.env'), 'custodian-project-config', { mode: 0o644 });
    await mkdir(join(home, 'custodian-config'), { mode: 0o700 });
    await writeFile(join(home, 'custodian-config', 'custodian-private'), 'private', { mode: 0o644 });
    await writeFile(join(home, 'custodian-private'), 'private', { mode: 0o644 });
    await mkdir(source, { mode: 0o700 });
    await mkdir(join(source, '.happier-plugin'));
    await mkdir(join(source, 'bin'));
    await writeFile(join(source, '.happier-plugin/plugin.json'), '{"id":"acme.native-scm"}', { mode: 0o600 });
    await writeFile(join(source, 'scm.mjs'), 'export const checkout = () => "installed-scm";\n', { mode: 0o600 });
    await writeFile(join(source, 'bin/tool'), '#!/bin/sh\nprintf installed-tool', { mode: 0o700 });
    const paths = await ensurePluginStoreDirectories({ happyHomeDir: home });
    const privatePaths = [custodianHome, home, join(home, 'plugins'), paths.rootDir, join(home, 'custodian-config'), paths.stateDir, paths.secretsDir,
      paths.storageDir, paths.settingsDir, paths.logsDir, paths.cacheDir, paths.locksDir,
      paths.installedDir, paths.stateRevisionsDir];
    for (const path of privatePaths) await writeFile(join(path, 'custodian-private'), 'private', { mode: 0o644 });
    const record = await createImmutablePluginGenerationRecordFromSource({ pluginId: 'acme.native-scm',
      sourceRootPath: source, manifestRelativePath: '.happier-plugin/plugin.json',
      distribution: { kind: 'localPath', canonicalPath: source }, updatePolicy: 'allowed', createdAtMs: 1 });
    const installed = await prepareImmutablePluginGeneration({ paths, sourceRootPath: source, record });
    // The installed code must be reachable without granting traversal into
    // the custodian home, including for otherwise world-readable files.
    // A subsequent registry read must preserve code access and private state.
    await ensurePluginStoreDirectories({ happyHomeDir: home });
    const script = `
      const fs = require('node:fs/promises');
      const { constants } = require('node:fs');
      const { execFileSync } = require('node:child_process');
      const { join, dirname } = require('node:path');
      const { pathToFileURL } = require('node:url');
      (async () => {
        const [group, entry, custodianHome, ...privatePaths] = process.argv.slice(1);
        process.setgroups([]);
        process.setgid(Number(group));
        process.setuid(65534);
        const privateUnreadable = await Promise.all(privatePaths.map(async path => {
          try { await fs.readdir(path); return false; } catch (e) { if (e.code !== 'EACCES') return false; }
          try { await fs.readFile(join(path, 'custodian-private')); return false; } catch (e) { return e.code === 'EACCES'; }
        }));
        const homeFilesUnreadable = await Promise.all(['.npmrc', 'unrelated-project/.env'].map(async path => {
          try { await fs.readFile(join(custodianHome, path)); return false; } catch (e) { return e.code === 'EACCES'; }
        }));
        let checkout = null, codeFailure = null, tool = null, codeWritable = false;
        try {
          checkout = (await import(pathToFileURL(entry).href)).checkout();
          tool = execFileSync(join(dirname(entry), 'bin/tool'), { encoding: 'utf8' });
          try { await fs.access(entry, constants.W_OK); codeWritable = true; } catch {}
        }
        catch (e) { codeFailure = e.code; }
        console.log(JSON.stringify({ uid: process.getuid(), checkout, tool, codeWritable, codeFailure, privateUnreadable, homeFilesUnreadable }));
      })().catch(e => { console.error(e.code); process.exitCode = 1; });
    `;
    const { stdout } = await run('sudo', ['-n', '--', '/usr/bin/node', '-e', script,
      String(process.getgid?.()), join(installed.rootPath, 'scm.mjs'), custodianHome, ...privatePaths]);
    const result: unknown = JSON.parse(stdout);
    expect(result).toMatchObject({ checkout: 'installed-scm', tool: 'installed-tool', codeWritable: false, codeFailure: null,
      privateUnreadable: privatePaths.map(() => true), homeFilesUnreadable: [true, true] });
    expect(result).not.toMatchObject({ uid: process.getuid?.() });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
