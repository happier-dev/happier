import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import {
  parseEasBuildFromCommandOutput,
  parseEasBuildListFromCommandOutput,
  parseEasBuildsFromCommandOutput,
  parseExpoFingerprintFromCommandOutput,
  parseJsonFromCommandOutput,
} from './parse-json-from-command-output.mjs';

function toDataUrl(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr });
    });
  });
}

test('parseJsonFromCommandOutput prefers the trailing authoritative JSON payload over earlier valid JSON noise', () => {
  const parsed = parseJsonFromCommandOutput(
    [
      'note {"kind":"noise","status":"ignore"}',
      JSON.stringify([
        {
          id: 'build-existing',
          status: 'IN_QUEUE',
          platform: 'ios',
        },
      ]),
    ].join('\n'),
    'eas build:list',
  );

  assert.deepEqual(parsed, [
    {
      id: 'build-existing',
      status: 'IN_QUEUE',
      platform: 'ios',
    },
  ]);
});

test('parseExpoFingerprintFromCommandOutput keeps the fingerprint payload ahead of trailing JSON diagnostics', () => {
  const fingerprint = {
    hash: 'fingerprint-real',
    sources: [
      {
        type: 'file',
        filePath: 'package.json',
        hash: 'source-real',
      },
    ],
  };

  const parsed = parseExpoFingerprintFromCommandOutput(
    [
      'Expo fingerprint cache hit',
      JSON.stringify(fingerprint, null, 2),
      'debug config {}',
    ].join('\n'),
    'eas fingerprint:generate (android)',
  );

  assert.deepEqual(parsed, fingerprint);
});

test('parseEasBuildListFromCommandOutput keeps the build list ahead of trailing JSON diagnostics', () => {
  const builds = [
    {
      id: 'build-existing',
      status: 'IN_QUEUE',
      platform: 'ios',
    },
  ];

  const parsed = parseEasBuildListFromCommandOutput(
    [
      'Querying builds by fingerprint',
      JSON.stringify(builds, null, 2),
      'debug config {}',
    ].join('\n'),
    'eas build:list --fingerprint-hash',
  );

  assert.deepEqual(parsed, builds);
});

test('parseEasBuildListFromCommandOutput keeps real build records ahead of trailing empty-array diagnostics', () => {
  const builds = [
    {
      id: 'build-existing',
      status: 'IN_QUEUE',
      platform: 'ios',
    },
  ];

  const parsed = parseEasBuildListFromCommandOutput(
    [
      'Querying builds by fingerprint',
      JSON.stringify(builds, null, 2),
      'debug []',
    ].join('\n'),
    'eas build:list --fingerprint-hash',
  );

  assert.deepEqual(parsed, builds);
});

test('parseEasBuildListFromCommandOutput keeps authoritative empty lists ahead of trailing diagnostic objects', () => {
  const parsed = parseEasBuildListFromCommandOutput(
    [
      'Querying builds by fingerprint',
      '[]',
      'debug {"id":"diagnostic"}',
    ].join('\n'),
    'eas build:list --fingerprint-hash',
  );

  assert.deepEqual(parsed, []);
});

test('parseEasBuildListFromCommandOutput keeps authoritative empty lists ahead of trailing diagnostic arrays', () => {
  const parsed = parseEasBuildListFromCommandOutput(
    [
      'Querying builds by fingerprint',
      '[]',
      '[{"id":"diagnostic-build","status":"note","platform":"android"}]',
    ].join('\n'),
    'eas build:list --fingerprint-hash',
  );

  assert.deepEqual(parsed, []);
});

test('parseJsonFromCommandOutput redacts and truncates captured output in parse errors', () => {
  assert.throws(
    () =>
      parseEasBuildListFromCommandOutput(
        [
          'EXPO_TOKEN=expo-secret-value',
          'SENTRY_AUTH_TOKEN=sentry-secret-value',
          `diagnostic ${'x'.repeat(800)}`,
        ].join('\n'),
        'eas build:list',
      ),
    (error) => {
      const message = String(error?.message ?? '');
      assert.doesNotMatch(message, /expo-secret-value/);
      assert.doesNotMatch(message, /sentry-secret-value/);
      assert.match(message, /EXPO_TOKEN=<redacted>/);
      assert.match(message, /SENTRY_AUTH_TOKEN=<redacted>/);
      assert.match(message, /truncated/);
      return true;
    },
  );
});

test('parseJsonFromCommandOutput redacts JSON and colon-style secrets in parse errors', () => {
  assert.throws(
    () =>
      parseEasBuildListFromCommandOutput(
        [
          '{"EXPO_TOKEN":"expo-json-secret"}',
          'SENTRY_AUTH_TOKEN: sentry-colon-secret',
          'APPLE_API_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\napple-private-key-secret\n-----END PRIVATE KEY-----',
          'TAURI_SIGNING_PRIVATE_KEY: tauri-private-key-secret',
          'Authorization: Bearer authorization-secret',
        ].join('\n'),
        'eas build:list',
      ),
    (error) => {
      const message = String(error?.message ?? '');
      assert.doesNotMatch(message, /expo-json-secret/);
      assert.doesNotMatch(message, /sentry-colon-secret/);
      assert.doesNotMatch(message, /apple-private-key-secret/);
      assert.doesNotMatch(message, /BEGIN PRIVATE KEY/);
      assert.doesNotMatch(message, /END PRIVATE KEY/);
      assert.doesNotMatch(message, /tauri-private-key-secret/);
      assert.doesNotMatch(message, /authorization-secret/);
      assert.match(message, /EXPO_TOKEN/);
      assert.match(message, /<redacted>/);
      return true;
    },
  );
});

test('parseJsonFromCommandOutput redacts spaced env secrets and authorization assignments in parse errors', () => {
  assert.throws(
    () =>
      parseEasBuildListFromCommandOutput(
        [
          'EXPO_TOKEN = expo-spaced-secret',
          'Authorization=Bearer authorization-assignment-secret',
        ].join('\n'),
        'eas build:list',
      ),
    (error) => {
      const message = String(error?.message ?? '');
      assert.doesNotMatch(message, /expo-spaced-secret/);
      assert.doesNotMatch(message, /authorization-assignment-secret/);
      assert.doesNotMatch(message, /Bearer/);
      assert.match(message, /EXPO_TOKEN\s*=\s*<redacted>/);
      assert.match(message, /Authorization\s*=\s*<redacted>/);
      return true;
    },
  );
});

test('parseJsonFromCommandOutput redacts bare PEM blocks in parse errors', () => {
  assert.throws(
    () =>
      parseEasBuildListFromCommandOutput(
        [
          'Unable to parse EAS output',
          '-----BEGIN PRIVATE KEY-----',
          'bare-private-key-secret',
          '-----END PRIVATE KEY-----',
        ].join('\n'),
        'eas build:list',
      ),
    (error) => {
      const message = String(error?.message ?? '');
      assert.doesNotMatch(message, /bare-private-key-secret/);
      assert.doesNotMatch(message, /BEGIN PRIVATE KEY/);
      assert.doesNotMatch(message, /END PRIVATE KEY/);
      assert.match(message, /<redacted>/);
      return true;
    },
  );
});

test('parseEasBuildsFromCommandOutput keeps the build object ahead of trailing build-like diagnostics', () => {
  const build = {
    id: 'real-build',
    status: 'IN_QUEUE',
    platform: 'android',
  };

  const parsed = parseEasBuildsFromCommandOutput(
    [
      'Scheduling build',
      JSON.stringify(build, null, 2),
      '{"id":"diagnostic-build","status":"note","platform":"android"}',
    ].join('\n'),
    'eas build',
  );

  assert.deepEqual(parsed, build);
});

test('parseEasBuildsFromCommandOutput keeps the build object ahead of trailing build-like diagnostic arrays', () => {
  const build = {
    id: 'real-build',
    status: 'IN_QUEUE',
    platform: 'android',
  };

  const parsed = parseEasBuildsFromCommandOutput(
    [
      'Scheduling build',
      JSON.stringify(build, null, 2),
      JSON.stringify([
        {
          id: 'diagnostic-build',
          status: 'note',
          platform: 'android',
        },
      ]),
    ].join('\n'),
    'eas build',
  );

  assert.deepEqual(parsed, build);
});

test('parseEasBuildFromCommandOutput accepts one-element build arrays for build:view compatibility', () => {
  const build = {
    id: 'view-build',
    status: 'FINISHED',
    platform: 'android',
  };

  const parsed = parseEasBuildFromCommandOutput(
    JSON.stringify([build]),
    'eas build:view view-build',
  );

  assert.deepEqual(parsed, [build]);
});

test('native-build accepts noisy pretty-printed JSON from eas build:list --fingerprint-hash', async (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  const tmp = await mkdtemp(path.join(tmpdir(), 'native-build-json-output-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const outPath = path.join(tmp, 'build-output.json');
  const markerPath = path.join(tmp, 'child-process.calls.jsonl');
  const loaderPath = path.join(tmp, 'loader.mjs');
  const registerPath = path.join(tmp, 'register-loader.mjs');
  await writeFile(markerPath, '', 'utf8');

  const buildListPayload = [
    {
      id: 'build-existing',
      status: 'IN_QUEUE',
      platform: 'ios',
      fingerprint: { hash: 'fp-same' },
      createdAt: '2026-05-17T12:34:56.000Z',
    },
  ];

  const stubBySpecifier = {
    'node:child_process': toDataUrl(`
import { appendFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

function log(call) {
  const markerPath = process.env.HAPPIER_NATIVE_BUILD_MARKER;
  if (!markerPath) return;
  appendFileSync(markerPath, JSON.stringify(call) + '\\n', 'utf8');
}

function createChild(stdoutText, stderrText = '') {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  queueMicrotask(() => {
    if (stdoutText) child.stdout.write(stdoutText);
    child.stdout.end();
    if (stderrText) child.stderr.write(stderrText);
    child.stderr.end();
    child.emit('close', 0, null);
    child.emit('exit', 0, null);
  });
  return child;
}

export function execFileSync(cmd, args, options = {}) {
  log({ kind: 'execFileSync', cmd, args, cwd: options.cwd ?? null });
  if (cmd === 'npx' && args.includes('build:list') && args.includes('--fingerprint-hash')) {
    return [
      'Resolving matching builds...',
      JSON.stringify(${JSON.stringify(buildListPayload)}, null, 2),
      '',
    ].join('\\n');
  }
  throw new Error(\`Unexpected execFileSync call: \${cmd} \${args.join(' ')}\`);
}

export function spawn(cmd, args, options = {}) {
  log({ kind: 'spawn', cmd, args, cwd: options.cwd ?? null });
  if (cmd === 'npx' && args.includes('fingerprint:generate')) {
    return createChild(JSON.stringify({ hash: 'fp-same', sources: [] }));
  }
  throw new Error(\`Unexpected spawn call: \${cmd} \${args.join(' ')}\`);
}
`),
  };

  const loaderSource = `
const stubBySpecifier = ${JSON.stringify(stubBySpecifier)};
export async function resolve(specifier, context, defaultResolve) {
  const stub = stubBySpecifier[specifier];
  if (stub) return { url: stub, shortCircuit: true };
  return defaultResolve(specifier, context, defaultResolve);
}
`;
  await writeFile(loaderPath, loaderSource, 'utf8');
  await writeFile(
    registerPath,
    [
      `import { register } from 'node:module';`,
      `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);`,
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(registerPath, 0o644);

  const result = await runNode(
    [
      '--import',
      registerPath,
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'native-build.mjs'),
      '--platform',
      'ios',
      '--profile',
      'internalpreview',
      '--out',
      outPath,
      '--build-mode',
      'cloud',
      '--fingerprint-mode',
      'if-changed',
      '--wait',
      'false',
      '--dump-view',
      'false',
      '--eas-cli-version',
      'test',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: '1',
        EXPO_TOKEN: 'test-expo-token',
        HAPPIER_NATIVE_BUILD_MARKER: markerPath,
      },
    },
  );

  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const out = JSON.parse(await readFile(outPath, 'utf8'));
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'fingerprint unchanged (no native build needed)');
});
