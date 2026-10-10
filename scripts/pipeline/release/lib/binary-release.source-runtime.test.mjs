import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('native release tooling loads authored workspace code without publication prerequisites', () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const hook = `
    import { fileURLToPath } from 'node:url';
    const repoRoot = ${JSON.stringify(repoRoot)};
    export async function load(url, context, nextLoad) {
      if (url.startsWith('file:')) {
        const filename = fileURLToPath(url).replaceAll('\\\\', '/');
        const root = repoRoot.replaceAll('\\\\', '/');
        if ((filename.startsWith(root + 'packages/') || filename.startsWith(root + 'apps/'))
          && filename.includes('/dist/')) {
          throw new Error('Native release tooling consumed workspace publication: ' + filename);
        }
      }
      return nextLoad(url, context);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { register } from 'node:module';
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)}, import.meta.url);
    const tooling = await import(${JSON.stringify(new URL('./binary-release.mjs', import.meta.url).href)});
    if (typeof tooling.buildCliBinaryArtifactPayload !== 'function' || tooling.CLI_STACK_TARGETS.length === 0) {
      throw new Error('Native CLI construction API is unavailable');
    }
    console.log('native-release-source-ready');
  `], { cwd: repoRoot, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /native-release-source-ready/);
});
