import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runNodeCapture } from '../testkit/core/run_node_capture.mjs';

import { requiresStackDaemonPreflight } from './stack_happier_daemon_preflight.mjs';

test('requiresStackDaemonPreflight skips daemon preflight for session create help paths', () => {
  assert.equal(requiresStackDaemonPreflight(['session', 'create', '--help']), false);
  assert.equal(requiresStackDaemonPreflight(['session', 'create', '-h']), false);
});

test('requiresStackDaemonPreflight keeps daemon preflight for executable session and attach paths', () => {
  assert.equal(requiresStackDaemonPreflight(['session', 'create']), true);
  assert.equal(requiresStackDaemonPreflight(['resume']), true);
  assert.equal(requiresStackDaemonPreflight(['attach']), true);
});

test('ensureStackDaemonPreflight preserves canonical runtime provenance from daemon command context', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-daemon-preflight-provenance-'));
  try {
    const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const markerPath = join(tmp, 'daemon-input.json');
    const loaderPath = join(tmp, 'loader.mjs');
    const registerPath = join(tmp, 'register.mjs');
    const runnerPath = join(tmp, 'runner.mjs');
    const toDataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
    const stubBySpecifier = {
      '../daemon.mjs': toDataUrl(`
import { writeFileSync } from 'node:fs';
export async function startLocalDaemonWithAuth(input) {
  writeFileSync(process.env.HSTACK_PREFLIGHT_MARKER, JSON.stringify(input), 'utf8');
}
`),
      './stack_daemon_command.mjs': toDataUrl(`
export async function resolveStackDaemonCommandContext() {
  return {
    cliBin: '/runtime/cli/happier',
    cliEntrypoint: '/runtime/cli/happier',
    cliNodeEntrypoint: '/runtime/cli/package-dist/index.mjs',
    cliCommand: '/runtime/cli/happier',
    cliCommandArgs: [],
    cliHomeDir: '/stack/cli',
    runtimePath: '/stack/stack.runtime.json',
    internalServerUrl: 'http://127.0.0.1:4102',
    publicServerUrl: 'http://127.0.0.1:4102',
    envForIdentity: {},
    runtimeProvenance: {
      runtimeBacked: true,
      admittedDistClosureFingerprint: 'abcdef1234567890',
      distEntrypoint: '/runtime/cli/package-dist/index.mjs',
    },
  };
}
`),
    };
    await writeFile(loaderPath, `
const stubs = ${JSON.stringify(stubBySpecifier)};
export async function resolve(specifier, context, defaultResolve) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true };
  return defaultResolve(specifier, context, defaultResolve);
}
`, 'utf8');
    await writeFile(registerPath, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);\n`, 'utf8');
    await writeFile(runnerPath, `
import { ensureStackDaemonPreflight } from ${JSON.stringify(pathToFileURL(join(scriptsDir, 'stack', 'stack_happier_daemon_preflight.mjs')).href)};
await ensureStackDaemonPreflight({ rootDir: '/repo', stackName: 'dev', env: {}, argv: [], cliIdentity: 'default' });
`, 'utf8');

    const res = await runNodeCapture(['--import', registerPath, runnerPath], {
      env: { ...process.env, HSTACK_PREFLIGHT_MARKER: markerPath },
    });
    assert.equal(res.code, 0, res.stderr);
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    assert.equal(marker.runtimeBacked, true);
    assert.equal(marker.admittedDistClosureFingerprint, 'abcdef1234567890');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
