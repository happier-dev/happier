import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GITHUB_SCM_HOSTING_PROVIDER_ID } from '../../../plugins/scm-github/src/adapter';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { startConnectedAccountTlsRecordingProxy } from '../../src/testkit/providers/connectedAccountTlsRecordingProxy';
import { sanitizeCliTestEnv } from '../../src/testkit/process/cliTestEnv';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

const run = createRunDirs({ runLabel: 'triage-runtime-clone' });
const repositoryUrl = 'https://github.com/triage-journey/repair.git';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('Triage runtime: repair a failed repository checkout', () => {
  const testDir = run.testDir(randomUUID());
  const source = join(testDir, 'source');
  const remote = join(testDir, 'upstream.git');
  const destinations = join(testDir, 'projects');
  let homeDir: string;
  let requestedHead: string;
  let env: NodeJS.ProcessEnv;
  let machineId: string;
  let serverId: string;
  let fixture: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;
  let github: Awaited<ReturnType<typeof startConnectedAccountTlsRecordingProxy>> | undefined;

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const close of [() => fixture?.stop(), () => github?.stop()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Clone journey cleanup failed');
  });

  beforeAll(async () => {
    await mkdir(source, { recursive: true });
    await mkdir(destinations);
    git(source, 'init', '-b', 'main');
    git(source, 'config', 'user.name', 'Clone journey fixture');
    git(source, 'config', 'user.email', 'clone-journey@example.test');
    await writeFile(join(source, 'README.md'), 'main branch\n');
    git(source, 'add', 'README.md');
    git(source, 'commit', '-m', 'main');
    git(testDir, 'clone', '--bare', source, remote);
    git(source, 'checkout', '-b', 'repair');
    await writeFile(join(source, 'README.md'), 'requested repair branch\n');
    git(source, 'commit', '-am', 'repair');
    git(source, 'push', remote, 'repair');
    requestedHead = git(source, 'rev-parse', 'HEAD');
    const gitConfig = join(testDir, 'gitconfig');
    await writeFile(gitConfig, `[url "${pathToFileURL(remote).href}"]\n\tinsteadOf = ${repositoryUrl}\n`);

    // GitHub REST repository metadata is the external provider boundary.
    github = await startConnectedAccountTlsRecordingProxy({ additionalDnsNames: ['api.github.com'],
      responseForRequest(request) {
        if (request.method === 'GET' && request.path === '/repos/triage-journey/repair') return {
          statusCode: 200, body: { id: 1116, full_name: 'triage-journey/repair',
            html_url: 'https://github.com/triage-journey/repair', clone_url: repositoryUrl,
            ssh_url: 'git@github.com:triage-journey/repair.git', default_branch: 'main', visibility: 'public', private: false },
        };
        return { statusCode: 404, body: { message: 'Not Found' } };
      } });
    const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
      'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
    env = { ...sanitizeCliTestEnv(process.env),
      NODE_OPTIONS: `${sourceOptions} --import ${pathToFileURL(join(repoRootDir(),
        'packages/tests/suites/core-e2e/triage.runtime.github.preload.mjs')).href}`,
      CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      HAPPIER_E2E_TRIAGE_GITHUB_PROXY: github.url, HAPPIER_E2E_TRIAGE_GITHUB_CA: github.caCertPath,
      GH_CONFIG_DIR: join(testDir, 'gh-home'), GH_HOST: 'github.com', GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '',
      // Redirect only this constructed public URL to an actual isolated bare Git repository.
      GIT_CONFIG_GLOBAL: gitConfig,
    };
    fixture = await startProjectDaemonFixture({ testDir, daemonEnv: env });
    const account = await fixture.createAccount('clone-owner');
    const machine = await fixture.enrollDaemon(account, { env });
    homeDir = machine.homeDir;
    machineId = machine.target.machineId;
    serverId = machine.target.serverId;
    env = { ...env, HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: fixture.server.baseUrl,
      HAPPIER_WEBAPP_URL: fixture.server.baseUrl };
  });

  it('preserves retained work after a failed ref, refuses reuse, and opens the requested ref in a fresh folder', async () => {
    const launch = await resolveCliTestLaunchSpec({ testDir, env }, { snapshotDir: join(testDir, 'cli-dist'),
      preferSourceEntrypoint: true, skipSourceFreshnessCheck: true });
    const open = (ref: string, directory: string) => runCliJson({ testDir, cliHomeDir: homeDir,
      serverUrl: fixture!.server.baseUrl, webappUrl: fixture!.server.baseUrl, env, label: `open-${directory}-${ref}`,
      cliLaunchSpec: launch, acceptedExitCodes: [0, 1], args: ['actions', 'invoke', 'projects.open', '--input-json', JSON.stringify({
      serverId, machineId,
      source: { kind: 'repository', selector: { provider: { id: GITHUB_SCM_HOSTING_PROVIDER_ID, kind: 'github',
        displayName: 'GitHub', baseUrl: 'https://github.com' }, repository: { nameWithOwner: 'triage-journey/repair',
        webUrl: 'https://github.com/triage-journey/repair', cloneUrl: repositoryUrl,
        defaultBranch: 'main', visibility: 'public' }, protocol: 'https' } }, ref,
      materialization: { kind: 'clone', destinationParentPath: destinations, destinationDirectoryName: directory },
    }), '--server-id', serverId, '--machine-id', machineId, '--yes', '--json'] });

    // Prove this Account, Machine and repository boundary can open a valid ref
    // before attributing a refusal on the same path to the failed-ref contract.
    const control = await open('main', 'control-main');
    await writeFile(join(testDir, 'control-main.result.json'), JSON.stringify(control, null, 2));
    expect(control, JSON.stringify(control)).toMatchObject({ ok: true, data: { kind: 'opened' } });
    const failed = await open('nonexistent-ref', 'failed-ref');
    await writeFile(join(testDir, 'failed-ref.result.json'), JSON.stringify(failed, null, 2));
    expect(failed, JSON.stringify(failed)).toMatchObject({
      ok: false, kind: 'actions_invoke', error: {
        code: 'COMMAND_FAILED', details: { kind: 'refused', effectAttempted: true },
        failureCause: { phase: 'project_open.checkout_ref' },
      },
    });
    const retained = join(destinations, 'failed-ref');
    const retainedHead = git(retained, 'rev-parse', 'HEAD');
    expect(retainedHead).not.toBe(requestedHead);
    expect(git(retained, 'remote', 'get-url', 'origin')).toBe(repositoryUrl);
    const sentinel = Buffer.from([0, 255, 13, 10, 128]);
    await writeFile(join(retained, 'unfinished.bin'), sentinel);
    const beforeConfig = await readFile(join(retained, '.git', 'config'));
    expect(await open('repair', 'failed-ref')).toMatchObject({
      ok: false, kind: 'actions_invoke', error: {
        code: 'destination_exists', details: { kind: 'refused' },
      },
    });
    expect(git(retained, 'rev-parse', 'HEAD')).toBe(retainedHead);
    expect(await readFile(join(retained, '.git', 'config'))).toEqual(beforeConfig);
    expect(await readFile(join(retained, 'unfinished.bin'))).toEqual(sentinel);
    expect(await open('repair', 'repaired-ref')).toMatchObject({ ok: true, data: { kind: 'opened' } });
    expect(git(join(destinations, 'repaired-ref'), 'rev-parse', 'HEAD')).toBe(requestedHead);
    expect(await readFile(join(destinations, 'repaired-ref', 'README.md'), 'utf8')).toBe('requested repair branch\n');
    expect(github!.entries()).toEqual(expect.arrayContaining([expect.objectContaining({
      method: 'GET', path: '/repos/triage-journey/repair', authorizationFingerprint: null,
    })]));
  });
});
