import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

it('routes real gh and authenticated Git through the explicit native child HTTPS boundary', async () => {
  const github = await startGithubCliBoundary();
  const home = await mkdtemp(join(tmpdir(), 'github-native-boundary-'));
  const token = 'github_pat_TEST_ONLY_NATIVE_BOUNDARY';
  try {
    const globalConfig = join(home, 'gitconfig');
    const ghConfig = join(home, 'gh');
    await mkdir(ghConfig);
    await writeFile(globalConfig, '');
    // Agent native launches have a deliberately narrow environment. The HTTPS
    // substitute belongs at these actual third-party process boundaries.
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
      GH_CONFIG_DIR: ghConfig, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GH_TOKEN: token, ...github.env };
    const execute = promisify(execFile);
    const gh = await execute('gh', ['api', 'user'], { env });
    expect(JSON.parse(gh.stdout)).toMatchObject({ login: 'team-setup-fixture' });
    const status = await execute('gh', ['auth', 'status', '--hostname', 'github.com'], { env });
    expect(status.stdout + status.stderr).toContain('team-setup-fixture');
    // This characterizes GitHub's native helper protocol, not Happier's
    // materializer: the existing launch owner tests cover its process config.
    await execute('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
      'ls-remote', 'https://github.com/team-setup/fixture.git'], { env });
    const fingerprint = `sha256:${createHash('sha256').update(`Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`).digest('hex')}`;
    expect(github.entries()).toContainEqual(expect.objectContaining({
      path: '/team-setup/fixture.git/info/refs?service=git-upload-pack', authorizationFingerprint: fingerprint,
    }));
  } finally { await github.stop(); await rm(home, { recursive: true, force: true }); }
});
