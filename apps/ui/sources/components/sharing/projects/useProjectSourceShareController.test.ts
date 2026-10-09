import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createProjectSourceActionDeps } from '@/sync/api/projects/projectSourceActions';
import { createProjectSourcesController } from '@/components/projects/sources/projectSourcesController';
import { useProjectSourceShareController } from './useProjectSourceShareController';
import { AccountProfileSchema } from '@happier-dev/protocol';
import { getStorage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { ProjectSourcesUpdateInputV1Schema, type ProjectSourceRepositorySelectorV1,
    type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

const scope = { serverId: 'home-a', accountId: 'owner-a' };
const principal = { kind: 'team' as const, teamId: 'team-a' };
const repository = { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner: 'owner/repo', visibility: 'private' }, protocol: 'https' } satisfies ProjectSourceRepositorySelectorV1;

describe('Source audience ShareSheet controller', () => {
    it('presents the named creator as You and never exposes unresolved audience ids as names', async () => {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            ...createProjectSourceActionDeps({ ...scope, credentialAuthorityKind: 'account', assertCurrent() {}, workflowArtifacts: { read: async () => null },
                request: async () => Response.json({ ok: true, canManage: true, source: {
                    id: 'source-identity', revision: 1, name: 'Repository', createdByAccountId: scope.accountId, repository,
                    audience: [{ principal, level: 'view' }, { principal: { kind: 'account', accountId: 'unknown-person-id' }, level: 'view' }],
                } }),
            }),
        }));
        getStorage().setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId, firstName: 'Avery', lastName: 'Owner' }) });
        const controller = createProjectSourcesController(scope, (id, input, context) => executor.execute(id, input,
            { ...context, authority: 'present_user', bypassApprovals: true }));
        await controller.select('source-identity');
        const hook = await renderHook(() => useProjectSourceShareController({ controller, enabled: false }));
        expect(hook.getCurrent().model.owner?.principal.displayName).toBe('Avery Owner');
        expect(hook.getCurrent().model.owner?.principal.secondaryLabel).toBe(t('shareSheet.you'));
        expect(hook.getCurrent().model.grants.map(row => row.principal.displayName)).toEqual([t('shareSheet.team'), t('accountDisplay.unnamed')]);
        expect(hook.getCurrent().model.grants.map(row => row.principal.accessibilityLabel).join(' ')).not.toContain('unknown-person-id');
        await hook.unmount();
    });
    it('offers view-only audience and serializes additions and removals against acknowledged Source revisions', async () => {
        let source: ProjectSourceV1 = { id: 'source-a', revision: 1, name: 'Repository', createdByAccountId: scope.accountId,
            repository,
            audience: [] };
        const writes: unknown[] = [];
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            ...createProjectSourceActionDeps({ ...scope, credentialAuthorityKind: 'account', assertCurrent() {}, workflowArtifacts: { read: async () => null },
                request: async (_path, init) => {
                    if (init?.method === 'PATCH') {
                        const input = ProjectSourcesUpdateInputV1Schema.parse(JSON.parse(String(init.body)));
                        writes.push(input);
                        source = { ...source, revision: source.revision + 1, audience: input.patch.audience ?? source.audience };
                    }
                    return new Response(JSON.stringify({ ok: true, source, canManage: true }));
                },
            }),
        }));
        const controller = createProjectSourcesController(scope, (id, input, context) => executor.execute(id, input,
            { ...context, authority: 'present_user', bypassApprovals: true }));
        await controller.select(source.id);
        // Closed directory demand uses the real directory hook without Account/Team lookup traffic.
        const hook = await renderHook(() => useProjectSourceShareController({ controller, enabled: false }));
        await act(async () => { hook.getCurrent().actions.addPrincipal(principal); });
        expect(hook.getCurrent().model.grants[0].level).toEqual({ kind: 'editable', value: 'view', options: ['view'] });
        expect(hook.getCurrent().model.revision).toBe(2);
        await act(async () => { hook.getCurrent().actions.requestRemove(principal); });
        expect(hook.getCurrent().model.grants[0].removal.kind).toBe('confirming');
        await act(async () => { hook.getCurrent().actions.confirmRemove(principal); });
        expect(hook.getCurrent().model.grants).toEqual([]);
        expect(writes).toEqual([
            { serverId: scope.serverId, sourceId: source.id, expectedRevision: 1, patch: { audience: [{ principal, level: 'view' }] } },
            { serverId: scope.serverId, sourceId: source.id, expectedRevision: 2, patch: { audience: [] } },
        ]);
        await hook.unmount();
    });

    it('does not grant management from audience membership or creator identity', async () => {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            ...createProjectSourceActionDeps({ ...scope, credentialAuthorityKind: 'account', assertCurrent() {}, workflowArtifacts: { read: async () => null },
                request: async () => new Response(JSON.stringify({ ok: true, canManage: false, source: {
                    id: 'source-a', revision: 1, name: 'Repository', createdByAccountId: scope.accountId,
                    repository,
                    audience: [{ principal, level: 'view' }],
                } })),
            }),
        }));
        const controller = createProjectSourcesController(scope, (id, input, context) => executor.execute(id, input,
            { ...context, authority: 'present_user', bypassApprovals: true }));
        await controller.select('source-a');
        const hook = await renderHook(() => useProjectSourceShareController({ controller, enabled: false }));
        expect(hook.getCurrent().model.editable).toBe(false);
        await act(async () => { hook.getCurrent().actions.addPrincipal({ kind: 'team', teamId: 'other' }); });
        expect(controller.getSnapshot().current?.revision).toBe(1);
        expect(hook.getCurrent().model.grants).toHaveLength(1);
        await hook.unmount();
    });
});
