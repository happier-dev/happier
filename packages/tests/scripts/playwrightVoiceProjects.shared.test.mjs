import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  buildVoicePlaywrightProjects,
  resolveVoicePlaywrightFixturePath,
} from './playwrightVoiceProjects.shared.mjs';

const fixturePath = resolve('fixtures/voice/phrases/long-utterance.16k.wav');

test('voice browser projects prove distinct input, permission, and output layers', () => {
  const projects = buildVoicePlaywrightProjects({ fixturePath });
  assert.deepEqual(projects.map((project) => project.name), [
    'voice-q2-fake-mic',
    'voice-q3-permissions-denied',
    'voice-q3-permissions-granted',
    'voice-q4-output',
  ]);

  const fakeMic = projects[0];
  assert.deepEqual(fakeMic.use.permissions, ['microphone']);
  assert.equal(fakeMic.metadata.voiceQaFixturePath, fixturePath);
  assert.ok(fakeMic.use.launchOptions.args.includes('--use-fake-ui-for-media-stream'));
  assert.ok(fakeMic.use.launchOptions.args.includes('--use-fake-device-for-media-stream'));
  assert.ok(fakeMic.use.launchOptions.args.includes(`--use-file-for-fake-audio-capture=${fixturePath}`));
  assert.ok(fakeMic.use.launchOptions.args.includes(
    '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox',
  ));
  assert.ok(!fakeMic.use.launchOptions.args.includes('--mute-audio'));

  const deniedPermissions = projects[1];
  assert.deepEqual(deniedPermissions.use.permissions, []);
  assert.ok(!deniedPermissions.use.launchOptions.args.includes('--use-fake-ui-for-media-stream'));
  assert.ok(deniedPermissions.use.launchOptions.args.includes('--use-fake-device-for-media-stream'));
  assert.ok(!deniedPermissions.use.launchOptions.args.includes(
    '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox',
  ));
  assert.ok(!deniedPermissions.use.launchOptions.args.some((arg) => arg.startsWith('--use-file-for-fake-audio-capture=')));
  assert.match('explicit denial', deniedPermissions.grep);
  assert.doesNotMatch('explicit grant', deniedPermissions.grep);
  assert.doesNotMatch('revoking permission', deniedPermissions.grep);

  const grantedPermissions = projects[2];
  assert.deepEqual(grantedPermissions.use.permissions, []);
  assert.ok(grantedPermissions.use.launchOptions.args.includes('--use-fake-ui-for-media-stream'));
  assert.ok(grantedPermissions.use.launchOptions.args.includes('--use-fake-device-for-media-stream'));
  assert.ok(!grantedPermissions.use.launchOptions.args.includes(
    '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox',
  ));
  assert.ok(!grantedPermissions.use.launchOptions.args.some((arg) => arg.startsWith('--use-file-for-fake-audio-capture=')));
  assert.match('explicit grant', grantedPermissions.grep);
  assert.doesNotMatch('explicit denial', grantedPermissions.grep);
  assert.match('revoking permission', grantedPermissions.grep);

  const output = projects[3];
  assert.deepEqual(output.use.permissions, ['microphone']);
  assert.ok(output.use.launchOptions.args.includes(`--use-file-for-fake-audio-capture=${fixturePath}`));
  assert.ok(output.use.launchOptions.args.includes(
    '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox',
  ));
  assert.ok(!output.use.launchOptions.args.includes('--mute-audio'));
  assert.equal(output.metadata.happierVoiceOutputCapture, true);
});

test('the canonical Voice E2E scripts select the dedicated Playwright config', async () => {
  const testsPackage = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const rootPackage = JSON.parse(await readFile(resolve('../..', 'package.json'), 'utf8'));

  assert.equal(
    testsPackage.scripts['test:ui:e2e:voice'],
    'node scripts/run-playwright-with-heartbeat.mjs --config playwright.voice.config.mjs',
  );
  assert.equal(
    rootPackage.scripts['test:e2e:ui:voice'],
    'yarn --cwd packages/tests -s test:ui:e2e:voice',
  );
});

test('voice browser projects require an absolute fixture path', () => {
  assert.throws(
    () => buildVoicePlaywrightProjects({ fixturePath: 'fixtures/voice/phrases/short-command.24k.wav' }),
    /absolute/,
  );
});

test('voice browser projects can use an explicit installed browser channel', () => {
  const projects = buildVoicePlaywrightProjects({ fixturePath, browserChannel: 'chrome' });
  for (const project of projects) {
    assert.equal(project.use.channel, 'chrome');
  }
});

test('voice fixture defaults are config-relative while explicit paths are cwd-relative', () => {
  const configDir = resolve('/repo/packages/tests');
  const cwd = resolve('/repo');

  assert.equal(
    resolveVoicePlaywrightFixturePath({ configuredPath: undefined, configDir, cwd }),
    resolve(configDir, 'fixtures/voice/phrases/long-utterance.16k.wav'),
  );
  assert.equal(
    resolveVoicePlaywrightFixturePath({ configuredPath: 'custom/voice.wav', configDir, cwd }),
    resolve(cwd, 'custom/voice.wav'),
  );
});

test('voice browser projects fail before Playwright launch when the fixture is missing or not a file', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'happier-voice-playwright-projects-'));
  try {
    assert.throws(
      () => buildVoicePlaywrightProjects({ fixturePath: join(testDir, 'missing.wav') }),
      /does not exist/,
    );

    const fixturePath = join(testDir, 'fixture.wav');
    await writeFile(fixturePath, Buffer.from('fixture'));
    assert.equal(buildVoicePlaywrightProjects({ fixturePath }).length, 4);
    assert.throws(
      () => buildVoicePlaywrightProjects({ fixturePath: testDir }),
      /regular file/,
    );
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});
