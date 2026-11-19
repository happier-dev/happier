import { describe, expect, it, onTestFinished, vi } from 'vitest';
import * as childProcess from 'child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import { PluginPublicationGithubResultSchema, type PluginPublicationGithubInput } from '@happier-dev/protocol/actions/actionSpecs';
import { executeGithubReleaseOperationV1 } from '../../../../../packages/plugins/scm-github/src/releases/operations';
import { createStubGithubTransport, readRecordedJsonBody } from '../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support';
import { inspectPluginPublicationGithub, publishPluginGithub, type PluginGithubActionDependencies } from './publishGithub';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import type { ScmCommandRunner } from '@/scm/runtime';
import { createScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import { githubHostingProviderAdapter } from '../../../../../packages/plugins/scm-github/src/adapter';
import { createGithubRepositoryProvisioningAdapter } from '../../../../../packages/plugins/scm-github/src/repositoryProvisioning/createRepositoryWithAuthFallback';
import { createGithubRepositoryRestAdapter } from '../../../../../packages/plugins/scm-github/src/repositoryProvisioning/githubRepositoryRestAdapter';
import { createScmHostingProviderRuntimeServicesForTest } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';

vi.mock('child_process', async importOriginal => ({ ...await importOriginal<typeof childProcess>(), spawn: vi.fn() }));

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
const selection: PluginPublicationGithubInput = { repository, release: {
    tagName: 'v7', targetCommitish: 'main', name: 'Release 7', body: 'Reviewed notes', prerelease: false, makeLatest: 'false',
} };

function harness(options: { changed?: boolean; assets?: boolean; lostReply?: boolean; rejectCreate?: boolean } = {}) {
    let published = false;
    let reads = 0;
    const release = () => ({ id: 7, tag_name: 'v7', target_commitish: 'main', name: 'Release 7',
        body: options.changed && reads > 0 ? 'Changed externally' : 'Reviewed notes', draft: !published,
        prerelease: false, created_at: '2026-10-24T10:00:00Z', updated_at: '2026-10-24T10:00:00Z',
        published_at: published ? '2026-10-24T11:00:00Z' : null,
        html_url: 'https://github.com/acme/widgets/releases/7', assets: [],
    });
    const transport = createStubGithubTransport({
        nativeMaterialization: { kind: 'httpHeaders', headers: { authorization: 'Bearer synthetic-fixture' } },
        respond(request) {
            const path = new URL(request.url).pathname;
            if (path === '/repos/acme/widgets') return { status: 200, body: { id: 42, full_name: 'acme/widgets', private: false } };
            if (request.method === 'POST') return options.rejectCreate ? { status: 403 } : { status: 201, body: release() };
            if (request.method === 'PATCH') {
                published = true;
                if (options.lostReply) throw new Error('synthetic-secret-in-transport-error');
                return { status: 200, body: release() };
            }
            if (path.endsWith('/assets')) return { status: 200, body: options.assets
                ? [{ id: 1, name: 'unreviewed.zip', content_type: 'application/zip', size: 10, state: 'uploaded' }] : [] };
            reads += 1;
            return { status: 200, body: release() };
        },
    });
    const dependencies: PluginGithubActionDependencies = {
        executeScm: async () => { throw new Error('Unexpected SCM effect'); },
        invokeGithub: async ({ actionId, input }) => {
            switch (actionId) {
                case 'github/releases/draft-create': return executeGithubReleaseOperationV1('createReleaseDraft', input, transport.context);
                case 'github/releases/release-read': return executeGithubReleaseOperationV1('readRelease', input, transport.context);
                case 'github/releases/draft-publish': return executeGithubReleaseOperationV1('publishReleaseDraft', input, transport.context);
            }
        },
    };
    return { ...transport, dependencies };
}

async function sourceHarness(options: { failPush?: boolean; failSelectedAdd?: boolean; failRefresh?: boolean } = {}) {
    const directory = createHappierTempDir({ purpose: 'plugin-publish-source' });
    onTestFinished(() => removeHappierTempDirAsync(directory));
    await mkdir(join(directory, '.git'));
    await writeFile(join(directory, 'unrelated.txt'), 'uncommitted work');
    const commands: Parameters<ScmCommandRunner>[0][] = [];
    const oid = 'a'.repeat(40);
    let pushed = false;
    // Only the OS process boundary is synthetic. Selection, capability admission,
    // temporary-index commits, remote guards and outcome classification stay real.
    const runner: ScmCommandRunner = async input => {
        commands.push(input);
        const { args } = input;
        const response = (stdout = '', exitCode = 0, stderr = '') => ({ success: exitCode === 0, stdout, stderr, exitCode });
        if (args.includes('--is-inside-work-tree')) return response(args.includes('--show-toplevel') ? `true\n${directory}\n` : 'true\n');
        if (args.includes('--show-object-format')) return response(`${join(directory, '.git', 'objects')}\nsha1\n`);
        if (args[0] === 'status') return pushed && options.failRefresh ? response('', 1, 'refresh unavailable')
            : response(`# branch.oid ${oid}\0# branch.head main\0`);
        if (args.includes('--git-common-dir')) return response(join(directory, '.git'));
        if (args.includes('--git-path')) return response(args.flatMap((arg, index) => arg === '--git-path' ? [join(directory, '.git', args[index + 1]!)] : []).join('\n'));
        if (args[0] === 'symbolic-ref') return response('refs/heads/main\n');
        if (args[0] === 'rev-parse' || args.includes('rev-parse')) return response(`${oid}\n`);
        if (args[0] === 'config') return args.includes('--list') ? response() : response('', 1);
        if (args[0] === 'remote' && args.includes('get-url')) return response('https://github.com/acme/widgets.git\n');
        if (args[0] === 'remote' && args.includes('-v')) return response('origin\tgit@github.com:Acme/Widgets.git (fetch)\norigin\tgit@github.com:Acme/Widgets.git (push)\n');
        if (args[0] === 'push') { pushed = true; return options.failPush ? response('', 128, 'fatal: unable to access remote: Could not resolve host: private-host') : response(); }
        if (args[0] === 'add') return response('', options.failSelectedAdd ? 1 : 0, 'selected path unavailable');
        return response();
    };
    // The host's credentialed push transport intentionally bypasses workspace
    // runners. Its genuine OS spawn boundary is synthetic as well.
    const spawn = vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
        void runner({ bin: String(command), args: Array.isArray(args) ? [...args] : [],
            cwd: String(options?.cwd ?? directory), env: options?.env }).then(result => {
            child.stdout.emit('data', Buffer.from(result.stdout)); child.stderr.emit('data', Buffer.from(result.stderr));
            child.emit('close', result.exitCode);
        });
        // Synthetic Node process is the narrowly untyped OS fixture boundary.
        return child as unknown as childProcess.ChildProcess;
    });
    onTestFinished(() => { spawn.mockReset(); });
    const repositoryRequests: { url: string; method: string }[] = [];
    let repositoryCreated = false;
    const repositoryPublishing = createGithubRepositoryProvisioningAdapter({ restAdapter: createGithubRepositoryRestAdapter({
        resolveToken: async () => ({ kind: 'available', token: 'synthetic-provisioning-fixture' }),
        fetcher: async (url, init) => {
            repositoryRequests.push({ url, method: init?.method ?? 'GET' });
            if (init?.method === 'POST') repositoryCreated = true;
            const status = url.includes('/repos/') && !repositoryCreated ? 404 : init?.method === 'POST' ? 201 : 200;
            const body = url.endsWith('/user') ? { login: 'acme', name: 'Acme' }
                : url.endsWith('/user/orgs') ? []
                : { id: 42, full_name: 'acme/widgets', html_url: 'https://github.com/acme/widgets',
                    clone_url: 'https://github.com/acme/widgets.git', ssh_url: 'git@github.com:acme/widgets.git', private: false };
            return { ok: status < 400, status, statusText: status < 400 ? 'OK' : 'Not Found',
                json: async () => body, text: async () => JSON.stringify(body) };
        },
    }) });
    const hostingProviderRegistry = createScmHostingProviderRegistry({
        providers: [{ id: 'github', pluginId: 'happier.scm.forge.github', kind: 'github', displayName: 'GitHub', capabilities: [] }],
        runtimeRegistrations: [{ pluginId: 'happier.scm.forge.github', occurrenceId: 'source-test',
            registration: { id: 'github', adapter: { routing: githubHostingProviderAdapter, repositoryPublishing } } }],
    });
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
        qualifiedId: 'happier.scm.backend.git/git', executableDefinition: registration.runtime!, registration, scmCommandRunner: runner,
        hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(hostingProviderRegistry) })]);
    const executeScm: PluginGithubActionDependencies['executeScm'] = request => executeScmActionOperation({ ...request, workingDirectory: directory, registry, hostingProviderRegistry });
    return { directory, commands, executeScm, registry, hostingProviderRegistry, repositoryRequests };
}

describe('optional plugin GitHub publication through existing release owners', () => {
    it('inspects the real selected repository without performing source mutations', async () => {
        const source = await sourceHarness();
        const result = await inspectPluginPublicationGithub({ directory: source.directory, registry: source.registry, hostingProviderRegistry: source.hostingProviderRegistry });
        expect(result).toMatchObject({ status: 'ready', branch: 'main', remote: 'origin', repository });
        expect(result.publishTargets).toMatchObject({ success: true, auth: { state: 'authenticated' },
            targets: [{ owner: 'acme', supportedVisibilities: ['private', 'public'] }] });
        expect(source.repositoryRequests.every(request => request.method === 'GET')).toBe(true);
        expect(source.commands.some(command => ['add', 'commit', 'push'].includes(command.args[0]!))).toBe(false);
        expect(await readFile(join(source.directory, 'unrelated.txt'), 'utf8')).toBe('uncommitted work');
    });
    it('publishes exactly the reviewed notes and exposes only public outcome facts', async () => {
        const h = harness();
        const result = await publishPluginGithub({ directory: '/selected', selection, ...h.dependencies });
        expect(PluginPublicationGithubResultSchema.parse(result)).toMatchObject({ status: 'published', phase: 'release',
            pushed: false, releaseId: '7', releaseUrl: 'https://github.com/acme/widgets/releases/7' });
        expect(h.requests.filter(request => request.method === 'POST' || request.method === 'PATCH').map(readRecordedJsonBody))
            .toEqual([{ tag_name: 'v7', target_commitish: 'main', name: 'Release 7', body: 'Reviewed notes', prerelease: false, draft: true },
                { draft: false, make_latest: 'false' }]);
    });

    it('creates the selected public repository through SCM without an implicit source push', async () => {
        const h = harness();
        const source = await sourceHarness();
        const result = await publishPluginGithub({ directory: source.directory, selection: { repository,
            createRepository: { providerKind: 'github', owner: 'acme', ownerKind: 'user', repositoryName: 'widgets',
                visibility: 'public', remoteName: 'published', remoteUrlKind: 'https' } },
            ...h.dependencies, executeScm: source.executeScm });
        expect(result, JSON.stringify(result)).toMatchObject({ status: 'published', phase: 'repository', pushed: false,
            repositoryUrl: 'https://github.com/acme/widgets' });
        expect(source.repositoryRequests.filter(request => request.method === 'POST')).toHaveLength(1);
        expect(source.commands.some(command => ['add', 'commit', 'push'].includes(command.args[0]!))).toBe(false);
        expect(h.requests).toHaveLength(0);
        expect(await readFile(join(source.directory, 'unrelated.txt'), 'utf8')).toBe('uncommitted work');
    });

    it('retains the created repository when attaching its remote needs explicit replacement consent', async () => {
        const h = harness();
        const source = await sourceHarness();
        const result = await publishPluginGithub({ directory: source.directory, selection: { ...selection,
            createRepository: { providerKind: 'github', owner: 'acme', ownerKind: 'user', repositoryName: 'widgets',
                visibility: 'public', remoteName: 'origin', remoteUrlKind: 'https' } },
            ...h.dependencies, executeScm: source.executeScm });
        expect(result, JSON.stringify(result)).toMatchObject({ status: 'partial', phase: 'repository', pushed: false,
            repositoryUrl: 'https://github.com/acme/widgets', errorCode: 'REMOTE_ALREADY_EXISTS' });
        expect(source.repositoryRequests.filter(request => request.method === 'POST')).toHaveLength(1);
        expect(h.requests).toHaveLength(0);
        expect(source.commands.some(command => ['add', 'commit', 'push'].includes(command.args[0]!))).toBe(false);
    });

    it.each([{ changed: true }, { assets: true }])('lets the release owner refuse unreviewed provider changes %j', async options => {
        const h = harness(options);
        const result = await publishPluginGithub({ directory: '/selected', selection, ...h.dependencies });
        expect(result).toMatchObject({ status: 'conflict', phase: 'release', releaseId: '7' });
        expect(h.requests.filter(request => request.method === 'PATCH')).toHaveLength(0);
    });

    it('retains a pushed ref when GitHub rejects a draft, without retrying the write', async () => {
        const h = harness({ rejectCreate: true });
        const source = await sourceHarness();
        const result = await publishPluginGithub({ directory: source.directory, selection: { ...selection, source: { remote: 'origin', branch: 'main' } },
            ...h.dependencies, executeScm: source.executeScm });
        expect(result).toMatchObject({ status: 'partial', pushed: true, phase: 'release' });
        expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
        const pushes = source.commands.filter(command => command.args[0] === 'push');
        expect(pushes).toHaveLength(1);
        expect(pushes[0]!.args.filter(argument => !argument.startsWith('-'))).toEqual(['push', 'origin', 'main']);
        expect(pushes.some(command => command.args.some(argument => argument.startsWith('--force')))).toBe(false);
        expect(await readFile(join(source.directory, 'unrelated.txt'), 'utf8')).toBe('uncommitted work');
    });

    it('preserves unknown publication outcome and never leaks the transport exception or replays it', async () => {
        const h = harness({ lostReply: true });
        const result = await publishPluginGithub({ directory: '/selected', selection, ...h.dependencies });
        expect(result).toMatchObject({ status: 'outcome_unknown', phase: 'release', releaseId: '7' });
        expect(JSON.stringify(result)).not.toContain('synthetic-secret');
        expect(h.requests.filter(request => request.method === 'PATCH')).toHaveLength(1);
    });

    it('deliberately resumes the selected saved draft without creating another draft or replaying source effects', async () => {
        const h = harness();
        const result = await publishPluginGithub({ directory: '/selected', selection: { ...selection,
            release: { ...selection.release!, releaseId: '7' } }, ...h.dependencies,
            executeScm: async () => { throw new Error('Source must not be replayed'); } });
        expect(result.status).toBe('published');
        expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(0);
        expect(h.requests.filter(request => request.method === 'PATCH')).toHaveLength(1);
    });

    it('stops at an uncertain source push and preserves the SCM code without calling GitHub', async () => {
        const h = harness();
        const source = await sourceHarness({ failPush: true });
        const result = await publishPluginGithub({ directory: source.directory, selection: { ...selection, source: { remote: 'origin', branch: 'main' } },
            ...h.dependencies, executeScm: source.executeScm });
        expect(result).toMatchObject({ status: 'outcome_unknown', phase: 'push', errorCode: 'REMOTE_NETWORK_FAILED', pushed: false });
        expect(h.requests).toHaveLength(0);
        expect(JSON.stringify(result)).not.toContain('private-host');
    });

    it('limits a failed commit to reviewed paths in a temporary index and preserves unrelated work', async () => {
        const h = harness();
        const source = await sourceHarness({ failSelectedAdd: true });
        const result = await publishPluginGithub({ directory: source.directory, selection: { ...selection,
            source: { remote: 'origin', branch: 'main', commit: { message: 'Reviewed source', paths: ['src/plugin.ts'] } } },
            ...h.dependencies, executeScm: source.executeScm });
        expect(result).toMatchObject({ status: 'failed', phase: 'commit', pushed: false });
        const selectedAdds = source.commands.filter(command => command.args[0] === 'add');
        expect(selectedAdds.map(command => command.args)).toEqual([['add', '-A', '--', ':(literal)src/plugin.ts']]);
        expect(selectedAdds[0]?.env?.GIT_INDEX_FILE).toBeTruthy();
        expect(source.commands.filter(command => command.args[0] === 'push')).toHaveLength(0);
        expect(h.requests).toHaveLength(0);
        expect(await readFile(join(source.directory, 'unrelated.txt'), 'utf8')).toBe('uncommitted work');
    });

    it('preserves a confirmed push when only the repository refresh fails', async () => {
        const h = harness();
        const source = await sourceHarness({ failRefresh: true });
        const result = await publishPluginGithub({ directory: source.directory, selection: { ...selection,
            source: { remote: 'origin', branch: 'main' } }, ...h.dependencies, executeScm: source.executeScm });
        expect(result).toMatchObject({ status: 'partial', phase: 'push', pushed: true, errorCode: 'REPOSITORY_REFRESH_FAILED' });
        expect(h.requests).toHaveLength(0);
    });

    it('cancels before the first effect without requesting credentials or source writes', async () => {
        const h = harness();
        const controller = new AbortController(); controller.abort();
        expect(await publishPluginGithub({ directory: '/selected', selection, signal: controller.signal, ...h.dependencies }))
            .toMatchObject({ status: 'cancelled' });
        expect(h.requests).toHaveLength(0);
        expect(h.materializeCount()).toBe(0);
    });
});
