import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';

test('finite source preparation uses the native memory queue and releases it on completion and cancellation',
  { skip: process.platform !== 'linux', timeout: 20000 }, async (t) => {
    const fixture = await createTempFixture(t, { prefix: 'happier-source-admission-' });
    const native = await installNativeAdmissionFixture({ root: fixture.root });
    const adapter = join(fixture.root, 'native-owner/apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs');
    await copyFile(fileURLToPath(new URL('./runSourceBuildCommand.mjs', import.meta.url)), adapter);
    const { runSourceBuildCommand } = await import(pathToFileURL(adapter));
    await mkdir(fixture.path('bin'));
    const available = fixture.path('available-memory');
    const lowMemoryObserved = fixture.path('low-memory-observed');
    await writeFile(available, '5242880');
    const awk = fixture.path('bin/awk');
    // Only the real OS memory boundary is substituted. Queue records, kernel
    // process identity, ancestry, reservations, and command execution stay real.
    await writeFile(awk, `#!/bin/sh
case "$*" in
  */proc/meminfo*)
    available=$(/bin/cat '${available}')
    printf '%s 16777216\\n' "$available"
    [ "$available" -ne 5242880 ] || printf 'observed' > '${lowMemoryObserved}'
    ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`);
    await chmod(awk, 0o755);
    const env = { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`, HAPPIER_DEV_TARGET_EXECUTION: '1' };
    for (const key of Object.keys(env)) if (key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_')) delete env[key];
    await mkdir(join(native.admissionRoot, 'waiters'), { recursive: true });
    await mkdir(join(native.admissionRoot, 'owners'), { recursive: true });
    const marker = fixture.path('executed');
    const scriptPath = fixture.path('prepare.mjs');
    await writeFile(scriptPath, `
      import {writeFileSync,readFileSync} from 'node:fs'; import {join} from 'node:path';
      const token=process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN;
      const owner=join(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT,'owners',token.replace(':','-'));
      writeFileSync(${JSON.stringify(marker)},'executed');
      console.log(JSON.stringify({className:readFileSync(join(owner,'class'),'utf8').trim()}));
    `);
    const queued = () => {
      const watcher = watch(join(native.admissionRoot, 'waiters'));
      t.after(() => watcher.close());
      return new Promise((resolve, reject) => {
        watcher.on('error', reject);
        watcher.on('change', async () => {
          if ((await readdir(join(native.admissionRoot, 'waiters'))).length) { watcher.close(); resolve(); }
        });
      });
    };
    const observedPressure = () => {
      const watcher = watch(fixture.root);
      t.after(() => watcher.close());
      return new Promise((resolve, reject) => {
        watcher.on('error', reject);
        watcher.on('change', (_event, filename) => {
          if (filename === 'low-memory-observed') { watcher.close(); resolve(); }
        });
      });
    };
    const pendingQueue = queued();
    const pendingPressure = observedPressure();
    const pending = runSourceBuildCommand({ repoDir: fixture.root, scriptPath, env, signal: t.signal });
    await pendingQueue;
    await pendingPressure;
    await assert.rejects(access(marker), { code: 'ENOENT' });
    await writeFile(available, '16777216');
    assert.deepEqual(JSON.parse(await pending), { className: 'validation' });
    assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')), []);
    assert.deepEqual(await readdir(join(native.admissionRoot, 'waiters')), []);
    assert.deepEqual(JSON.parse(await runSourceBuildCommand({ repoDir: fixture.root,
      scriptPath, env, signal: t.signal, admissionClass: 'source-bundle' })), { className: 'source-bundle' });
    assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')), []);
    assert.deepEqual(await readdir(join(native.admissionRoot, 'waiters')), []);
    await writeFile(available, '16777216');
    await writeFile(scriptPath, 'process.exit(47);');
    await assert.rejects(runSourceBuildCommand({ repoDir: fixture.root, scriptPath, env, signal: t.signal }), { code: 47 });
    const externalCommand = fixture.path('external-source-command');
    await writeFile(externalCommand, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    await chmod(externalCommand, 0o755);
    await assert.rejects(runSourceBuildCommand({ repoDir: fixture.root,
      command: externalCommand, args: [scriptPath], env, signal: t.signal }), { code: 47 });
    await writeFile(available, '5242880');
    const controller = new AbortController();
    const cancellationQueue = queued();
    const cancellationPressure = observedPressure();
    const cancelled = runSourceBuildCommand({ repoDir: fixture.root,
      command: externalCommand, args: [scriptPath], env, signal: AbortSignal.any([controller.signal, t.signal]) });
    // Attach before abort so the preserved OS cancellation cannot be unhandled.
    const cancellationResult = assert.rejects(cancelled, { name: 'AbortError' });
    await cancellationQueue;
    await cancellationPressure;
    controller.abort();
    await cancellationResult;
    assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')), []);
    assert.deepEqual(await readdir(join(native.admissionRoot, 'waiters')), []);
  });
