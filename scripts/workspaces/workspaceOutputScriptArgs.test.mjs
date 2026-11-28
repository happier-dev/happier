// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { sourceBuildNodeArgs } from '../../apps/stack/scripts/utils/proc/sourceBuildNodeArgs.mjs';
import { withWorkspaceOutputScriptArgs } from './workspaceOutputScriptArgs.mjs';

const execFileAsync = promisify(execFile);

test('staged UI builds resolve manifest and artifact dependencies from current workspace source despite stale installed exports', async (t) => {
  const packageDir = await mkdtemp(join(tmpdir(), 'happier-ui-source-resolution-'));
  t.after(() => rm(packageDir, { recursive: true, force: true }));
  const outputDir = join(packageDir, 'staged');
  await mkdir(outputDir);
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { 'build:ui': 'happier-plugin-build-ui' },
    exports: {
      './manifest': './dist/manifest.js',
      './happier-plugin-ui/panel': './panel.ts',
    },
  }));
  await writeFile(join(packageDir, 'definition.ts'), `
    type DefinitionLifetime = { name: string };
    export const definition: DefinitionLifetime = { name: 'staged-source' };
  `);
  const dependencyDir = join(packageDir, 'node_modules/@happier-dev/channels-protocol');
  await mkdir(dependencyDir, { recursive: true });
  await writeFile(join(dependencyDir, 'package.json'), JSON.stringify({
    type: 'module', exports: { './v1': './stale.js' },
  }));
  await writeFile(join(dependencyDir, 'stale.js'), 'export const obsolete = true;');
  const sourceConsumer = `import { CONVERSATION_DELIVERY_NOT_SENT_REASONS_V1 } from '@happier-dev/channels-protocol/v1';`;
  await writeFile(join(packageDir, 'panel.ts'), `${sourceConsumer}
    export function renderSurface() { return CONVERSATION_DELIVERY_NOT_SENT_REASONS_V1; }`);
  const hostedDir = join(packageDir, '.happier-plugin/ui/hosted-web/hosted');
  await mkdir(hostedDir, { recursive: true });
  await writeFile(join(hostedDir, 'index.html'), '<script src="./assets/app.js"></script>');
  await writeFile(join(hostedDir, 'entry.ts'), `${sourceConsumer}
    globalThis.reasons = CONVERSATION_DELIVERY_NOT_SENT_REASONS_V1;`);
  const toolSource = new URL('../../packages/protocol/src/tools/happierToolAutoApprovalV1.ts', import.meta.url).href;
  await writeFile(join(outputDir, 'manifest.js'), `
    import { definition } from '../definition.js';
    import { listHappierToolAutoApprovedNamesV1 } from ${JSON.stringify(toolSource)};
    export const PLUGIN_MANIFEST = {
      name: definition.name + ':' + listHappierToolAutoApprovedNamesV1()[0],
      contributes: { ui: { renderers: [{ kind: 'reactNative', artifact: 'panel' },
        { kind: 'hostedWeb', source: { kind: 'artifact', artifact: 'hosted' } }] } }
    };
  `);
  const repoDir = fileURLToPath(new URL('../../', import.meta.url));
  const linkedRepo = join(packageDir, 'capture-repo');
  await symlink(repoDir, linkedRepo, 'junction');
  const env = {
    ...process.env,
    NODE_OPTIONS: '--trace-warnings',
    HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: outputDir,
    HAPPIER_WORKSPACE_CAPTURE_SOURCE_REPO_DIR: repoDir,
    HAPPIER_STACK_REPO_DIR: linkedRepo,
  };
  await withWorkspaceOutputScriptArgs({ packageDir, scriptName: 'build:ui', env }, async (args, childEnv = env) => {
    const manifestPath = args[args.indexOf('--manifest-path') + 1];
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.match(manifest.name, /^staged-source:.+/u);
    // Sensitivity control: Node's source loader cannot repair the bundler's
    // stale installed exports when the source build options are absent.
    const legacyArgs = sourceBuildNodeArgs({
      repoDir,
      scriptPath: fileURLToPath(new URL('../../packages/plugin-sdk/src/ui/build/bin.ts', import.meta.url)),
      args: ['--project-root', packageDir, '--manifest-path', manifestPath],
    });
    await assert.rejects(execFileAsync(process.execPath, legacyArgs, { cwd: packageDir, env: childEnv }), error => error.code === 1
      && /No matching export.*CONVERSATION_DELIVERY_NOT_SENT_REASONS_V1/u.test(error.stderr));
    // Real SDK executable, compiler and Protocol graph; no test-runner resolver
    // or preload may hide the package-manager child's source-resolution gap.
    // Replace only package-manager dispatch, retaining the returned command and
    // real compiler process. The ordinary SDK CLI represents `run build:ui`.
    const invocation = args[0] === 'exec'
      ? { command: args[1], args: args.slice(2) }
      : { command: process.execPath, args: [
        fileURLToPath(new URL('../../packages/plugin-sdk/src/ui/build/bin.ts', import.meta.url)),
        '--project-root', packageDir, ...args.slice(3),
      ] };
    await execFileAsync(invocation.command, invocation.args, { cwd: packageDir, env: childEnv });
  });
  const artifacts = JSON.parse(await readFile(join(outputDir, 'happier-plugin-ui/ui-artifacts.json'), 'utf8'));
  assert.deepEqual(artifacts.entries.map(entry => entry.artifactId).sort(), ['hosted', 'panel']);
  assert.equal(env.NODE_OPTIONS, '--trace-warnings');
});
