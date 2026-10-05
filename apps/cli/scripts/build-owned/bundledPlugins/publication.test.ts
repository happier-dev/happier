import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { withWorkspaceBundleLock, type WorkspaceBundleLockContext } from '../../../../../packages/cli-common/workspaceBundleLock.mjs';
import { createWorkspaceChildBuildEnv } from '../../../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { publishCoherentProjectionOutputs } from './outputs.ts';
import { withGeneratorSingleFlight, withPreparedGeneratorPublication } from './publication.ts';
import { ensureWorkspacePackagesBuiltByName, readWorkspacePackageInputFingerprint } from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

describe('bundled generator single-flight', () => {
  it('publishes the prepared input fingerprint without repeating preparation after outputs advance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-single-flight-prepared-inputs-'));
    const dependency = join(root, 'dependency');
    const stampPath = join(root, 'readiness.json');
    writeFileSync(dependency, 'previous-built-input');
    let preparations = 0;
    try {
      await withGeneratorSingleFlight({
        readFingerprint: () => readFileSync(dependency, 'utf8'),
        prepare: async () => { preparations++; writeFileSync(dependency, 'actual-built-input'); },
        run: async (lease) => {
          lease.assertOwned();
          writeFileSync(join(root, 'published'), readFileSync(dependency, 'utf8'));
        },
        stampPath,
        lockOptions: { lockPath: join(root, 'publication.lock') },
      });
      expect(readFileSync(join(root, 'published'), 'utf8')).toBe('actual-built-input');
      expect(JSON.parse(readFileSync(stampPath, 'utf8')).publication.fingerprint).toBe('actual-built-input');
      expect(preparations).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['prepare', 'publication'] as const)('converges a failed %s child after its consumed inputs change', async (phase) => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-single-flight-convergence-'));
    writeFileSync(join(root, 'source'), 'first');
    const childSource = `
      import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
      const [root] = process.argv.slice(1);
      const input = readFileSync(root + '/source', 'utf8');
      appendFileSync(root + '/attempts', input + '\\n');
      if (input === 'first') {
        writeFileSync(root + '/source', 'settled');
        throw new Error('prepared graph no longer matches its inputs');
      }
      writeFileSync(root + '/output', input);
    `;
    const runChild = async () => {
      await promisify(execFile)(process.execPath, ['--input-type=module', '-e', childSource, root]);
    };
    try {
      await withGeneratorSingleFlight({
        readFingerprint: () => readFileSync(join(root, 'source'), 'utf8'),
        stampPath: join(root, 'readiness.json'),
        lockOptions: { lockPath: join(root, 'publication.lock') },
        ...(phase === 'prepare' ? { prepare: runChild } : {}),
        run: async (lease) => { lease.assertOwned(); if (phase === 'publication') await runChild(); },
      });
      expect(readFileSync(join(root, 'attempts'), 'utf8').trim().split('\n')).toEqual(['first', 'settled']);
      expect(readFileSync(join(root, 'output'), 'utf8')).toBe('settled');
      expect(JSON.parse(readFileSync(join(root, 'readiness.json'), 'utf8')).publication.error).toBeNull();
      expect(existsSync(join(root, 'publication.lock'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not retry a dependency failure when consumed inputs stayed unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-single-flight-stable-failure-'));
    let attempts = 0;
    try {
      await expect(withGeneratorSingleFlight({
        readFingerprint: () => 'unchanged',
        stampPath: join(root, 'readiness.json'),
        lockOptions: { lockPath: join(root, 'publication.lock') },
        prepare: async () => { attempts++; throw new Error('invalid current source'); },
        run: async () => { throw new Error('must not publish'); },
      })).rejects.toThrow('invalid current source');
      expect(attempts).toBe(1);
      expect(existsSync(join(root, 'readiness.json'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['prepare', 'publication'] as const)('propagates continuing %s failures after the existing single trailing pass', async (phase) => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-single-flight-unsettled-'));
    let version = 0;
    const fail = async () => { version++; throw new Error('inputs still moving'); };
    try {
      await expect(withGeneratorSingleFlight({
        readFingerprint: () => String(version),
        stampPath: join(root, 'readiness.json'),
        lockOptions: { lockPath: join(root, 'publication.lock') },
        ...(phase === 'prepare' ? { prepare: fail } : {}),
        run: async () => { if (phase === 'publication') await fail(); },
      })).rejects.toThrow('inputs still moving');
      expect(version).toBe(2);
      expect(existsSync(join(root, 'publication.lock'))).toBe(false);
      if (existsSync(join(root, 'readiness.json'))) {
        expect(JSON.parse(readFileSync(join(root, 'readiness.json'), 'utf8')).publication.error).not.toBeNull();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['settled', 'continuing', 'compile-error'] as const)('uses workspace convergence without multiplying the generator retry (%s)', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-single-flight-packages-'));
    const names = ['@happier-dev/changed', '@happier-dev/unchanged'];
    const dirs = names.map((name) => join(root, 'packages', name.split('/')[1]));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    writeFileSync(join(root, 'yarn.lock'), '# fixture');
    for (const app of ['cli', 'ui', 'server']) {
      mkdirSync(join(root, 'apps', app), { recursive: true });
      writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
    }
    for (const [index, dir] of dirs.entries()) {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const value = 1;\n');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: names[index], main: './dist/index.js', scripts: { build: 'fixture-compiler' } }));
    }
    const compiled: string[] = [];
    let preparations = 0;
    try {
      await withGeneratorSingleFlight({
        readFingerprint: () => JSON.stringify(dirs.map((packageDir) => readWorkspacePackageInputFingerprint({ packageDir }))),
        stampPath: join(root, 'readiness.json'),
        lockOptions: { lockPath: join(root, 'publication.lock') },
        prepare: async () => {
          preparations++;
          const preparation = await ensureWorkspacePackagesBuiltByName(root, names, {
            quiet: true,
            workspaceBuildBoundary: {
              prepareEnv: async (_packageDir: string, env: NodeJS.ProcessEnv) => ({ ...env }),
              runPackageBuild: async (packageDir: string, { env }: { env: NodeJS.ProcessEnv }) => {
                compiled.push(packageDir);
                await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
                  import { readFileSync, writeFileSync } from 'node:fs';
                  const [source, output, mode, moving] = process.argv.slice(1);
                  const input = readFileSync(source, 'utf8');
                  if (moving === 'true' && (input.includes('value = 1') || mode === 'continuing' || mode === 'compile-error')) {
                    writeFileSync(source, input + '// changed\\n');
                    // Settled mode changes only the initial input.
                    if (mode === 'settled') writeFileSync(source, 'export const value = 2;\\n');
                    if (mode === 'compile-error') throw new Error('fixture compiler error');
                  }
                  writeFileSync(output, input);
                `, join(packageDir, 'src', 'index.ts'), join(String(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR), 'index.js'), mode, String(packageDir === dirs[0])]);
              },
            },
          });
          expect(preparation.skipped).toEqual([]);
        },
        run: async (lease) => { lease.assertOwned(); },
      }).then(() => {
        expect(mode).toBe('settled');
      }, (error: unknown) => {
        if (mode === 'settled') throw error;
        expect(error).toMatchObject(mode === 'continuing'
          ? { code: 'BUILD_INPUTS_CHANGED', trailingPassExhausted: true }
          : { code: 'WORKSPACE_PACKAGE_BUILD_FAILED' });
      });
      expect(preparations).toBe(1);
      expect(compiled.filter((dir) => dir === dirs[0])).toHaveLength(mode === 'compile-error' ? 1 : 2);
      expect(compiled.filter((dir) => dir === dirs[1])).toHaveLength(1);
      if (mode === 'settled') expect(readFileSync(join(dirs[0], 'dist', 'index.js'), 'utf8')).toContain('value = 2');
      else expect(existsSync(join(dirs[0], 'dist', 'index.js'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not reserve publication admission while its dependency preparation is pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-single-flight-convoy-'));
    const lockPath = join(root, 'publication.lock');
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let preparing = false;
    const input = {
      readFingerprint: () => 'same',
      stampPath: join(root, 'readiness.json'),
      lockOptions: { lockPath, pollIntervalMs: 10 },
      prepare: async () => { preparing = true; started(); await pending; },
      // The old enclosing lease reaches run without calling preparation. Keep
      // that path suspended too, so the failure measures admission, not timing.
      run: async (lease: WorkspaceBundleLockContext) => {
        started();
        await pending;
        lease.assertOwned();
        writeFileSync(join(root, 'output'), 'published');
      },
    };
    const publication = withGeneratorSingleFlight(input);
    await ready;
    const contender = withWorkspaceBundleLock(async (lease) => {
      lease.assertOwned();
      return 'finished';
    }, { lockPath, pollIntervalMs: 10 });
    try {
      expect(await Promise.race([contender, sleep(250).then(() => 'blocked')])).toBe('finished');
      expect(preparing).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      release();
      await Promise.all([publication, contender]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fingerprints shipped source assets without treating produced runtimes as new source', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-single-flight-inputs-'));
    try {
      mkdirSync(join(root, 'assets'));
      mkdirSync(join(root, '.happier-plugin'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ files: ['assets', '.happier-plugin'] }));
      writeFileSync(join(root, 'assets', 'prompt'), 'first');
      writeFileSync(join(root, '.happier-plugin', 'daemon.mjs'), 'produced-first');
      mkdirSync(join(root, '.happier-plugin', 'ui', 'hosted-web'), { recursive: true });
      const hostedWebPath = join(root, '.happier-plugin', 'ui', 'hosted-web', 'index.html');
      writeFileSync(hostedWebPath, 'first');
      const fingerprint = () => readWorkspacePackageInputFingerprint({
        packageDir: root, includeShippedFiles: true, excludeGeneratedPluginArtifacts: true,
      });
      const first = fingerprint();
      writeFileSync(join(root, '.happier-plugin', 'daemon.mjs'), 'produced-second');
      expect(fingerprint()).toBe(first);
      writeFileSync(join(root, 'assets', 'prompt'), 'second');
      expect(fingerprint()).not.toBe(first);
      const withChangedAsset = fingerprint();
      writeFileSync(hostedWebPath, 'second');
      expect(fingerprint()).not.toBe(withChangedAsset);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('releases admission before preparing the trailing publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-single-flight-trailing-'));
    const lockPath = join(root, 'publication.lock');
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let version = 0;
    let preparations = 0;
    const publication = withGeneratorSingleFlight({
      readFingerprint: () => String(version),
      stampPath: join(root, 'readiness.json'),
      lockOptions: { lockPath, pollIntervalMs: 10 },
      prepare: async () => {
        if (++preparations === 2) { started(); await pending; }
      },
      run: async (lease) => {
        lease.assertOwned();
        writeFileSync(join(root, 'output'), String(version));
        version = 1;
      },
    });
    await ready;
    const contender = withWorkspaceBundleLock(async () => 'finished', { lockPath, pollIntervalMs: 10 });
    try {
      expect(await Promise.race([contender, sleep(250).then(() => 'blocked')])).toBe('finished');
    } finally {
      release();
      await Promise.all([publication, contender]);
    }
    try {
      expect(readFileSync(join(root, 'output'), 'utf8')).toBe('1');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('forwards authentic publication admission to a fresh final child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-single-flight-child-'));
    const lockPath = join(root, 'derivation.lock');
    try {
      await withGeneratorSingleFlight({
        readFingerprint: () => 'same',
        stampPath: join(root, 'readiness.json'),
        lockOptions: { lockPath },
        run: async (lease) => {
          const child = `
            import { withWorkspaceBundleLock } from ${JSON.stringify(new URL('../../../../../packages/cli-common/workspaceBundleLock.mjs', import.meta.url).href)};
            import { existsSync, writeFileSync } from 'node:fs';
            const [root, heldLockValue] = process.argv.slice(1);
            await withWorkspaceBundleLock(async (lease) => {
              if (!lease.inherited || existsSync(root + '/publication.lock')) throw new Error('child has wrong preparation owner');
              lease.assertOwned();
              writeFileSync(root + '/output', 'prepared');
            }, {lockPath: root + '/derivation.lock', heldLockValue});
          `;
          await promisify(execFile)(process.execPath,
            ['--experimental-strip-types', '--input-type=module', '-e', child, root, lease.heldLockValue]);
          lease.assertOwned();
        },
      });
      expect(readFileSync(join(root, 'output'), 'utf8')).toBe('prepared');
      expect(existsSync(lockPath)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects continuing edits after the single trailing pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-single-flight-editing-'));
    let version = 0;
    try {
      await expect(withGeneratorSingleFlight({
        readFingerprint: () => String(version),
        stampPath: join(root, 'readiness.json'),
        lockOptions: { lockPath: join(root, 'derivation.lock') },
        run: async () => { version++; },
      })).rejects.toThrow('inputs changed during the trailing publication');
      expect(version).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('invalidates an overlapping completion when its published outputs changed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-single-flight-output-change-'));
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let preparations = 0;
    const output = join(root, 'output');
    writeFileSync(output, 'old');
    const input = {
      readFingerprint: () => 'same',
      readCurrentness: () => readFileSync(output, 'utf8'),
      stampPath: join(root, 'readiness.json'),
      lockOptions: { lockPath: join(root, 'derivation.lock'), pollIntervalMs: 10 },
      run: async () => { preparations++; started(); await pending; writeFileSync(output, 'current'); },
    };
    const first = withGeneratorSingleFlight(input);
    await ready;
    // Corrupt the output only at the admitted recheck after completion, not
    // during the now-independent preparation/fingerprint reads.
    let corrupted = false;
    const waiter = withGeneratorSingleFlight({ ...input, readFingerprint: () => {
      if (!corrupted && existsSync(input.stampPath)) {
        corrupted = true;
        writeFileSync(output, 'changed-after-publication');
      }
      return 'same';
    } });
    release();
    try {
      await Promise.all([first, waiter]);
      expect(preparations).toBe(2);
      expect(readFileSync(output, 'utf8')).toBe('current');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([false, true])('coalesces final publication after independent preparation in four processes (changed inputs: %s)', async (changed) => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-single-flight-'));
    const sourcePath = join(root, 'source');
    const eventsPath = join(root, 'events');
    const releasePath = join(root, 'release');
    writeFileSync(sourcePath, 'first');
    const childSource = `
      import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { setTimeout as sleep } from 'node:timers/promises';
      import { withGeneratorSingleFlight } from ${JSON.stringify(new URL('./publication.ts', import.meta.url).href)};
      import { normalizeCanonicalGeneratorPublication, parseGeneratorCliArgs } from ${JSON.stringify(new URL('./options.ts', import.meta.url).href)};
      const [root, caller] = process.argv.slice(1);
      const argv = caller === 'syncSharedDeps' ? ['--workspace', 'plugins-fixture'] : [];
      const { options } = normalizeCanonicalGeneratorPublication(argv, parseGeneratorCliArgs(argv), ['plugins-fixture']);
      appendFileSync(root + '/arrivals', 'ready\\n');
      await withGeneratorSingleFlight({
        readFingerprint: () => JSON.stringify([options.workspaceNames, readFileSync(root + '/source', 'utf8')]),
        stampPath: root + '/readiness.json',
        lockOptions: { lockPath: root + '/publication.lock', pollIntervalMs: 10 },
        prepare: async () => {
          appendFileSync(root + '/events', readFileSync(root + '/source', 'utf8') + '\\n');
          while (!existsSync(root + '/release')) await sleep(10);
        },
        run: async (lease) => {
          lease.assertOwned();
          appendFileSync(root + '/publications', 'published\\n');
          writeFileSync(root + '/output', readFileSync(root + '/source', 'utf8'));
        },
      });
    `;
    const children = Array.from({ length: 4 }, (_, index) => promisify(execFile)(process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', childSource, root,
        index % 2 === 0 ? 'direct' : 'syncSharedDeps']));
    try {
      while (!existsSync(eventsPath) || readFileSync(eventsPath, 'utf8').trim().split('\n').length !== 4 || !existsSync(join(root, 'arrivals'))
        || readFileSync(join(root, 'arrivals'), 'utf8').trim().split('\n').length !== 4) await sleep(10);
      // Every child has arrived while the first preparation is suspended.
      await sleep(100);
      expect(existsSync(join(root, 'publication.lock'))).toBe(false);
      if (changed) writeFileSync(sourcePath, 'second');
      writeFileSync(releasePath, 'release');
      await Promise.all(children);
      const preparations = readFileSync(eventsPath, 'utf8').trim().split('\n');
      expect(preparations.filter((value) => value === 'first')).toHaveLength(4);
      // Source used by generation is pinned after dependency preparation;
      // changing it while that independent preparation waits needs no rebuild.
      expect(preparations.includes('second')).toBe(false);
      expect(readFileSync(join(root, 'publications'), 'utf8').trim().split('\n')).toEqual(['published']);
      expect(readFileSync(join(root, 'output'), 'utf8')).toBe(changed ? 'second' : 'first');
    } finally {
      writeFileSync(releasePath, 'release');
      await Promise.allSettled(children);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses an overlapping failure but retries a subsequent independent request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-single-flight-failure-'));
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let preparations = 0;
    const input = {
      readFingerprint: () => 'same',
      stampPath: join(root, 'readiness.json'),
      lockOptions: { lockPath: join(root, 'derivation.lock'), pollIntervalMs: 10 },
      run: async () => { preparations++; started(); await pending; throw new Error('compiler failed'); },
    };
    const first = withGeneratorSingleFlight(input).catch((error: unknown) => error);
    await ready;
    const waiter = withGeneratorSingleFlight(input).catch((error: unknown) => error);
    release();
    try {
      const errors = await Promise.all([first, waiter]);
      expect(errors.every((error) => error instanceof Error && error.message === 'compiler failed')).toBe(true);
      expect(preparations).toBe(1);
      await expect(withGeneratorSingleFlight(input)).rejects.toThrow('compiler failed');
      expect(preparations).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('prepared bundled publication', () => {
  it.each([true, false])('fences a private child commit when its preparation lease was superseded (fence: %s)', async (fenced) => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-preparation-fence-'));
    const preparationPath = join(root, 'derivation.lock');
    const outPath = join(root, 'projection.ts');
    writeFileSync(outPath, 'last-green');
    try {
      await withWorkspaceBundleLock(async (preparationLease) => {
        const publication = withPreparedGeneratorPublication({
          prepare: async () => () => {},
          publish: async (lease) => {
            // A successor replaces the real filesystem lease after staging.
            const owner = JSON.parse(readFileSync(preparationPath, 'utf8'));
            writeFileSync(preparationPath, JSON.stringify({ ...owner, token: 'successor' }));
            publishCoherentProjectionOutputs(root, [{ outPath, out: 'new' }], lease);
          },
          ...(fenced ? { preparationLease } : {}),
          lockOptions: { lockPath: join(root, 'publication.lock') },
        });
        if (fenced) await expect(publication).rejects.toThrow();
        else await publication;
      }, { lockPath: preparationPath });
      // Sensitivity: omitting the enclosing lease publishes obsolete bytes.
      expect(readFileSync(outPath, 'utf8')).toBe(fenced ? 'last-green' : 'new');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['caller-owned', 'generator-owned'] as const)(
    'lets the private child preparation and publication proceed after a %s parent publication',
    async (ownership) => {
      const root = mkdtempSync(join(tmpdir(), 'bundled-publication-handover-'));
      const lockPath = join(root, 'publication.lock');
      const outPath = join(root, 'projection.ts');
      // Exercise the private phase's real environment, preparation/publication
      // owner and output transaction in a fresh process, without compiling or
      // publishing the shared checkout's workspace closure.
      const childSource = `
        import { withWorkspaceBundleLock } from ${JSON.stringify(new URL('../../../../../packages/cli-common/workspaceBundleLock.mjs', import.meta.url).href)};
        import { withPreparedGeneratorPublication } from ${JSON.stringify(new URL('./publication.ts', import.meta.url).href)};
        import { publishCoherentProjectionOutputs } from ${JSON.stringify(new URL('./outputs.ts', import.meta.url).href)};
        const [root, lockPath, outPath] = process.argv.slice(1);
        const controller = new AbortController();
        const lockOptions = {
          lockPath,
          heldLockValue: process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
          signal: controller.signal,
          // An inherited lease must never wait on its parent. Abort on the
          // observed wait, rather than making a healthy-owner timeout policy.
          onWait: () => controller.abort(new Error('child waited on parent publication')),
        };
        let preparationInherited;
        await withPreparedGeneratorPublication({
          prepare: async () => {
            await withWorkspaceBundleLock(async (lease) => {
              lease.assertOwned();
              preparationInherited = lease.inherited;
            }, lockOptions);
            return () => {};
          },
          publish: async (lease) => {
            publishCoherentProjectionOutputs(root, [{ outPath, out: 'child-published' }], lease);
            process.stdout.write(JSON.stringify({ preparationInherited, publicationInherited: lease.inherited }));
          },
          lockOptions,
        });
      `;
      const runChild = async (env: NodeJS.ProcessEnv) => await promisify(execFile)(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', childSource, root, lockPath, outPath],
        { env },
      );
      const publishThenRunChild = async (callerLease: string | undefined) => {
        let publicationLease: string | undefined;
        await withPreparedGeneratorPublication({
          prepare: async () => () => {},
          publish: async (lease) => {
            publicationLease = lease.heldLockValue;
            publishCoherentProjectionOutputs(root, [{ outPath, out: 'parent-published' }], lease);
          },
          lockOptions: { lockPath, heldLockValue: callerLease },
        });
        expect(readFileSync(outPath, 'utf8')).toBe('parent-published');
        expect(existsSync(lockPath)).toBe(callerLease !== undefined);
        const childEnv = createWorkspaceChildBuildEnv({
          env: { ...process.env, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: publicationLease },
          heldLockValue: callerLease,
        });
        expect(childEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD).toBe(callerLease);
        const result = await runChild(childEnv);
        expect(JSON.parse(result.stdout)).toEqual({
          preparationInherited: callerLease !== undefined,
          publicationInherited: callerLease !== undefined,
        });
        expect(readFileSync(outPath, 'utf8')).toBe('child-published');
        expect(existsSync(`${lockPath}.priority-claim`)).toBe(false);
        expect(existsSync(lockPath)).toBe(callerLease !== undefined);
        if (callerLease) {
          // Sensitivity check: the incident's legacy marker cannot authenticate
          // reentry. The child must fail at admission and preserve published bytes.
          await expect(runChild({ ...childEnv, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: lockPath }))
            .rejects.toThrow('child waited on parent publication');
          expect(readFileSync(outPath, 'utf8')).toBe('child-published');
        }
      };
      try {
        if (ownership === 'caller-owned') {
          await withWorkspaceBundleLock(async (lease) => {
            await publishThenRunChild(lease.heldLockValue);
            lease.assertOwned();
          }, { lockPath });
        } else {
          await publishThenRunChild(undefined);
        }
        expect(existsSync(lockPath)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('lets another publisher finish while dependency preparation is pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-publication-preparation-'));
    const lockPath = join(root, 'publication.lock');
    const outPath = join(root, 'projection.ts');
    let releasePreparation!: () => void;
    let preparationStarted!: () => void;
    const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
    const release = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const publication = withPreparedGeneratorPublication({
      prepare: async () => {
        preparationStarted();
        await release;
        return () => {};
      },
      publish: async (lease) => publishCoherentProjectionOutputs(root, [{ outPath, out: 'prepared' }], lease),
      lockOptions: { lockPath },
    });
    await started;
    const contender = withWorkspaceBundleLock(async (lease) => {
      publishCoherentProjectionOutputs(root, [{ outPath, out: 'other-publisher' }], lease);
      return 'finished';
    }, { lockPath });
    try {
      expect(await Promise.race([contender, sleep(250).then(() => 'blocked')])).toBe('finished');
      expect(readFileSync(outPath, 'utf8')).toBe('other-publisher');
    } finally {
      releasePreparation();
      await Promise.all([publication, contender]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails dependency preparation before waiting for or creating a publication claim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-publication-failure-'));
    const lockPath = join(root, 'publication.lock');
    let publication: Promise<unknown> | undefined;
    try {
      await withWorkspaceBundleLock(async () => {
        publication = withPreparedGeneratorPublication({
          prepare: async () => { throw new Error('dependency compiler failed'); },
          publish: async () => writeFileSync(join(root, 'projection.ts'), 'must-not-publish'),
          lockOptions: { lockPath },
        }).catch((error: unknown) => error instanceof Error ? error.message : String(error));
        expect(await Promise.race([publication, sleep(250).then(() => 'blocked')]))
          .toBe('dependency compiler failed');
        expect(existsSync(`${lockPath}.priority-claim`)).toBe(false);
        expect(existsSync(join(root, 'projection.ts'))).toBe(false);
      }, { lockPath });
    } finally {
      await publication;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an input changed while waiting before the coherent publication writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-publication-currentness-'));
    const lockPath = join(root, 'publication.lock');
    const inputPath = join(root, 'source.txt');
    const outPath = join(root, 'projection.ts');
    writeFileSync(inputPath, 'first');
    writeFileSync(outPath, 'last-green');
    let prepared!: () => void;
    const preparation = new Promise<void>((resolve) => { prepared = resolve; });
    let publication!: Promise<unknown>;
    try {
      await withWorkspaceBundleLock(async () => {
        publication = withPreparedGeneratorPublication({
          prepare: async () => {
            const source = readFileSync(inputPath, 'utf8');
            prepared();
            return () => {
              if (readFileSync(inputPath, 'utf8') !== source) throw new Error('prepared inputs changed');
            };
          },
          publish: async (lease) => publishCoherentProjectionOutputs(root, [{ outPath, out: 'new' }], lease),
          lockOptions: { lockPath },
        }).catch((error: unknown) => error instanceof Error ? error.message : String(error));
        await Promise.race([preparation, sleep(250)]);
        writeFileSync(inputPath, 'second');
      }, { lockPath });
      expect(await publication).toBe('prepared inputs changed');
      expect(readFileSync(outPath, 'utf8')).toBe('last-green');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fences the output transaction when inputs change after admission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-publication-commit-currentness-'));
    const inputPath = join(root, 'source.txt');
    const outPath = join(root, 'projection.ts');
    writeFileSync(inputPath, 'first');
    writeFileSync(outPath, 'last-green');
    try {
      await expect(withPreparedGeneratorPublication({
        prepare: async () => {
          const source = readFileSync(inputPath, 'utf8');
          return () => {
            if (readFileSync(inputPath, 'utf8') !== source) throw new Error('prepared inputs changed');
          };
        },
        publish: async (lease) => {
          writeFileSync(inputPath, 'changed-during-staging');
          publishCoherentProjectionOutputs(root, [{ outPath, out: 'new' }], lease);
        },
        lockOptions: { lockPath: join(root, 'publication.lock') },
      })).rejects.toThrow('prepared inputs changed');
      expect(readFileSync(outPath, 'utf8')).toBe('last-green');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
