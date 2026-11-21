import { beforeEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import type { DeploySuggestionCatalogV1, DeploySuggestionRecommendationV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import { renderDeployPlanBriefV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import { DEPLOY_BUILD_PREVIEW_OWN_SERVER_RULES_V1 } from '@happier-dev/protocol/deployments/deploymentValidationV1';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { bindPresentUserActionConfirmationV1 } = await import('@happier-dev/protocol/actions/executor/approvalReview');
    return { ...actual, createFrontDoorActionExecute: () => actual.createFrontDoorActionExecute({ execute,
        executeConfirmed: (actionId, input, context) => execute(actionId, input,
            bindPresentUserActionConfirmationV1(actionId, input, { ...context,
                runtimeAccountId: 'alice', actionRequestId: 'reviewed-create' })),
    }) };
});
import { applyDeploySuggestion } from './applyDeploySuggestion';

const catalog: DeploySuggestionCatalogV1 = { starters: [{ id: '["starters","website"]', title: 'Website', sourceId: 'starters', itemId: 'website' }], apps: [
    { id: 'analytics', title: 'Analytics', sourceId: 'apps', itemId: 'analytics' }],
    targets: [{ id: 'own', title: 'Own server', targetClass: 'ownServer', availability: 'available' }], machines: [], stores: [], forges: [{ providerKind: 'github', title: 'GitHub' }] };
const suggestion: DeploySuggestionRecommendationV1 = { source: { kind: 'catalogApp', appId: 'analytics' }, targetId: 'own',
    title: 'Analytics', why: 'It fits what you described.', whatToBuild: 'Analytics', stack: { framework: 'compose', output: 'compose' }, data: { kind: 'none' }, variables: [] };
beforeEach(() => { execute.mockReset(); });

it('applies a catalog app to Where without creating a Project, Session or Environment', async () => {
    execute.mockImplementation(createActionExecutor({}).execute);
    expect(await applyDeploySuggestion({ serverId: 'home', suggestion, description: 'Analytics', catalog })).toEqual({
        kind: 'where', app: { sourceId: 'apps', itemId: 'analytics' }, targetId: 'own',
    });
    expect(execute).not.toHaveBeenCalled();
});

it('keeps starter creation behind the existing reviewed creation operands', async () => {
    execute.mockImplementation(createActionExecutor({}).execute);
    const starter = { ...suggestion, source: { kind: 'starter' as const, starterId: '["starters","website"]' } };
    expect(await applyDeploySuggestion({ serverId: 'home', suggestion: starter, description: '  Bakery\n', catalog }))
        .toEqual({ kind: 'needsCreateInput' });
    expect(execute).not.toHaveBeenCalled();
});

it('sends the original description through the real starter Action and retains the owner failure for repair', async () => {
    execute.mockImplementation(createActionExecutor({ registryActionExecute: async () => ({ pages: [] }) }).execute);
    const result = await applyDeploySuggestion({ serverId: 'home',
        suggestion: { ...suggestion, source: { kind: 'starter', starterId: '["starters","website"]' } }, description: '  Bakery\n', catalog,
        create: { input: { machineId: 'machine', requestKey: 'intent', destinationParentPath: '/projects',
            destinationDirectoryName: 'bakery', repository: { providerKind: 'github', owner: 'alice', name: 'bakery', visibility: 'private' } },
        lifetime: { scope: { serverId: 'home', accountId: 'alice' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) } },
    });
    expect(result).toMatchObject({ kind: 'failed', code: 'starter_unavailable', creation: { kind: 'failed', phase: 'starter' } });
    expect(execute.mock.calls.map(row => row[0])).toEqual(['projects.starters.create']);
    expect(execute.mock.calls[0]![1]).toMatchObject({ source: { kind: 'starter', starterId: 'website', sourceId: 'starters' },
        description: renderDeployPlanBriefV1('  Bakery\n', { ...suggestion, source: { kind: 'starter', starterId: '["starters","website"]' } },
            { providerKind: 'github', owner: 'alice', name: 'bakery', visibility: 'private' }, catalog.targets[0]) });
});

it.each(['starter', 'scratch'] as const)('resumes %s creation and opens ordinary Session authoring with the returned handoff', async (kind) => {
    const repository = { provider: { id: 'happier.scm.forge.github/github', kind: 'github' as const,
        displayName: 'GitHub', baseUrl: 'https://github.com' }, repository: { nameWithOwner: 'alice/bakery',
        cloneUrl: 'https://github.com/alice/bakery.git', webUrl: 'https://github.com/alice/bakery' }, protocol: 'https' as const };
    const executor = createActionExecutor({
        projectSourcesCreate: async value => ({ ok: true, canManage: true, source: { name: value.name,
            repository: value.repository, defaultRef: value.defaultRef, id: 'source', revision: 1,
            audience: [], createdByAccountId: 'alice' } }),
        projectsOpen: async () => ({ kind: 'opened', workspace: { serverId: 'home', machineId: 'machine',
            workspaceId: 'workspace', rootPath: '/projects/bakery' }, directory: '/projects/bakery',
            setup: 'notRequired', facts: { projectKey: 'project' } }),
        sessionAuthoringOpen: async () => ({ kind: 'opened', draftId: 'draft', destination: 'newSession' }),
    });
    execute.mockImplementation(executor.execute);
    expect(await applyDeploySuggestion({ serverId: 'home', suggestion: { ...suggestion,
        source: kind === 'starter' ? { kind, starterId: '["starters","website"]' } : { kind } }, description: '  Bakery\n', catalog,
        create: { input: { machineId: 'machine', requestKey: 'retry', destinationParentPath: '/projects',
            destinationDirectoryName: 'bakery', repository: { providerKind: 'github', owner: 'alice', name: 'bakery', visibility: 'private' },
            resume: { directory: '/projects/bakery', repositoryUrl: 'https://github.com/alice/bakery', repository, commit: 'abc' } },
        lifetime: { scope: { serverId: 'home', accountId: 'alice' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) } },
    })).toMatchObject({ kind: 'created', sessionOpened: true, creation: { projectId: 'project' } });
    expect(execute.mock.calls.map(row => row[0])).toEqual(['projects.starters.create', 'session.authoring.open']);
    expect(execute.mock.calls[0]![2]).toMatchObject({ presentUserConfirmation: { actionId: 'projects.starters.create',
        inputDigest: expect.any(String) } });
    const expectedBrief = renderDeployPlanBriefV1('  Bakery\n', { ...suggestion,
        source: kind === 'starter' ? { kind, starterId: '["starters","website"]' } : { kind } },
        { providerKind: 'github', owner: 'alice', name: 'bakery', visibility: 'private' }, catalog.targets[0]);
    // The chosen target is Own server, so its brief carries the Compose and own-server input.
    expect(expectedBrief).toContain(DEPLOY_BUILD_PREVIEW_OWN_SERVER_RULES_V1);
    expect(execute.mock.calls[1]![1]).toMatchObject({ seed: { prompt: expectedBrief, placement: {
        kind: 'exactTarget', serverId: 'home', machineId: 'machine', directory: '/projects/bakery' } } });
});
