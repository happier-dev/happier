import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createLocalGitForgeHostConfig, createLocalGitForgeTransport } from '@/testkit/scm/localGitForgeTransport';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createGithubRepositoryRestAdapter } from '../../../../../packages/plugins/scm-github/src/repositoryProvisioning/githubRepositoryRestAdapter';
import { githubHostingProviderAdapter } from '../../../../../packages/plugins/scm-github/src/adapter';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/scm-github/src/manifest';
import { commitGuardedFileReplace } from '@/rpc/handlers/fileSystem/commitGuardedFileReplace';
import { executeScmActionOperation } from './executeScmActionOperation';
import { previewRepositoryForDefinition, provisionRepositoryForDefinition } from './provisionRepositoryForDefinition';
import { prepareRepositoryFilesPullRequest } from './repositoryFilesPullRequest';

describe('repository provisioning review', () => {
  it('previews the seed and branch publication without requiring a checkout or causing Forge effects', () => {
    expect(previewRepositoryForDefinition({ providerKind: 'github', owner: 'alice', repositoryName: 'application', visibility: 'private' }))
      .toMatchObject({ initialBranch: 'main', files: [{ path: 'README.md', content: expect.any(String) }],
        createRepository: { pushCurrentBranch: true } });
  });

  it('previews an existing committed base without promising a new seed', () => {
    expect(previewRepositoryForDefinition({ providerKind: 'github', owner: 'alice', repositoryName: 'application', visibility: 'private' },
      { baseCommit: 'a'.repeat(40), baseBranch: 'personal' }))
      .toMatchObject({ initialBranch: 'personal', files: [], createRepository: { pushCurrentBranch: true } });
  });
});


describe('new repository for a stored definition', () => {
  const hostConfigs: Awaited<ReturnType<typeof createLocalGitForgeHostConfig>>[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(hostConfigs.splice(0).map(config => config.cleanup()));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'definition-provision-'));
    const remote = join(root, 'forge.git');
    await mkdir(remote);
    runScmExecutable(remote, 'git', ['init', '--bare', '-b', 'main']);
    const hostConfig = await createLocalGitForgeHostConfig({ url: 'https://github.com/alice/application.git', remotePath: remote });
    hostConfigs.push(hostConfig);
    vi.stubEnv('GIT_CONFIG_GLOBAL', hostConfig.path);
    // Committer identity and Forge HTTP/token acquisition are actual system
    // boundaries; SCM dispatch, file publication, Git and the provider stay real.
    vi.stubEnv('GIT_AUTHOR_NAME', 'Provision Test');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'provision@example.test');
    vi.stubEnv('GIT_COMMITTER_NAME', 'Provision Test');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'provision@example.test');
    let repositoryCreated = false;
    let rejectCreation = false;
    const adapter = createGithubRepositoryRestAdapter({ resolveToken: async () => ({ kind: 'available', token: 'fixture' }),
      fetcher: async (url, init) => {
        const create = init?.method === 'POST';
        const readAuthenticatedUser = init?.method === 'GET' && new URL(url).pathname === '/user';
        if (create && !rejectCreation) repositoryCreated = true;
        const status = create && rejectCreation ? 403 : readAuthenticatedUser || repositoryCreated ? 200 : 404;
        const body = readAuthenticatedUser ? { login: 'alice' } : status === 200 ? { full_name: 'alice/application', html_url: 'https://github.com/alice/application',
          clone_url: 'https://github.com/alice/application.git', visibility: 'private', default_branch: 'main' } : { message: 'Forbidden' };
        return { ok: status === 200, status, statusText: status === 200 ? 'OK' : 'Forbidden',
          json: async () => body, text: async () => JSON.stringify(body) };
      } });
    const declaration = PLUGIN_MANIFEST.contributes.scmHostingProviders![0]!;
    const { title, ...definition } = declaration;
    const hosting = createScmHostingProviderRegistry({ providers: [{ ...definition, pluginId: PLUGIN_MANIFEST.id,
      displayName: typeof title === 'string' ? title : title.fallback }], runtimeRegistrations: [{
      pluginId: PLUGIN_MANIFEST.id, occurrenceId: 'fixture', registration: { id: declaration.id,
        adapter: { routing: githubHostingProviderAdapter, repositoryPublishing: adapter } },
    }] });
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: registration.id, kind: 'git' }, qualifiedId: `happier.scm.backend.git/${registration.id}`,
      executableDefinition: registration.runtime!, registration,
      scmCommandRunner: createLocalGitForgeTransport({ url: 'https://github.com/alice/application.git', remotePath: remote }),
      hostingProviderRuntimeServices: { resolveScmHostingProviderRegistry: async () => hosting },
    })]);
    // Admission belongs to Move; this is its selected native directory, without Git.
    const checkout = { rootPath: join(root, 'application') };
    await mkdir(checkout.rootPath);
    const host = {
      executeScm: (actionId: Parameters<typeof executeScmActionOperation>[0]['actionId'], input: unknown) =>
        executeScmActionOperation({ actionId, input, registry, workingDirectory: root }),
      writeFile: (input: { rootPath: string; path: string; content: string; expectedHash: string | null }) =>
        commitGuardedFileReplace({ destPath: join(input.rootPath, input.path), expectation: input.expectedHash,
          source: { kind: 'bytes', bytes: Buffer.from(input.content, 'base64') } }),
      deleteFile: async (input: { rootPath: string; path: string; recursive: false }) => {
        await rm(join(input.rootPath, input.path), { recursive: input.recursive });
        return { success: true };
      },
    };
    return { root, remote, checkout, host, created: () => repositoryCreated, rejectCreation: () => { rejectCreation = true; },
      input: { checkout, createRepository: { providerKind: 'github' as const, owner: 'alice', repositoryName: 'application', visibility: 'private' as const } } };
  }

  it('creates and publishes a real base before the shared Compose PR review without an existing Git checkout', async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.checkout.rootPath, 'personal.txt'), 'keep outside the initial commit');
      const provisioned = await provisionRepositoryForDefinition(f.input, f.host);
      expect(provisioned).toMatchObject({ kind: 'provisioned', cwd: f.checkout.rootPath, baseBranch: 'main',
        repository: { kind: 'github', deployment: 'https://github.com', repository: 'alice/application' } });
      if (provisioned.kind !== 'provisioned') throw new Error(JSON.stringify(provisioned));
      expect(f.created()).toBe(true);
      expect(runScmExecutable(f.remote, 'git', ['rev-parse', 'main'])).toBe(provisioned.baseCommit);
      expect(runScmExecutable(f.checkout.rootPath, 'git', ['ls-tree', '--name-only', 'HEAD'])).toBe('README.md');
      expect(await readFile(join(f.checkout.rootPath, 'personal.txt'), 'utf8')).toBe('keep outside the initial commit');
      const review = await prepareRepositoryFilesPullRequest({ ...provisioned, branchName: 'export-staging',
        title: 'Export staging', files: [{ path: 'deploy/staging/compose.yaml', content: 'services: {}\n' }] }, f.host);
      expect(review.files[0]).toMatchObject({ before: null, expectedHash: null, content: 'services: {}\n' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('publishes the existing committed branch without changing its history or adding a seed', async () => {
    const f = await fixture();
    try {
      runScmExecutable(f.checkout.rootPath, 'git', ['init', '-b', 'personal']);
      await writeFile(join(f.checkout.rootPath, 'existing.txt'), 'existing');
      runScmExecutable(f.checkout.rootPath, 'git', ['add', 'existing.txt']);
      runScmExecutable(f.checkout.rootPath, 'git', ['commit', '-m', 'Personal history']);
      const before = runScmExecutable(f.checkout.rootPath, 'git', ['rev-parse', 'HEAD']);
      expect(await provisionRepositoryForDefinition(f.input, f.host)).toMatchObject({ kind: 'provisioned', baseCommit: before, baseBranch: 'personal' });
      expect(runScmExecutable(f.checkout.rootPath, 'git', ['rev-parse', 'HEAD'])).toBe(before);
      expect(runScmExecutable(f.remote, 'git', ['rev-parse', 'personal'])).toBe(before);
      expect(runScmExecutable(f.checkout.rootPath, 'git', ['ls-tree', '--name-only', 'HEAD'])).toBe('existing.txt');
      expect(f.created()).toBe(true);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('preserves an occupied destination and returns its exact failure before Forge creation', async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.checkout.rootPath, 'README.md'), 'keep');
      expect(await provisionRepositoryForDefinition(f.input, f.host)).toMatchObject({ kind: 'partial', phase: 'seed', errorCode: 'expected_file_absent' });
      expect(await readFile(join(f.checkout.rootPath, 'README.md'), 'utf8')).toBe('keep');
      expect(f.created()).toBe(false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('keeps the native checkout and the Forge refusal when remote creation fails', async () => {
    const f = await fixture();
    try {
      f.rejectCreation();
      const result = await provisionRepositoryForDefinition(f.input, f.host);
      expect(result).toMatchObject({ kind: 'partial', phase: 'publish', errorCode: 'REMOTE_REJECTED', cwd: f.checkout.rootPath });
      expect(runScmExecutable(f.checkout.rootPath, 'git', ['ls-tree', '--name-only', 'HEAD'])).toBe('README.md');
      expect(f.created()).toBe(false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
