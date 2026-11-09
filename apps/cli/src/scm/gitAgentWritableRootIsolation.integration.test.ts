import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createGitScmBackendRuntimeRegistration } from '../../../../packages/plugins/scm-git/src/backend';
import { createGithubScmHostingProviderAdapter } from '../../../../packages/plugins/scm-github/src/adapter';
import { createGithubRestAdapter } from '../../../../packages/plugins/scm-github/src/pullRequests/restAdapter';
import { executeScmActionOperation } from './actions/executeScmActionOperation';
import { gitCheckpointAdapter } from './checkpoints/gitCheckpointAdapter';
import { buildRepositoryCheckpointRef } from './checkpoints/refs';
import { createRegisteredScmBackendAdapter } from './pluginBackends/registeredScmBackendAdapter';
import { createScmBackendRegistry } from './registry';
import { createScmHostingProviderRegistry } from './hostingProviders/registry';
import type { ScmBackendContext } from './types';
import { runHostGitPush } from './gitHostTransport';
import { runScmCommand, runWithScmCommandRunner, type ScmCommandRunner } from './runtime';
import {
    createBareGitRemoteFixture,
    createLocalScmRepositoryFixture,
    createScmContractTempDirectory,
    runScmExecutable,
} from '@/testkit/scm/scmBackendContractFixtures';

// These prepared real-process regressions use a synthetic custodian-readable
// sentinel. They do not claim to provision the separate Agent identity or to
// prove a cross-UID boundary; that producer must supply the admitted root and
// identity policy before P11-5b can close.
describe.skipIf(process.platform === 'win32')('repository-controlled code at the host Git boundary', () => {
    const directories: string[] = [];
    const cleanups: Array<() => Promise<void>> = [];
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
        definition: { id: 'git', kind: 'git' },
        qualifiedId: 'happier.scm.backend.git/git',
        executableDefinition: registration.runtime!,
        registration,
        hostingProviderRuntimeServices: {
            resolveScmHostingProviderRegistry: async () => createScmHostingProviderRegistry({ providers: [] }),
        },
    })]);

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0)) await cleanup();
        for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    });

    function createFixture(input?: Readonly<{ workspaceExecutionUnavailable?: true }>) {
        const repository = createLocalScmRepositoryFixture({
            executable: 'git', repoMode: '.git', prefix: 'happier-git-isolation-',
        });
        const privateRoot = createScmContractTempDirectory('happier-git-custodian-');
        directories.push(repository.rootPath, privateRoot);
        const sentinelPath = join(privateRoot, 'daemon-sentinel');
        const markerPath = join(privateRoot, 'disclosed-sentinel');
        writeFileSync(sentinelPath, 'synthetic-daemon-only-material\n', { mode: 0o600 });
        // POSIX-only fixture: Git executes the planted command as an actual OS
        // child. The private sentinel never enters the repository or launch env.
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const payloadPath = join(repository.rootPath, 'payload');
        writeFileSync(payloadPath, `#!/bin/sh\ncat ${quote(sentinelPath)} > ${quote(markerPath)}\ncat\n`, { mode: 0o755 });
        const context: ScmBackendContext = {
            cwd: repository.rootPath, projectKey: `isolation:${repository.rootPath}`,
            detection: { isRepo: true, rootPath: repository.rootPath, mode: '.git' },
            // This port is the runner→daemon OS execution boundary. A required
            // identity which is not ready must never fall back to local Git.
            ...(input?.workspaceExecutionUnavailable ? { scmCommandRunner: async () => ({
                success: false, stdout: '', stderr: 'workspace_exec_isolation_unavailable', exitCode: -1,
            }) } : {}),
        };
        const capture = () => gitCheckpointAdapter.capture({ context,
            checkpointRef: buildRepositoryCheckpointRef({ scopeId: context.projectKey, phase: 'turn-final', checkpointId: 'turn' }),
        });
        return { repository, privateRoot, markerPath, payloadPath, quote, capture };
    }

    async function createCredentialedRemote(remotePath: string) {
        const authorization = `Basic ${Buffer.from('happier:synthetic-scm-token').toString('base64')}`;
        let authenticatedRequests = 0;
        const server = createServer((request, response) => {
            if (request.headers.authorization !== authorization) {
                response.writeHead(401, { 'www-authenticate': 'Basic realm="SCM fixture"' });
                response.end();
                return;
            }
            authenticatedRequests += 1;
            const advertising = request.method === 'GET' && request.url?.includes('service=git-receive-pack');
            if (!advertising && (request.method !== 'POST' || request.url !== '/repository.git/git-receive-pack')) {
                response.writeHead(404).end();
                return;
            }
            response.writeHead(200, { 'content-type': advertising
                ? 'application/x-git-receive-pack-advertisement' : 'application/x-git-receive-pack-result' });
            if (advertising) response.write('001f# service=git-receive-pack\n0000');
            const child = spawn('git', ['receive-pack', '--stateless-rpc',
                ...(advertising ? ['--advertise-refs'] : []), remotePath], { stdio: ['pipe', 'pipe', 'pipe'] });
            child.stdout.pipe(response);
            child.stderr.resume();
            child.once('error', error => response.destroy(error));
            child.once('close', () => response.end());
            if (advertising) child.stdin.end();
            else request.pipe(child.stdin);
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        cleanups.push(async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('SCM HTTP fixture has no TCP address');
        return { url: `http://127.0.0.1:${address.port}/repository.git`, authenticatedRequests: () => authenticatedRequests };
    }

    const runProcess: ScmCommandRunner = command => new Promise(resolve => {
        const child = execFile(command.bin, command.args, { cwd: command.cwd, env: { ...process.env, ...command.env }, encoding: 'utf8' },
            (error, stdout, stderr) => resolve({ success: !error, stdout, stderr,
                exitCode: error ? typeof error.code === 'number' ? error.code : -1 : 0 }));
        child.stdin?.end(command.stdin);
    });

    it('pushes through real host-owned HTTP credentials without trusting a repository credential helper', async () => {
        const { repository, privateRoot, markerPath, payloadPath, quote } = createFixture();
        const remote = createBareGitRemoteFixture('happier-git-isolation-auth-remote-');
        directories.push(remote.remotePath);
        const transport = await createCredentialedRemote(remote.remotePath);
        runScmExecutable(repository.rootPath, 'git', ['remote', 'add', 'origin', transport.url]);
        const credentials = join(privateRoot, 'git-credentials');
        writeFileSync(credentials, transport.url.replace('http://', 'http://happier:synthetic-scm-token@') + '\n', { mode: 0o600 });
        const globalConfig = join(privateRoot, 'gitconfig');
        const includedHostConfig = join(privateRoot, 'private-credentials.gitconfig');
        writeFileSync(includedHostConfig, `[credential]\n\thelper = store --file=${quote(credentials)}\n`);
        writeFileSync(globalConfig, `[include]\n\tpath = ${includedHostConfig}\n`);
        const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
        process.env.GIT_CONFIG_GLOBAL = globalConfig;
        runScmExecutable(repository.rootPath, 'git', ['config', '--add', 'credential.helper', '']);
        runScmExecutable(repository.rootPath, 'git', ['config', '--add', 'credential.helper', `!${quote(payloadPath)}`]);
        runScmExecutable(repository.rootPath, 'git', ['config', `credential.${transport.url}.helper`, `!${quote(payloadPath)}`]);
        runScmExecutable(repository.rootPath, 'git', ['config', `http.${transport.url}.extraHeader`, 'Authorization: Bearer repository-controlled']);
        runScmExecutable(repository.rootPath, 'git', ['config', `http.${transport.url}.proxy`, 'http://127.0.0.1:1']);
        runScmExecutable(repository.rootPath, 'git', ['config', 'url.ext::repository-controlled.insteadOf', transport.url]);
        try {
            const result = await executeScmActionOperation({ actionId: 'scm.remote.push',
                input: { cwd: repository.rootPath, remote: 'origin', branch: repository.branchName },
                registry, workingDirectory: repository.rootPath,
            });
            expect(existsSync(markerPath), 'repository credential helper must never receive host authority').toBe(false);
            expect(result, JSON.stringify(result)).toMatchObject({ success: true });
            expect(transport.authenticatedRequests()).toBeGreaterThan(0);
            expect(runScmExecutable(remote.remotePath, 'git', ['rev-parse', `refs/heads/${repository.branchName}`]))
                .toBe(repository.headCommit);
        } finally {
            if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
            else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
        }
    });

    it.each(['absolute', 'relative'] as const)('keeps real checkpoint capture and the registered %s-path remote-push Action usable', async pathKind => {
        const { repository, markerPath, capture } = createFixture();
        const remote = createBareGitRemoteFixture('happier-git-isolation-remote-');
        directories.push(remote.remotePath);
        runScmExecutable(repository.rootPath, 'git', ['remote', 'add', 'origin', pathKind === 'absolute'
            ? remote.remotePath : relative(repository.rootPath, remote.remotePath)]);

        expect(await capture()).toMatchObject({ success: true });
        expect(await executeScmActionOperation({ actionId: 'scm.remote.push',
            input: { cwd: repository.rootPath, remote: 'origin', branch: repository.branchName },
            registry, workingDirectory: repository.rootPath,
        })).toMatchObject({ success: true });
        expect(runScmExecutable(remote.remotePath, 'git', ['rev-parse', `refs/heads/${repository.branchName}`]))
            .toBe(repository.headCommit);
        expect(runScmExecutable(repository.rootPath, 'git', ['rev-parse', `refs/remotes/origin/${repository.branchName}`]))
            .toBe(repository.headCommit);
        expect(existsSync(markerPath)).toBe(false);
    });

    it.each(['admitted', 'denied', 'retired after push'] as const)('preserves credentialed set-upstream custody (%s)', async availability => {
        const { repository, privateRoot, quote } = createFixture();
        const remote = createBareGitRemoteFixture('happier-upstream-remote-');
        directories.push(remote.remotePath);
        const transport = await createCredentialedRemote(remote.remotePath);
        runScmExecutable(repository.rootPath, 'git', ['remote', 'add', 'origin', transport.url]);
        const credentials = join(privateRoot, 'git-credentials');
        writeFileSync(credentials, transport.url.replace('http://', 'http://happier:synthetic-scm-token@') + '\n', { mode: 0o600 });
        const globalConfig = join(privateRoot, 'gitconfig');
        writeFileSync(globalConfig, `[credential]\n\thelper = store --file=${quote(credentials)}\n`);
        const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
        process.env.GIT_CONFIG_GLOBAL = globalConfig;
        const workspaceRunner: ScmCommandRunner = command => {
            if (availability === 'denied' || (availability === 'retired after push' && command.args[0] === 'config')) {
                return Promise.resolve({ success: false, stdout: '', stderr: 'workspace_exec_isolation_unavailable', exitCode: -1 });
            }
            return runProcess(command);
        };
        try {
            const result = await runWithScmCommandRunner(workspaceRunner, () => runScmCommand({
                bin: 'git', cwd: repository.rootPath, args: ['push', '--set-upstream', 'origin', repository.branchName],
            }));
            if (availability === 'denied') {
                expect(result).toMatchObject({ success: false, stderr: 'workspace_exec_isolation_unavailable' });
                expect(transport.authenticatedRequests()).toBe(0);
                expect(existsSync(join(remote.remotePath, 'refs', 'heads', repository.branchName))).toBe(false);
            } else {
                expect(result, JSON.stringify(result)).toMatchObject({ success: true });
                expect(runScmExecutable(remote.remotePath, 'git', ['rev-parse', `refs/heads/${repository.branchName}`]))
                    .toBe(repository.headCommit);
                if (availability === 'admitted') {
                    expect(runScmExecutable(repository.rootPath, 'git', ['config', '--get', `branch.${repository.branchName}.remote`])).toBe('origin');
                } else expect(result.stderr).toContain('Push succeeded; upstream configuration unavailable: workspace_exec_isolation_unavailable');
            }
        } finally {
            if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
            else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
        }
    });

    it.each([
        ['effective', true, false], ['disabled', false, false], ['swapped after read', true, true],
    ] as const)('evaluates a private-looking host include symlink against held isolation (%s)', async (_label, enabled, swapAfterRead) => {
        const { repository, privateRoot, markerPath, payloadPath, quote } = createFixture();
        const otherRoot = createScmContractTempDirectory('happier-other-workspace-');
        directories.push(otherRoot);
        const writableInclude = join(otherRoot, 'credential.gitconfig');
        writeFileSync(writableInclude, `[credential]\n\thelper = !${quote(payloadPath)}\n`);
        const privateLookingInclude = join(privateRoot, 'included.gitconfig');
        symlinkSync(writableInclude, privateLookingInclude);
        const globalConfig = join(privateRoot, 'gitconfig');
        writeFileSync(globalConfig, `[include]\n\tpath = ${privateLookingInclude}\n`);
        const safeConfig = join(privateRoot, 'safe.gitconfig');
        writeFileSync(safeConfig, '[credential]\n\thelper =\n');
        const remote = createBareGitRemoteFixture('happier-untrusted-include-remote-');
        directories.push(remote.remotePath);
        const transport = await createCredentialedRemote(remote.remotePath);
        runScmExecutable(repository.rootPath, 'git', ['remote', 'add', 'origin', transport.url]);
        const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
        process.env.GIT_CONFIG_GLOBAL = globalConfig;
        // Real process boundary beneath the canonical transport owner. The
        // fixture supplies held root facts, not an alternative origin policy.
        let swapped = false;
        try {
            const result = await runHostGitPush({ bin: 'git', cwd: repository.rootPath,
                args: ['push', 'origin', repository.branchName] }, runProcess, { read: () => {
                    // Git has already flattened the malicious include. An OS
                    // writer swaps its target before the held origin proof.
                    if (swapAfterRead && !swapped) {
                        swapped = true;
                        unlinkSync(writableInclude);
                        symlinkSync(safeConfig, writableInclude);
                    }
                    return {
                    enabled, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
                    workspaceRoots: [repository.rootPath, otherRoot],
                }; } });
            expect(result).toMatchObject({ success: false });
            expect(existsSync(markerPath)).toBe(!enabled);
            expect(transport.authenticatedRequests()).toBe(0);
        } finally {
            if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
            else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
        }
    });

    it('creates a real HTTP pull request through the Action with host-selected forge credentials', async () => {
        const { repository, markerPath } = createFixture();
        const requests: Array<{ method: string; authorization?: string; body: unknown }> = [];
        const server = createServer(async (request, response) => {
            let body = '';
            for await (const chunk of request) body += Buffer.from(chunk).toString();
            requests.push({ method: request.method ?? '', authorization: request.headers.authorization,
                body: body ? JSON.parse(body) : null });
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(request.method === 'POST' ? {
                number: 17, title: 'Isolated SCM action', state: 'open', draft: false,
                html_url: 'https://github.com/isolation/repository/pull/17',
                base: { ref: 'main', sha: repository.headCommit },
                head: { ref: repository.branchName, sha: repository.headCommit, repo: { full_name: 'isolation/repository' } },
            } : []));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        cleanups.push(async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Forge HTTP fixture has no address');
        const providerRegistry = createScmHostingProviderRegistry({
            providers: [{ id: 'github', pluginId: 'happier.scm.forge.github', kind: 'github',
                displayName: 'GitHub', capabilities: ['detect', 'pullRequest'], authService: 'github-account' }],
            runtimeRegistrations: [{ pluginId: 'happier.scm.forge.github', occurrenceId: 'isolation-fixture',
                registration: { id: 'github', adapter: { routing: createGithubScmHostingProviderAdapter(),
                    pullRequests: createGithubRestAdapter({
                        // Only the network boundary is redirected to a real local HTTP server.
                        fetcher: (url, init) => fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}${new URL(url).search}`, init),
                    }),
                } },
            }],
        });
        const prRegistry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
            definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
            executableDefinition: registration.runtime!, registration,
            hostingProviderRuntimeServices: {
                resolveScmHostingProviderRegistry: async () => providerRegistry,
                // The selected credential-store boundary; no token enters Git or Agent env.
                resolveScmHostingTokenMaterialization: async () => ({ kind: 'available', token: 'synthetic-host-forge-token' }),
            },
        })]);
        const git = (args: string[]) => runScmExecutable(repository.rootPath, 'git', args);
        git(['remote', 'add', 'origin', 'https://github.com/isolation/repository.git']);
        git(['update-ref', `refs/remotes/origin/${repository.branchName}`, 'HEAD']);
        git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
        git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
        git(['branch', `--set-upstream-to=origin/${repository.branchName}`]);
        const result = await executeScmActionOperation({ actionId: 'scm.pullRequest.openOrReuse',
            input: { cwd: repository.rootPath, base: 'main', head: repository.branchName, title: 'Isolated SCM action', body: '' },
            registry: prRegistry, workingDirectory: repository.rootPath,
        });
        expect(result, JSON.stringify(result)).toMatchObject({ success: true });
        expect(requests.some(request => request.method === 'POST' && request.authorization === 'Bearer synthetic-host-forge-token'
            && JSON.stringify(request.body).includes('Isolated SCM action'))).toBe(true);
        expect(existsSync(markerPath)).toBe(false);
    });

    it('does not fall back to host capture when the admitted workspace execution boundary refuses an included filter', async () => {
        const { repository, markerPath, payloadPath, quote, capture } = createFixture({ workspaceExecutionUnavailable: true });
        const includedConfig = join(repository.rootPath, 'included.config');
        writeFileSync(includedConfig, `[filter "agent-controlled-driver"]\n\tclean = ${quote(payloadPath)}\n`);
        runScmExecutable(repository.rootPath, 'git', ['config', 'include.path', includedConfig]);
        writeFileSync(join(repository.rootPath, '.gitattributes'), `${repository.trackedPath} filter=agent-controlled-driver\n`);
        writeFileSync(join(repository.rootPath, repository.trackedPath), 'new checkpoint content\n');

        const result = await capture();

        expect(existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null,
            'repository filter must not disclose custodian material').toBeNull();
        expect(result).toMatchObject({ success: false, kind: 'unavailable' });
    });

    it.each(['admitted', 'denied'] as const)('preserves non-bare updateInstead only through workspace execution (%s)', async availability => {
        const { repository } = createFixture();
        const destinationRoot = createScmContractTempDirectory('happier-nonbare-receiver-');
        directories.push(destinationRoot);
        const destination = join(destinationRoot, 'checkout');
        runScmExecutable(destinationRoot, 'git', ['clone', repository.rootPath, destination]);
        runScmExecutable(destination, 'git', ['config', 'receive.denyCurrentBranch', 'updateInstead']);
        runScmExecutable(repository.rootPath, 'git', ['remote', 'add', 'origin', destination]);
        const before = readFileSync(join(destination, repository.trackedPath), 'utf8');
        writeFileSync(join(repository.rootPath, repository.trackedPath), 'published through workspace identity\n');
        runScmExecutable(repository.rootPath, 'git', ['add', repository.trackedPath]);
        runScmExecutable(repository.rootPath, 'git', ['commit', '-m', 'next']);
        const workspaceRunner: ScmCommandRunner = availability === 'admitted' ? runProcess
            : async () => ({ success: false, stdout: '', stderr: 'workspace_exec_isolation_unavailable', exitCode: -1 });
        const result = await runWithScmCommandRunner(workspaceRunner, () => runScmCommand({ bin: 'git',
            cwd: repository.rootPath, args: ['push', 'origin', repository.branchName] }));
        expect(result.success).toBe(availability === 'admitted');
        expect(readFileSync(join(destination, repository.trackedPath), 'utf8'))
            .toBe(availability === 'admitted' ? 'published through workspace identity\n' : before);
    });

    it('does not execute a repository pre-push hook through the registered remote-push Action', async () => {
        const { repository, markerPath, payloadPath } = createFixture();
        const remote = createBareGitRemoteFixture("happier-git-isolation-hook-'quoted space'-remote-");
        directories.push(remote.remotePath);
        runScmExecutable(repository.rootPath, 'git', ['remote', 'add', 'origin', remote.remotePath]);
        const hooksPath = join(repository.rootPath, 'agent-hooks');
        mkdirSync(hooksPath);
        writeFileSync(join(hooksPath, 'pre-push'), readFileSync(payloadPath), { mode: 0o755 });
        writeFileSync(join(hooksPath, 'reference-transaction'), readFileSync(payloadPath), { mode: 0o755 });
        writeFileSync(join(remote.remotePath, 'hooks', 'pre-receive'), readFileSync(payloadPath), { mode: 0o755 });
        writeFileSync(join(remote.remotePath, 'hooks', 'reference-transaction'), readFileSync(payloadPath), { mode: 0o755 });
        runScmExecutable(repository.rootPath, 'git', ['config', 'core.hooksPath', hooksPath]);

        const result = await executeScmActionOperation({ actionId: 'scm.remote.push',
            input: { cwd: repository.rootPath, remote: 'origin', branch: repository.branchName },
            registry, workingDirectory: repository.rootPath,
        });

        const environmentOverride = await runScmCommand({ bin: 'git', cwd: repository.rootPath,
            args: ['push', 'origin', repository.branchName], env: { GIT_CONFIG_COUNT: '1',
                GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooksPath } });

        expect(existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null,
            'repository hook must not disclose custodian material').toBeNull();
        expect(result).toMatchObject({ success: true });
        expect(environmentOverride).toMatchObject({ success: true });
        expect(runScmExecutable(remote.remotePath, 'git', ['rev-parse', `refs/heads/${repository.branchName}`]))
            .toBe(repository.headCommit);
    });
});
