import axios from 'axios';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentTemplateInstantiateInputV1Schema, DeploymentTemplateInstantiateResultV1Schema } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { createRegistryHostV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createLocalGitForgeHostConfig, createLocalGitForgeTransport } from '@/testkit/scm/localGitForgeTransport';
import { createDeploymentGitRegistry } from '../targets/ownServer/exactCommitRelease.testkit';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { commitGuardedFileReplace } from '@/rpc/handlers/fileSystem/commitGuardedFileReplace';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { readProjectAccountRows, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { createDeploymentTemplateInstantiationForHost } from './instantiate';
import { accountSettingsParse } from '@happier-dev/protocol';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { REPOSITORY_FILES_PULL_REQUEST_CHILDREN_V1, REPOSITORY_FILES_PULL_REQUEST_READ_CHILDREN_V1,
    repositoryFilesPullRequestChildRoleV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { FilesystemWriteFileInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createGithubForgeHttpFixture } from '@/testkit/scm/githubForgeHttp';
import { createCliDeploymentActionDeps } from '../createCliDeploymentActionDeps';
import { createPrepareDeploymentBindingsForHost } from '../secrets/prepareDeploymentBindingsForHost';

afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); });

it.each(['pullRequest', 'bindings'] as const)('retains the repository owner and acknowledged effects when %s is unavailable', async failurePhase => {
    const fixture = await createSavedSecretsCliHttpFixture();
    const git = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'template-repository-' });
    let hostGitConfig: Awaited<ReturnType<typeof createLocalGitForgeHostConfig>> | undefined;
    const previousGlobalGitConfig = process.env.GIT_CONFIG_GLOBAL;
    let proposedWorktree: string | undefined;
    try {
        const credentials = await fixture.deps.readCredentialsFn?.();
        if (!credentials) throw new Error('Fixture credentials unavailable');
        const document = 'services:\n  app:\n    image: nginx:1\n';
        await writeFile(join(git.rootPath, git.trackedPath), document);
        runScmExecutable(git.rootPath, 'git', ['add', git.trackedPath]);
        runScmExecutable(git.rootPath, 'git', ['commit', '-m', 'Compose base']);
        runScmExecutable(git.rootPath, 'git', ['remote', 'add', 'origin', 'https://github.com/example/app.git']);
        const remote = join(git.rootPath, 'fixture-remote.git');
        runScmExecutable(git.rootPath, 'git', ['init', '--bare', remote]);
        // Host push custody runs outside the injected workspace runner; redirect its genuine Git transport.
        hostGitConfig = await createLocalGitForgeHostConfig({ url: 'https://github.com/example/app.git', remotePath: remote });
        process.env.GIT_CONFIG_GLOBAL = hostGitConfig.path;
        const baseCommit = runScmExecutable(git.rootPath, 'git', ['rev-parse', 'HEAD']);
        const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'example/app' };
        const workspace = { id: 'checkout', serverId: 'home', machineId: 'checkout-machine', rootPath: git.rootPath,
            createdAtMs: 1, repositoryIdentity: repository, source: { sourceId: 'project', revision: 1 } };
        const rows = [createPlainProjectAccountRefRow(workspace)];
        const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
            url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
        const catalog: unknown = JSON.parse(await readFile(new URL('../../../../../packages/plugins/deployment-templates/resources/registry/apps.json', import.meta.url), 'utf8'));
        const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
            getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
            getText: async () => { throw new Error('No text fetch'); }, getBytes: async () => { throw new Error('No bytes fetch'); },
        } });
        const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
            sourceId: source.id, kind: 'app', itemId: 'postgresql' })).item;
        if (selected.payload.kind !== 'app') throw new Error('Expected app');
        const { origin: _origin, removable: _removable, ...sourceRow } = source;
        const current = createDeploymentEnvironmentDetailV1();
        current.environment.projectSourceId = 'project';
        current.environment.controllerMachineId = 'runtime-controller';
        current.content = DeploymentEnvironmentContentV1Schema.parse({ ...current.content, bindings: [], definition: {
            kind: 'repository', ref: git.branchName, compose: { path: git.trackedPath, profiles: [], services: ['app'] } } });
        const link = current.targetLinks[0]!.targetLink;
        current.environment.runtimeTargetLinkId = link.id;
        const member = link.members[0]!;
        const originalGet = axios.get.bind(axios);
        const originalRequest = axios.request.bind(axios);
        const originalPost = axios.post.bind(axios);
        // Home/catalog HTTP are genuine system boundaries; preparation, custody and native Git stay real.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(catalog));
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => url.endsWith('/v1/account/entity-rows/prompt-library')
            ? { status: 200, data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
                key, revision: 1, content: key === 'registry-sources' ? { t: 'plain', v: { key, value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null })) }) }
            : originalGet(url, config));
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => url.includes('/v1/account/project-rows/')
            ? projectAccountRowsReadHttpResponse(rows, url, body) : originalPost(url, body, config));
        vi.spyOn(axios, 'request').mockImplementation(async request => request.method === 'GET' && new URL(String(request.url)).pathname === '/v1/projects/sources/project'
            ? { status: 200, data: { ok: true, canManage: true, source: { id: 'project', revision: 1, name: 'App', createdByAccountId: 'account-cli-fixture', audience: [],
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'example/app', cloneUrl: 'https://github.com/example/app.git' }, protocol: 'https' } } } }
            : failurePhase === 'bindings' && request.method === 'GET'
                && new URL(String(request.url)).pathname.includes('/deployments/environments/')
                ? { status: 503, data: { error: 'Home unavailable' } } : originalRequest(request));
        const forge = createGithubForgeHttpFixture({ nameWithOwner: 'example/app', cloneUrl: 'https://github.com/example/app.git',
            ...(failurePhase === 'pullRequest' ? { pullRequestWriteStatus: 503 } : {}) });
        const nativeRegistry = createDeploymentGitRegistry({ resolveScmHostingProviderRegistry: async () => forge.hosting },
            createLocalGitForgeTransport({ url: 'https://github.com/example/app.git', remotePath: remote }));
        const sources = createCliProjectSourceActionDeps({ serverHttpBaseUrl: fixture.origin, admitAccount: async () => null, resolveRequestHeaders: async () => ({}) });
        const scopeKey = fixture.inHome(() => resolveAccountSettingsScopeKey(credentials));
        const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: fixture.origin,
            snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
                scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
        const writes: unknown[] = [];
        const scmReads: unknown[] = [];
        const bindingStorage = createCliDeploymentActionDeps({ serverHttpBaseUrl: fixture.origin,
            admitAccount: async () => null, resolveRequestHeaders: async () => ({}),
            prepareBindings: createPrepareDeploymentBindingsForHost({ credentials, serverId: 'home',
                serverHttpBaseUrl: fixture.origin, machineId: workspace.machineId,
                savedSecretOperationContext: operation, resolveRequestHeaders: async () => ({}) }),
            dispatchReceipt: async () => { throw new Error('Bindings cannot deploy'); } });
        const templates = createDeploymentTemplateInstantiationForHost({ credentials, serverId: 'home', machineId: workspace.machineId,
            serverHttpBaseUrl: fixture.origin, savedSecretOperationContext: operation,
            readInstallation: async () => member.installationId, assertCurrent: async () => {}, headers: async () => ({}),
            readEnvironment: async () => current, readCreationDefaultInputs: async () => ({}),
            sharedRepositoryWorkspace: { readWorkspaceRows: async selection => fixture.inHome(() => readProjectAccountRows({ credentials, serverId: 'home', selection })),
                readSource: sources.projectSourcesRead! },
            repositoryFiles: (cwd, context, executeCanonicalAction) => {
                const invoke = async (action: Parameters<NonNullable<typeof executeCanonicalAction>>[0], input: unknown) => {
                    const role = repositoryFilesPullRequestChildRoleV1(action);
                    if (!role) throw new Error('Undeclared repository child');
                    const result = executeCanonicalAction ? await executeCanonicalAction(action, input)
                        : await context.hostReviewedChild!.invoke({ action, role, input });
                    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
                    return result.result;
                };
                return { executeScm: (action, input) => invoke(action, { cwd, ...(input && typeof input === 'object' ? input : {}) }),
                    writeFile: input => invoke('daemon.filesystem.writeFile', input),
                    deleteFile: input => invoke('daemon.filesystem.delete', input) };
            },
            createContent: async () => { throw new Error('Bindings Action must prepare its own content'); },
            storage: async () => { throw new Error('Repository definition must use SCM'); },
        });
        const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', intent: 'add', serverId: 'home', machineId: member.machineId,
            projectSourceId: 'project', templateRef: { sourceId: source.id, itemId: 'postgresql', version: selected.summary.version!, ref: selected.payload.ref },
            environment: { kind: 'existing', environmentId: current.environment.id, expectedRevision: current.environment.revision },
            target: { kind: 'existing', targetLinkId: link.id, expectedRevision: link.revision, installationId: member.installationId },
            destination: { kind: 'repositoryPullRequest', workspace: { kind: 'workspace-ref', serverId: 'home', id: workspace.id }, sourceRevision: 1,
                repository, baseCommit, baseBranch: git.branchName, branchName: 'add-postgresql', composePath: git.trackedPath, title: 'Add PostgreSQL' },
            bindings: [{ purpose: 'variable', name: 'DB_PASSWORD', phase: 'runtime', source: { kind: 'generated', key: 'DB_PASSWORD' } }] });
        const executor = createActionExecutor({
            resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => { throw new Error('Metadata reader owns this query'); },
                async () => ({ ok: true, environment: { id: current.environment.id, projectSourceId: 'project', purpose: 'standard' } })),
            isActionApprovalRequired: () => false,
            prepareDeploymentTemplateInstantiation: request => templates.prepare(request.input, request.context, request.executeCanonicalAction),
            prepareHostReviewedChildren: async request => request.actionId === 'deployments.templates.instantiate'
                && DeploymentTemplateInstantiateInputV1Schema.parse(request.input).mode === 'preview'
                ? { children: REPOSITORY_FILES_PULL_REQUEST_READ_CHILDREN_V1 } : null,
            deploymentTemplateInstantiate: (input, context) => templates.instantiate(input, context),
            // Observe the reviewed operand while the actual deployment adapter owns execution.
            deploymentAction: async (action, input, context) => {
                if (action !== 'deployments.bindings.set') throw new Error('Unexpected deployment effect');
                writes.push(input);
                return bindingStorage.deploymentAction!(action, input, context);
            },
            // The native SCM/filesystem adapters are real OS boundaries beneath Action policy and review.
            scmActionExecute: async args => {
                const result = await executeScmActionOperation({ ...args, registry: nativeRegistry, workingDirectory: git.rootPath });
                if (result && typeof result === 'object' && 'success' in result) {
                    scmReads.push({ action: args.actionId, success: result.success,
                        errorCode: 'errorCode' in result ? result.errorCode : undefined });
                }
                return result;
            },
            filesystemActionExecute: async args => {
                if (args.actionId !== 'daemon.filesystem.writeFile') throw new Error('Unexpected filesystem effect');
                const input = FilesystemWriteFileInputSchema.parse(args.input);
                return commitGuardedFileReplace({ destPath: join(input.rootPath, input.path), expectation: input.expectedHash ?? null,
                    source: { kind: 'bytes', bytes: Buffer.from(input.content, 'base64') } });
            },
        });
        const context = { serverId: 'home', runtimeAccountId: 'account-cli-fixture', surface: 'cli' as const,
            authority: 'account_automation' as const, actionCaller: { kind: 'host' as const }, actionRequestId: 'add-database',
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
                ...Object.fromEntries(REPOSITORY_FILES_PULL_REQUEST_CHILDREN_V1.map(child => [child.action, ['cli']])),
                'deployments.bindings.set': ['cli'],
            } }) };
        const preview = await fixture.inHome(() => executor.execute('deployments.templates.instantiate', { ...input, mode: 'preview' }, context));
        expect(preview, JSON.stringify({ scmReads })).toMatchObject({ ok: true, result: { kind: 'preview', review: { repositoryChange: { baseCommit,
            files: [expect.objectContaining({ path: git.trackedPath, before: document })] } } } });
        expect(fixture.writes).toHaveLength(0);
        const executed = await fixture.inHome(() => executor.execute('deployments.templates.instantiate', input, context));
        expect(executed, JSON.stringify({ scmReads, httpRequests: forge.httpRequests, tokenRequests: forge.tokenRequests() })).toMatchObject({ ok: false, details: { kind: 'partial', phase: failurePhase === 'bindings' ? 'bindings' : 'repository',
            errorCode: failurePhase === 'bindings' ? 'deployment_content_unavailable' : 'COMMAND_FAILED',
            savedSecrets: [{ name: 'DB_PASSWORD' }], repositoryChange: failurePhase === 'bindings'
                ? { kind: 'pullRequest', pullRequest: { url: 'https://github.com/example/app/pull/4' }, headCommit: expect.any(String) }
                : { stage: 'pullRequest', errorCode: 'COMMAND_FAILED' } } });
        if (executed.ok) throw new Error('Expected unavailable Forge');
        const result = DeploymentTemplateInstantiateResultV1Schema.parse(executed.details);
        if (!('kind' in result) || result.kind !== 'partial' || !result.repositoryChange) throw new Error('Expected retained native PR work');
        proposedWorktree = 'worktree' in result.repositoryChange ? result.repositoryChange.worktree?.path : undefined;
        const proposed = runScmExecutable(git.rootPath, 'git', ['show', `${result.repositoryChange.headCommit}:${git.trackedPath}`]);
        expect(proposed).toContain('nginx:1');
        expect(proposed).toContain('postgres');
        expect(proposed).toContain('${DB_PASSWORD}');
        expect(writes).toHaveLength(failurePhase === 'bindings' ? 1 : 0);
        if (failurePhase === 'bindings') expect(writes[0]).toEqual({ serverId: 'home', environmentId: current.environment.id,
            expectedRevision: current.environment.revision, set: expect.arrayContaining([
                expect.objectContaining({ purpose: 'variable', name: 'DB_PASSWORD', phase: 'runtime',
                    source: expect.objectContaining({ kind: 'secret' }) }),
            ]), remove: [] });
        expect(current.content.definition.kind).toBe('repository');
        expect(await readFile(join(git.rootPath, git.trackedPath), 'utf8')).toBe(document);
        expect(runScmExecutable(git.rootPath, 'git', ['rev-parse', 'HEAD'])).toBe(baseCommit);
    } finally {
        if (previousGlobalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previousGlobalGitConfig;
        if (proposedWorktree) await rm(proposedWorktree, { recursive: true, force: true });
        await hostGitConfig?.cleanup();
        await rm(git.rootPath, { recursive: true, force: true });
        await fixture.close();
    }
});
