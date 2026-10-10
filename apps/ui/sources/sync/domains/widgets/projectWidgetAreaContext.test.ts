import { expect, it, vi } from 'vitest';
import { MMKV } from 'react-native-mmkv';
import { scopedStorageId } from '@/utils/system/storageScope';
import { readProjectWidgetAreaContextV1 } from './projectWidgetAreaContext';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

it('supplies the plural Usage projects slot from admitted identity without changing singular Project/checkout semantics', () => {
    const projectRef = { id: 'base', projectKey: 'opaque-project', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    expect(readProjectWidgetAreaContextV1({ serverId: 'home', projectRef }).providedContext)
        .toEqual({ project: [], checkout: [], projects: [['opaque-project']] });
    expect(readProjectWidgetAreaContextV1({ serverId: 'other-home', projectRef }).providedContext)
        .toEqual({ project: [], checkout: [], projects: [] });
});

it('projects only a same-Home authorized matching Source, without treating provenance revision as an eligibility gate', () => {
    const checkout = { id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
        projectKey: 'project', source: { sourceId: 'source', revision: 1 } };
    const source: ProjectSourceV1 = { id: 'source', revision: 9, name: 'Renamed', audience: [], createdByAccountId: 'owner',
        repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' } };
    const read = (serverId: string, value: ProjectSourceV1 | null) => readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout,
        ...{ source: value ? { serverId, source: value } : null } });
    expect(read('home', source)).toMatchObject({ status: 'ready', providedContext: { project: [{ serverId: 'home', ...source }], checkout: [checkout] } });
    for (const unavailable of [read('other-home', source), read('home', { ...source, id: 'other-source' }), read('home', null)]) {
        expect(unavailable).toMatchObject({ status: 'unavailable', providedContext: { project: [], checkout: [checkout] },
            projectIdentity: { serverId: 'home', projectKey: 'project' } });
    }
});

it('retains the stable layout anchor when no active checkout has been accepted', () => {
    const projectRef = { id: 'base', projectKey: 'project', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    expect(readProjectWidgetAreaContextV1({ serverId: 'home', projectRef })).toMatchObject({
        projectIdentity: { serverId: 'home', projectKey: 'project' }, providedContext: { checkout: [], project: [] },
    });
});

it('admits only an actual checkout of the same stable Project, never another anchor or Home', () => {
    const projectRef = { id: 'base', projectKey: 'project', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    const activeCheckout = { ...projectRef, id: 'accepted-worktree', rootPath: '/feature' };
    expect(readProjectWidgetAreaContextV1({ serverId: 'home', projectRef, activeCheckout })).toMatchObject({
        projectIdentity: { serverId: 'home', projectKey: 'project' }, providedContext: { checkout: [{ id: 'accepted-worktree', rootPath: '/feature' }] },
    });
    for (const refused of [{ ...activeCheckout, projectKey: 'foreign' }, { ...activeCheckout, serverId: 'other-home' }]) {
        expect(readProjectWidgetAreaContextV1({ serverId: 'home', projectRef, activeCheckout: refused })).toMatchObject({
            projectIdentity: { serverId: 'home', projectKey: 'project' }, providedContext: { checkout: [] },
        });
    }
});

it('keeps the personal layout owner anchored while checkout facts gain a Source', () => {
    const checkout = { id: 'workspace', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
        projectKey: 'anchor' };
    const first = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout });
    const enriched = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: {
        ...checkout, source: { sourceId: 'source', revision: 2 },
    } });
    expect(first).toMatchObject({ projectIdentity: { serverId: 'home', projectKey: 'anchor' } });
    expect(enriched).toMatchObject({ projectIdentity: { serverId: 'home', projectKey: 'anchor' },
        providedContext: { checkout: [{ ...checkout, source: { sourceId: 'source', revision: 2 } }], project: [] } });
});

it('admits a stored Home alias once and supplies its canonical qualifier to the checkout binder', async () => {
    vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', 'project-widget-home-alias');
    const persisted = new MMKV({ id: scopedStorageId('server-profiles', 'project-widget-home-alias') });
    persisted.set('server-state-v1', JSON.stringify({ activeServerId: 'profile', servers: { profile: {
        id: 'profile', name: 'Home', serverUrl: 'https://project-widget.example.test',
        serverIdentityId: 'srv_project_widget_home', createdAt: 1, updatedAt: 1, lastUsedAt: 1,
    } } }));
    try {
        vi.resetModules();
        const { readProjectWidgetAreaContextV1: readFresh } = await import('./projectWidgetAreaContext');
        const context = readFresh({ serverId: 'srv_project_widget_home', projectRef: {
            id: 'base', serverId: 'profile', machineId: 'machine', rootPath: '/base', createdAtMs: 1,
        }, activeCheckout: {
            id: 'checkout', serverId: 'profile', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
            projectKey: 'base',
        } });
        expect(context).toMatchObject({ projectIdentity: { serverId: 'srv_project_widget_home', projectKey: 'base' },
            providedContext: { checkout: [{ id: 'checkout', serverId: 'srv_project_widget_home' }] } });
    } finally {
        persisted.delete('server-state-v1');
        vi.unstubAllEnvs();
        vi.resetModules();
    }
});
