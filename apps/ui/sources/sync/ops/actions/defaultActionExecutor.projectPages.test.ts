import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { PROJECT_PAGES } from '@/components/workspaceCockpit/project/projectCockpitState';
import { createScmCapabilities, ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';
import { storage } from '@/sync/domains/state/storage';
import { workspaceScopeFromProject } from '@/sync/domains/workspaces/workspaceScope';

// Home transport, device credentials and sockets are system boundaries. The
// Action registry, admitted Project rows and page catalog remain real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor, resolveDefaultActionInvocationServerId } = await import('./defaultActionExecutor');
const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
let releaseProjection: (() => void) | undefined;
let serverId: string;

beforeEach(async () => {
    await homes.reset();
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Project Home', serverUrl: 'https://project-pages.test', accountId: 'reader' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const key = { kind: 'workspace-ref' as const, serverId, id: 'checkout' };
    homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body: { status: 'listed', coverage: 'complete', rows: [
        { key, revision: 1, content: { t: 'plain', v: { key, value: {
            id: 'checkout', serverId, machineId: 'offline-machine', rootPath: '/repo', projectKey: 'logical-project', createdAtMs: 1,
        } } } },
    ] } });
});
afterEach(async () => { releaseProjection?.(); releaseProjection = undefined; await homes.reset(); });

describe('Project page discovery through the default Action host', () => {
    it.each(['unpublished', 'retired', 'scope-unavailable'] as const)('refuses a %s catalog instead of claiming only built-in pages exist', async state => {
        if (state === 'retired') {
            const retire = publishCommittedAppShellPluginUiProjection(() => EMPTY_PLUGIN_UI_PROJECTION);
            retire();
        } else if (state === 'scope-unavailable') {
            releaseProjection = publishCommittedAppShellPluginUiProjection(() => null);
        }
        expect(await createDefaultActionExecutor().execute('projects.pages.list', { workspaceRefId: 'checkout', serverId },
            { serverId, expectedAccountId: 'reader', surface: 'ui' }))
            .toMatchObject({ ok: false, errorCode: 'project_page_catalog_unavailable' });
    });

    it('distinguishes a committed empty plugin catalog from an unavailable catalog', async () => {
        releaseProjection = publishCommittedAppShellPluginUiProjection(() => EMPTY_PLUGIN_UI_PROJECTION);
        const result = await createDefaultActionExecutor().execute('projects.pages.list', { workspaceRefId: 'checkout', serverId },
            { serverId, expectedAccountId: 'reader', surface: 'ui' });
        expect(result).toMatchObject({ ok: true, result: { pages: expect.arrayContaining([{ id: 'overview', kind: 'builtin',
            title: expect.any(String), icon: expect.any(String), href: expect.any(String), disabledReason: null }]) } });
        if (!result.ok) throw new Error('A committed empty plugin catalog still admits built-in pages');
        const { ProjectPagesListOutputV1Schema } = await import('@happier-dev/protocol/actions/projectActionFamily');
        expect(ProjectPagesListOutputV1Schema.parse(result.result).pages.every(page => page.kind === 'builtin')).toBe(true);
    });

    it('selects the qualified input Home without requiring an invocation context', () => {
        expect(resolveDefaultActionInvocationServerId('projects.pages.list', { workspaceRefId: 'checkout', serverId })).toBe(serverId);
    });

    it('lists host-generated builtins and an external portable page without opening a Project or selecting a Machine', async () => {
        const binding = normalizePluginUiDestinationBindingV1({ pluginId: 'example.project', destinationId: 'notebook',
            rendererId: 'notebook-renderer', container: 'appPage', target: { kind: 'project' } });
        if (!binding) throw new Error('The public Project page must have an admitted binding');
        const placement = { id: 'surfacePlacement:example.project:notebook', pluginId: 'example.project',
            contributionKind: 'surfacePlacement' as const, descriptorId: 'notebook', binding, target: binding.target,
            renderer: { kind: 'reactNative', contributionId: 'notebook-renderer' },
            display: { title: 'Notebook', iconToken: 'info' }, headerActions: [],
            availability: { state: 'available' as const, reason: 'available', diagnostics: [] } };
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, surfacePlacementsById: { [placement.id]: placement } };
        releaseProjection = publishCommittedAppShellPluginUiProjection(input => (
            input?.scope.serverId === serverId && input.scope.accountId === 'reader' ? projection : null
        ));
        const result = await createDefaultActionExecutor().execute('projects.pages.list', { workspaceRefId: 'checkout', serverId },
            { serverId, expectedAccountId: 'reader', surface: 'ui' });
        expect(result).toMatchObject({ ok: true, result: { pages: [
            ...PROJECT_PAGES.map(id => ({ id, kind: 'builtin', disabledReason: null })),
            { id: 'plugin:example.project:notebook', title: 'Notebook', kind: 'plugin', disabledReason: null,
                destination: { pluginId: 'example.project', localId: 'notebook' } },
        ] } });
        const { ProjectPagesListOutputV1Schema } = await import('@happier-dev/protocol/actions/projectActionFamily');
        if (!result.ok) throw new Error('Page discovery must return its closed result');
        const page = ProjectPagesListOutputV1Schema.parse(result.result).pages.find(value => value.kind === 'plugin');
        const href = new URL(page?.href ?? '', 'https://ui.test');
        expect(href.pathname).toBe('/projects/checkout/plugins/example.project/notebook');
        expect(href.searchParams.get('serverId')).toBe(serverId);
        expect(homes.requests.filter(request => /machine.*rpc|\/scm|\/artifacts|workspace.*open/u.test(request.path))).toHaveLength(0);
    });

    it('refuses an unknown addressed checkout instead of returning another Project or an empty successful catalog', async () => {
        expect(await createDefaultActionExecutor().execute('projects.pages.list', { workspaceRefId: 'missing', serverId },
            { serverId, expectedAccountId: 'reader', surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'workspace_not_found' });
    });

    it('evaluates page policy against the admitted managed checkout snapshot', async () => {
        const checkout = {
            v: 2, kind: 'managed', id: 'managed-checkout', serverId, managedId: 'managed-resource',
            controller: { machineId: 'controller', installationId: 'installation' },
            rootPath: '/repo', projectKey: 'logical-project', createdAtMs: 1,
        } as const;
        const key = { kind: 'workspace-ref' as const, serverId, id: checkout.id };
        homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body: { status: 'listed', coverage: 'complete', rows: [
            { key, revision: 1, content: { t: 'plain', v: { key, value: checkout } } },
        ] } });
        const controllerScope = { serverId, machineId: checkout.controller.machineId, rootPath: checkout.rootPath };
        const managedScope = workspaceScopeFromProject(checkout, checkout.rootPath);
        const snapshot = ScmWorkingSnapshotSchema.parse({
            projectKey: checkout.projectKey, fetchedAt: 1,
            repo: { isRepo: true, rootPath: checkout.rootPath, backendId: 'git', mode: '.git' },
            capabilities: createScmCapabilities({ readStatus: true }),
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            hasConflicts: false, entries: [],
            totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
                includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
            hostingProvider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com',
                nameWithOwner: 'example/remote', urlSafety: { allowedSchemes: ['https:'] } },
        });
        const binding = normalizePluginUiDestinationBindingV1({ pluginId: 'example.project', destinationId: 'notebook',
            rendererId: 'notebook-renderer', container: 'appPage', target: { kind: 'project' } });
        if (!binding) throw new Error('The public Project page must have an admitted binding');
        const placement = { id: 'surfacePlacement:example.project:notebook', pluginId: 'example.project',
            contributionKind: 'surfacePlacement' as const, descriptorId: 'notebook', binding, target: binding.target,
            renderer: { kind: 'reactNative', contributionId: 'notebook-renderer' },
            display: { title: 'Notebook', iconToken: 'info' }, headerActions: [],
            availability: { state: 'available' as const, reason: 'available', diagnostics: [], when: {
                fact: 'project.repository.kind', operator: 'equals', value: 'github',
            } as const } };
        releaseProjection = publishCommittedAppShellPluginUiProjection(() => ({
            ...EMPTY_PLUGIN_UI_PROJECTION, surfacePlacementsById: { [placement.id]: placement },
        }));
        storage.getState().updateWorkspaceScmSnapshot(controllerScope, { ...snapshot, hostingProvider: null });
        storage.getState().updateWorkspaceScmSnapshot(managedScope, snapshot);
        try {
            const result = await createDefaultActionExecutor().execute('projects.pages.list', { workspaceRefId: checkout.id, serverId },
                { serverId, expectedAccountId: 'reader', surface: 'ui' });
            expect(result).toMatchObject({ ok: true, result: { pages: expect.arrayContaining([
                expect.objectContaining({ id: 'plugin:example.project:notebook', disabledReason: null }),
            ]) } });
        } finally {
            storage.getState().updateWorkspaceScmSnapshot(controllerScope, null);
            storage.getState().updateWorkspaceScmSnapshot(managedScope, null);
        }
    });

    it('refuses an input Home different from the captured Action Home', async () => {
        const other = await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-project-pages.test', accountId: 'other', active: false });
        expect(await createDefaultActionExecutor().execute('projects.pages.list', { workspaceRefId: 'checkout', serverId: other },
            { serverId, expectedAccountId: 'reader', surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    });
});
