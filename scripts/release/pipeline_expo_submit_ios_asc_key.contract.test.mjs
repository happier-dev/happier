import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'happier-expo-submit-asc-'));
}

test('expo-submit ensures the iOS App Store Connect API key file exists (dry-run)', () => {
  const dir = makeTempDir();
  const uiDir = path.join(dir, 'apps', 'ui');
  fs.mkdirSync(uiDir, { recursive: true });

  const keyId = '58Q493BG53';
  fs.writeFileSync(
    path.join(uiDir, 'eas.json'),
    JSON.stringify(
      {
        submit: {
          preview: {
            ios: {
              appleId: 'test@example.com',
              ascAppId: '123',
              appleTeamId: 'TEAM',
              ascApiKeyId: keyId,
              ascApiKeyIssuerId: 'issuer',
              ascApiKeyPath: `./.eas/keys/AuthKey_${keyId}.p8`,
            },
          },
        },
      },
      null,
      2,
    ),
  );

  const env = {
    ...process.env,
    EXPO_TOKEN: 'test-token',
    APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
  };

  const stdout = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'submit.mjs'),
      '--environment',
      'preview',
      '--platform',
      'ios',
      '--dry-run',
    ],
    {
      cwd: dir,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(stdout, /expo submit: environment=preview platform=ios/);
  assert.match(stdout, new RegExp(`\\[dry-run\\] ensure ASC API key file at: .*AuthKey_${keyId}\\.p8`));
  assert.equal(fs.existsSync(path.join(uiDir, '.eas', 'keys', `AuthKey_${keyId}.p8`)), false);
});
