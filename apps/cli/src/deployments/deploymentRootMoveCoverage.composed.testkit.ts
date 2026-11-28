import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { stubUndiciFetch } from '@/testkit/http/stubUndiciFetch';

import type { ActionExecuteResult } from '@happier-dev/protocol';
import { DeploymentMoveToRepositoryResultV1Schema } from '@happier-dev/protocol/deployments/deploymentMoveToRepositoryV1';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { PluginConnectedAccountAuthenticationV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { PLUGIN_MANIFEST as githubManifest } from '../../../../packages/plugins/scm-github/src/manifest';
import type { DeploymentSocketHomeFixture } from '../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { mutateQualifiedConnectedAccountCredentialV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { createProjectAccountSnapshotMutation } from '@/workspaces/projectAccountRows';
import { refreshActiveAccountSettingsFromServer } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { deriveScmHostingProviderConnectedAccountPurposeAuthorization } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import { createLocalGitForgeHostConfig } from '@/testkit/scm/localGitForgeTransport';

/** Move's finite Apply creates a repository/PR and attaches the Source. Git,
 * credential materialization, admission and Home persistence remain real. */
export async function runDeploymentRootMoveCoverage(input: Readonly<{
    home: DeploymentSocketHomeFixture;
    credentials: StoredCredentials;
    invoke(name: string, input: unknown): Promise<ActionExecuteResult>;
    invokeSession(name: string, input: unknown): Promise<ActionExecuteResult>;
    environmentId: string;
    projectSourceId: string;
    definition: Readonly<{ contentRevision: number; composeDigest: string; document: string }>;
}>) {
    const { home, credentials, invoke } = input;
    const descriptor = githubManifest.contributes.connectedAccountDescriptors?.[0];
    const hosting = githubManifest.contributes.scmHostingProviders?.[0];
    if (!descriptor || !hosting) throw new Error('Move coverage requires the bundled GitHub contributions');
    const authorization = deriveScmHostingProviderConnectedAccountPurposeAuthorization({ pluginId: githubManifest.id, definition: hosting });
    if (!authorization) throw new Error('GitHub must declare its canonical SCM authentication purpose');
    const account = { service: { pluginId: githubManifest.id, localId: descriptor.id }, accountId: randomUUID() };
    const token = `github-root-coverage-${randomUUID()}`;
    if (home.encryptionMode !== 'e2ee' || !home.encryption) throw new Error('Move coverage requires real E2EE credential material');
    await runWithServerHttpBaseUrl(home.baseUrl, async () => {
        await mutateQualifiedConnectedAccountCredentialV4({ token: home.token, mutation: { ref: account,
            authenticationModeId: PluginConnectedAccountAuthenticationV2Schema.parse(descriptor.authentication).defaultModeId, expectedCredentialRevision: null,
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee',
                material: home.encryption!, payload: { v: 1, values: { token } },
                randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) }),
            metadata: { displayName: 'Root coverage GitHub', scopes: [],
                providerIdentity: { accountId: 's0', email: null, organizationId: null } },
        } });
        await refreshActiveAccountSettingsFromServer({ credentials });
        await createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials }).update(current => ({ ...current,
            bindings: [...current.bindings.filter(binding => JSON.stringify(binding.purpose) !== JSON.stringify(authorization.purpose)),
                { purpose: authorization.purpose, target: { kind: 'account', account } }],
        }));
    });

    const directory = join(home.baseDir, 'root-coverage-move');
    const remotePath = join(home.baseDir, 'root-coverage-move-remote.git');
    await mkdir(directory);
    execFileSync('git', ['init', '--bare', '--quiet', remotePath]);
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remotePath });
    const repositoryName = 'moved-app';
    const nameWithOwner = `s0/${repositoryName}`;
    const cloneUrl = `https://github.com/${nameWithOwner}.git`;
    // The existing host Git adapter redirects only network push effects. The
    // origin retained in Git and the SCM identity remains the real HTTPS URL.
    const transport = await createLocalGitForgeHostConfig({ url: cloneUrl, remotePath });
    vi.stubEnv('GIT_CONFIG_GLOBAL', transport.path);
    vi.stubEnv('GIT_AUTHOR_NAME', 'Root coverage'); vi.stubEnv('GIT_AUTHOR_EMAIL', 'root-coverage@example.test');
    vi.stubEnv('GIT_COMMITTER_NAME', 'Root coverage'); vi.stubEnv('GIT_COMMITTER_EMAIL', 'root-coverage@example.test');
    const workspaceId = randomUUID();
    const workspace = { kind: 'workspace-ref' as const, serverId: home.serverId, id: workspaceId };
    const placed = await runWithServerHttpBaseUrl(home.baseUrl, () => createProjectAccountSnapshotMutation({ credentials,
        serverId: home.serverId })(snapshot => ({ ...snapshot, workspaceRefs: [...snapshot.workspaceRefs, {
            id: workspaceId, serverId: home.serverId, machineId: home.machineId, rootPath: directory, createdAtMs: Date.now(),
        }] })));
    expect(placed.status).toBe('applied');
    let repositoryCreated = false;
    let opened: { number: number; title: string; html_url: string; state: string; merged?: boolean; merge_commit_sha?: string;
        base: { ref: string }; head: { ref: string; sha: string; repo: { full_name: string } } } | undefined;
    const requests: { method: string; path: string }[] = [];
    const nativeFetch = globalThis.fetch;
    const githubHttp = stubUndiciFetch(async (url: string | URL | Request, init?: RequestInit) => {
        const parsed = new URL(typeof url === 'object' && 'url' in url ? url.url : String(url));
        if (parsed.origin !== 'https://api.github.com') return nativeFetch(url, init);
        const method = init?.method ?? 'GET';
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
        requests.push({ method, path: parsed.pathname });
        const repository = { id: 123, name: repositoryName, full_name: nameWithOwner, html_url: `https://github.com/${nameWithOwner}`,
            clone_url: cloneUrl, ssh_url: `git@github.com:${nameWithOwner}.git`, visibility: 'private', default_branch: 'main' };
        let body: unknown;
        let status = 200;
        if (method === 'GET' && parsed.pathname === '/user') body = { login: 's0', name: 'Root coverage' };
        else if (method === 'GET' && parsed.pathname === '/user/orgs') body = [];
        else if (method === 'POST' && parsed.pathname === '/user/repos') {
            expect(JSON.parse(Buffer.from(init?.body as Uint8Array).toString('utf8'))).toMatchObject({ name: repositoryName, private: true });
            repositoryCreated = true; body = repository;
        } else if (method === 'GET' && parsed.pathname === `/repos/${nameWithOwner}`) {
            body = repositoryCreated ? repository : {}; status = repositoryCreated ? 200 : 404;
        } else if (method === 'GET' && parsed.pathname === `/repos/${nameWithOwner}/pulls`) body = opened ? [opened] : [];
        else if (method === 'GET' && parsed.pathname === `/repos/${nameWithOwner}/pulls/4` && opened) body = opened;
        else if (method === 'POST' && parsed.pathname === `/repos/${nameWithOwner}/pulls`) {
            const authored = JSON.parse(Buffer.from(init?.body as Uint8Array).toString('utf8')) as { title: string; base: string; head: string };
            const sha = execFileSync('git', ['rev-parse', `refs/heads/${authored.head}`], { cwd: remotePath, encoding: 'utf8' }).trim();
            opened = { number: 4, title: authored.title, html_url: `https://github.com/${nameWithOwner}/pull/4`, state: 'open',
                base: { ref: authored.base }, head: { ref: authored.head, sha, repo: { full_name: nameWithOwner } } };
            body = opened; status = 201;
        } else throw new Error(`Unexpected GitHub request: ${method} ${parsed.pathname}`);
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    });
    try {
        const operand = { serverId: home.serverId, environmentId: input.environmentId, workspace,
            definition: { contentRevision: input.definition.contentRevision, composeDigest: input.definition.composeDigest },
            path: 'compose.yaml', createRepository: { providerKind: 'github' as const, owner: 's0', repositoryName, visibility: 'private' as const } };
        const preview = await invoke('deployments.environments.moveToRepository', { ...operand, mode: 'preview' });
        expect(preview).toMatchObject({ ok: true, result: { kind: 'previewCreate' } });
        expect(repositoryCreated).toBe(false);
        const result = await invoke('deployments.environments.moveToRepository', { ...operand, mode: 'apply' });
        if (!result.ok) throw new Error(`Move apply refused: ${result.errorCode}`);
        const moved = DeploymentMoveToRepositoryResultV1Schema.parse(result.result);
        expect(moved.kind).toBe('pullRequest');
        if (moved.kind !== 'pullRequest') throw new Error(`Move apply did not open its pull request: ${moved.kind}`);
        expect(moved.repository?.repository).toEqual({ kind: 'github', deployment: 'https://github.com', repository: nameWithOwner });
        expect(execFileSync('git', ['show', `${moved.continuation.headCommit}:compose.yaml`], { cwd: remotePath, encoding: 'utf8' }))
            .toBe(input.definition.document);
        expect(await readFile(join(directory, 'README.md'), 'utf8')).toContain(repositoryName);
        const read = await fetch(`${home.baseUrl}/v1/projects/sources/${input.projectSourceId}`, { headers: { Authorization: `Bearer ${home.token}` } });
        expect(read.status).toBe(200);
        const source = ProjectSourcesReadOutputV1Schema.parse(await read.json());
        expect(source).toMatchObject({ ok: true, source: { id: input.projectSourceId,
            repository: { repository: { nameWithOwner, cloneUrl } } } });
        expect(requests).toEqual(expect.arrayContaining([{ method: 'POST', path: '/user/repos' },
            { method: 'POST', path: `/repos/${nameWithOwner}/pulls` }]));
        expect(JSON.stringify(moved)).not.toContain(token);
        if (!opened) throw new Error('Move must open its real pull request before continuing');
        execFileSync('git', ['update-ref', 'refs/heads/main', moved.continuation.headCommit], { cwd: remotePath });
        opened = { ...opened, state: 'closed', merged: true, merge_commit_sha: moved.continuation.headCommit };
        if (!moved.repository) throw new Error('Move must retain its created repository identity');
        const { createRepository: _createRepository, ...continuationOperand } = operand;
        // The native Session creates the root and requester projections. Home
        // validates its real child signatures; no test supplies HTTP headers.
        const continued = await input.invokeSession('deployments.environments.moveToRepository', {
            ...continuationOperand, mode: 'apply', repository: moved.repository.repository,
            continuation: moved.continuation,
        });
        expect(continued).toMatchObject({ ok: true, result: { kind: 'switched', environmentId: input.environmentId,
            commitSha: moved.continuation.headCommit } });
        const current = await invoke('deployments.environments.get', { serverId: home.serverId, environmentId: input.environmentId });
        if (!current.ok) throw new Error(`Moved Environment read refused: ${current.errorCode}`);
        const environment = DeploymentEnvironmentGetResultV1Schema.parse(current.result);
        expect(environment).toMatchObject({ ok: true, content: { definition: { kind: 'repository', ref: moved.continuation.headCommit,
            compose: { path: operand.path } } } });
    } finally { githubHttp.mockReset(); await transport.cleanup(); }
}
