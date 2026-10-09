import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAndroidAabFixture } from '../pipeline/expo/fixtures/android-elf.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

test('expo submit attempts every requested prerelease platform but reports any submission failure', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-expo-submit-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const uiDir = path.join(dir, 'apps', 'ui');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'apps', 'ui', 'eas.json'), path.join(uiDir, 'eas.json'));
  const aabPath = createAndroidAabFixture(dir);
  const build = { id: 'exact-build', platform: 'ANDROID', status: 'FINISHED', createdAt: '2026-10-09T10:00:00Z', appVersion: '1.2.3', appBuildVersion: '4242', artifacts: { applicationArchiveUrl: 'https://fixture.example/build.aab' } };
  const preloadPath = path.join(dir, 'preload.mjs');
  fs.writeFileSync(preloadPath, `import {readFileSync} from 'node:fs'; globalThis.fetch = async (url) => { if (url !== 'https://fixture.example/build.aab') throw new Error('Unexpected HTTP boundary'); return new Response(readFileSync(${JSON.stringify(aabPath)})); };`);

  const npxPath = path.join(binDir, 'npx');
  writeExecutable(
    npxPath,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      `if (args.includes('build:list')) { console.log(JSON.stringify(args[args.indexOf('--status') + 1] === 'finished' ? [${JSON.stringify(build)}] : [])); process.exit(0); }`,
      `if (args.includes('build:view')) { console.log(JSON.stringify(${JSON.stringify(build)})); process.exit(0); }`,
      'if (!args.includes("submit")) throw new Error("Unexpected EAS boundary");',
      'console.log("NPX " + args.join(" "));',
      'process.exit(1);',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    EXPO_TOKEN: 'test-token',
    APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
  };

  for (const environment of ['preview', 'dev']) {
    const result = spawnSync(
      process.execPath,
      [
        '--import', preloadPath,
        path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'submit.mjs'),
        '--environment',
        environment,
        '--platform',
        'all',
      ],
      { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    );

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /NPX .*submit --platform ios/);
    assert.match(result.stdout, /NPX .*submit --platform android/);
    assert.match(result.stdout, new RegExp(`::warning::Expo submit failed for ios in ${environment}`));
    assert.match(result.stdout, new RegExp(`::warning::Expo submit failed for android in ${environment}`));
  }
});
