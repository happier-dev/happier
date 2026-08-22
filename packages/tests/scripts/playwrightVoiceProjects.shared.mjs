import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

function fakeMediaArgs(fixturePath, { autoGrant }) {
  const args = ['--use-fake-device-for-media-stream'];
  if (autoGrant) args.unshift('--use-fake-ui-for-media-stream');
  if (fixturePath) {
    args.push(
      '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox',
      `--use-file-for-fake-audio-capture=${fixturePath}`,
    );
  }
  return args;
}

export function buildVoicePlaywrightProjects({ fixturePath, browserChannel }) {
  if (!isAbsolute(fixturePath)) {
    throw new Error('voice fixture path must be absolute');
  }
  let fixtureStat;
  try {
    fixtureStat = statSync(fixturePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`voice fixture does not exist: ${fixturePath}`);
    }
    throw error;
  }
  if (!fixtureStat.isFile()) {
    throw new Error(`voice fixture must be a regular file: ${fixturePath}`);
  }
  const channel = typeof browserChannel === 'string' && browserChannel.trim()
    ? browserChannel.trim()
    : null;

  return [
    {
      name: 'voice-q2-fake-mic',
      testMatch: /voice\.media\..*\.spec\.ts/,
      metadata: {
        voiceQaLayer: 'file-backed microphone input',
        voiceQaFixturePath: fixturePath,
      },
      use: {
        ...(channel ? { channel } : {}),
        permissions: ['microphone'],
        launchOptions: { args: fakeMediaArgs(fixturePath, { autoGrant: true }) },
      },
    },
    {
      name: 'voice-q3-permissions-denied',
      testMatch: /voice\.permissions\..*\.spec\.ts/,
      grep: /explicit denial|prompt\/unknown|device removal|contention/,
      metadata: { voiceQaLayer: 'browser permission denial, revocation, and device lifecycle' },
      use: {
        ...(channel ? { channel } : {}),
        permissions: [],
        launchOptions: { args: fakeMediaArgs(null, { autoGrant: false }) },
      },
    },
    {
      name: 'voice-q3-permissions-granted',
      testMatch: /voice\.permissions\..*\.spec\.ts/,
      grep: /explicit grant|revoking permission/,
      metadata: { voiceQaLayer: 'browser permission grant and production capture lifecycle' },
      use: {
        ...(channel ? { channel } : {}),
        permissions: [],
        launchOptions: { args: fakeMediaArgs(null, { autoGrant: true }) },
      },
    },
    {
      name: 'voice-q4-output',
      testMatch: /voice\.output\..*\.spec\.ts/,
      metadata: {
        voiceQaLayer: 'unmuted browser output sink',
        happierVoiceOutputCapture: true,
      },
      use: {
        ...(channel ? { channel } : {}),
        permissions: ['microphone'],
        launchOptions: { args: fakeMediaArgs(fixturePath, { autoGrant: true }) },
      },
    },
  ];
}

export function resolveVoicePlaywrightFixturePath({ configuredPath, configDir, cwd }) {
  const explicitPath = configuredPath?.trim();
  return explicitPath
    ? resolve(cwd, explicitPath)
    : resolve(configDir, 'fixtures/voice/phrases/long-utterance.16k.wav');
}
