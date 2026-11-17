import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { startGithubCliBoundary } from './githubCliBoundary';

it('routes authenticated plugin HTTP health through the same external GitHub boundary as native gh', async () => {
  const github = await startGithubCliBoundary();
  const token = 'github_pat_TEST_ONLY_HEALTH_BOUNDARY';
  try {
    // Fresh Node/Undici is the daemon plugin HTTP socket boundary. No internal
    // authentication, health, admission or materialization logic is replaced.
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      const undici = createRequire(${JSON.stringify(fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url)))})('undici/index.js');
      const response = await undici.fetch('https://api.github.com/user', {
        headers: { authorization: 'Bearer ${token}', 'user-agent': 'Happier boundary control' },
      });
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));
    `], { env: { ...process.env, ...github.env } });
    expect(JSON.parse(stdout)).toMatchObject({ status: 200, body: { login: 'team-setup-fixture' } });
    const fingerprint = `sha256:${createHash('sha256').update(token).digest('hex')}`;
    expect(github.entries()).toContainEqual(expect.objectContaining({ path: '/user', authorizationFingerprint: fingerprint }));
  } finally { await github.stop(); }
});
