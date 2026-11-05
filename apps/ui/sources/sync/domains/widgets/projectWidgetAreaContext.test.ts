import { expect, it, vi } from 'vitest';
import { MMKV } from 'react-native-mmkv';
import { scopedStorageId } from '@/utils/system/storageScope';
import { readProjectWidgetAreaContextV1 } from './projectWidgetAreaContext';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createStore } from 'zustand/vanilla';
import { evaluatePluginUiPolicy } from '@/sync/domains/plugins/ui/policy';
import { ScmHostingProviderKindSchema, type ScmHostingProviderRef } from '@happier-dev/protocol/scm/pullRequests';

it('keeps a repository-less Source authoritative over stale checkout facts and publishes only real changes', () => {
    const checkout = WorkspaceRefV1Schema.parse({ id: 'checkout', projectKey: 'project', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
        source: { sourceId: 'source', revision: 1 }, repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' } });
    const source: ProjectSourceV1 = { id: 'source', revision: 2, name: 'Production', audience: [], createdByAccountId: 'owner' };
    const input = { serverId: 'home', projectRef: checkout, activeCheckout: checkout, source: { serverId: 'home', source } };
    const first = readProjectWidgetAreaContextV1(input);
    expect(first.status).toBe('ready');
    expect(first.target?.source?.source).toBe(source);
    expect(first.target).not.toHaveProperty('repository');
    expect(first.providedContext.project).toEqual([{ serverId: 'home', ...source }]);
    const store = createStore(() => first);
    const notified = vi.fn();
    const stop = store.subscribe(notified);
    try {
        for (let i = 0; i < 20; i += 1) store.setState(readProjectWidgetAreaContextV1(structuredClone(input), store.getState()), true);
        expect(notified).toHaveBeenCalledTimes(0);
        const repository = { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' } satisfies NonNullable<ProjectSourceV1['repository']>;
        store.setState(readProjectWidgetAreaContextV1({ ...input, source: { serverId: 'home', source: { ...source, revision: 3, repository } } }, store.getState()), true);
        expect(notified).toHaveBeenCalledTimes(1);
        expect(store.getState().target?.repository).toEqual(checkout.repositoryIdentity);
        store.setState(readProjectWidgetAreaContextV1(input, store.getState()), true);
        expect(notified).toHaveBeenCalledTimes(2);
        expect(store.getState().target).not.toHaveProperty('repository');
    } finally { stop(); }
});

it('publishes only the accepted checkout current branch and retracts it for detached or unknown observations', () => {
    const checkout = WorkspaceRefV1Schema.parse({ id: 'checkout', projectKey: 'project', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 });
    const snapshot = { hostingProvider: null, branch: { head: 'feature/ci', headOid: 'abc123', upstream: null, upstreamOid: undefined, ahead: 0, behind: 0, detached: false } };
    const first = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout, snapshot });
    expect(first.target).toMatchObject({ kind: 'project', projectKey: 'project', branch: 'feature/ci' });
    const equal = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout, snapshot: structuredClone(snapshot) }, first);
    expect(equal).toBe(first);
    const changed = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout, snapshot: { ...snapshot, branch: { ...snapshot.branch, head: 'next' } } }, first);
    expect(changed.target).toMatchObject({ branch: 'next' });
    expect(changed.target?.checkout).toBe(first.target?.checkout);
    expect(changed.providedContext).toBe(first.providedContext);
    expect(changed.policyContext).toBe(first.policyContext);
    const detached = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout, snapshot: { ...snapshot, branch: { ...snapshot.branch, detached: true } } }, changed);
    expect(detached.target).not.toHaveProperty('branch');
    expect(readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout }, first).target).not.toHaveProperty('branch');
    expect(readProjectWidgetAreaContextV1({ serverId: 'home', projectRef: checkout, snapshot }).target).not.toHaveProperty('branch');
});

it('reconciles relevant equal admitted refreshes before publication without admitting refs again', () => {
    const ref = WorkspaceRefV1Schema.parse({ id: 'checkout', projectKey: 'project', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
        source: { sourceId: 'source', revision: 1 }, repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' } });
    const source: ProjectSourceV1 = { id: 'source', revision: 1, name: 'Repo', audience: [], createdByAccountId: 'owner', repository: {
        provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' }, repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' } };
    let current = true;
    const authority = { isCurrent: () => current };
    const first = readProjectWidgetAreaContextV1({ serverId: 'home', projectRef: ref, activeCheckout: ref, source: { serverId: 'home', source }, authority });
    const store = createStore(() => first);
    const notified = vi.fn();
    const stop = store.subscribe(notified);
    const admission = vi.spyOn(WorkspaceRefV1Schema, 'safeParse');
    const repositoryAdmission = vi.spyOn(ScmHostingProviderKindSchema, 'safeParse');
    try {
        for (let i = 0; i < 20; i += 1) {
            store.setState(readProjectWidgetAreaContextV1({ serverId: 'home', projectRef: structuredClone(ref), activeCheckout: structuredClone(ref),
                source: { serverId: 'home', source: structuredClone(source) }, authority }, store.getState()), true);
        }
        expect(notified).toHaveBeenCalledTimes(0);
        expect(admission).toHaveBeenCalledTimes(0);
        expect(repositoryAdmission).toHaveBeenCalledTimes(0);
        expect(store.getState()).toBe(first);
        expect(first.target).toMatchObject({ kind: 'project', projectKey: 'project', checkout: ref, source: { serverId: 'home', source }, repository: ref.repositoryIdentity });
        const changed = readProjectWidgetAreaContextV1({ serverId: 'home', projectRef: ref, activeCheckout: { ...ref, label: 'New checkout label' },
            source: { serverId: 'home', source }, authority }, first);
        expect(changed.target?.checkout).not.toBe(first.target?.checkout);
        expect(changed.target?.source).toBe(first.target?.source);
        expect(changed.target?.repository).toBe(first.target?.repository);
        expect(changed.projectIdentity).toBe(first.projectIdentity);
        expect(changed.providedContext.project).toBe(first.providedContext.project);
        expect(changed.providedContext.projects).toBe(first.providedContext.projects);
        expect(changed.policyContext).toBe(first.policyContext);
        const replaced = readProjectWidgetAreaContextV1({ serverId: 'home', projectRef: ref, activeCheckout: ref, source: { serverId: 'home', source }, authority: { isCurrent: () => true } }, first);
        expect(replaced).not.toBe(first);
        expect(replaced.target).not.toBe(first.target);
        current = false;
        const retired = readProjectWidgetAreaContextV1({ serverId: 'home', projectRef: ref, activeCheckout: ref, source: { serverId: 'home', source }, authority }, first);
        expect(retired).not.toBe(first);
        expect(retired.target).toBeNull();
        expect(retired.providedContext).toEqual({ project: [], checkout: [], projects: [] });
    } finally { stop(); admission.mockRestore(); repositoryAdmission.mockRestore(); }
});

it('keeps a generic Project target without a Source and distinguishes observed absence from an unloaded snapshot', () => {
    const checkout = { id: 'checkout', projectKey: 'logical-project', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
        repositoryIdentity: { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/repo' } };
    const unloaded = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout });
    expect(unloaded.target).toMatchObject({ kind: 'project', projectKey: 'logical-project', repository: checkout.repositoryIdentity });
    const matchingObservation = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout, snapshot: { hostingProvider: {
        id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] },
    } } }, unloaded);
    expect(matchingObservation).toBe(unloaded);
    const observed = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout, snapshot: { hostingProvider: null } }, unloaded);
    expect(observed.target?.repository).toBeUndefined();
    expect(observed.target?.checkout).toBe(unloaded.target?.checkout);
    expect(observed.target?.projectKey).toBe('logical-project');
    expect(observed.policyContext).not.toBe(unloaded.policyContext);
    const when = { fact: 'project.repository.kind', operator: 'notEquals', value: 'github' };
    expect(evaluatePluginUiPolicy({ availability: { when } }, observed.policyContext).visible).toBe(false);
    const unknown = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: { ...checkout,
        repositoryIdentity: { ...checkout.repositoryIdentity, kind: 'unknown' } } });
    expect(evaluatePluginUiPolicy({ availability: { when } }, unknown.policyContext).visible).toBe(true);
    expect(evaluatePluginUiPolicy({ availability: { when: { fact: 'project.id', operator: 'equals', value: 'logical-project' } } }, unknown.policyContext).visible).toBe(true);
});

it('uses the hosting identity owner to normalize retained checkout repository facts', () => {
    const checkout = WorkspaceRefV1Schema.parse({ id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
        repositoryIdentity: { kind: 'github', deployment: 'https://GITHUB.com/', repository: '/Owner/Repo/' } });
    const read = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout });
    expect(read.target?.repository).toEqual({ kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' });
    expect(read.target?.checkout).toBe(checkout);
});

it('does not publish hosting-provider display metadata as a Project context change', () => {
    const checkout = WorkspaceRefV1Schema.parse({ id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 });
    const provider: ScmHostingProviderRef = { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } };
    const first = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout, snapshot: { hostingProvider: provider } });
    const next = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: { ...checkout },
        snapshot: { hostingProvider: { ...provider, displayName: 'Updated display name' } } }, first);
    expect(next).toBe(first);
});

it('withholds a foreign or mismatched checkout Source and preserves unaffected leaves when Source metadata changes', () => {
    const ref = { id: 'checkout', projectKey: 'project', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
        source: { sourceId: 'source', revision: 1 } };
    const source: ProjectSourceV1 = { id: 'source', revision: 1, name: 'Repo', audience: [], createdByAccountId: 'owner', repository: {
        provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' }, repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' } };
    const first = readProjectWidgetAreaContextV1({ serverId: 'home', projectRef: ref, activeCheckout: ref, source: { serverId: 'home', source } });
    const next = readProjectWidgetAreaContextV1({ serverId: 'home', projectRef: ref, activeCheckout: ref,
        source: { serverId: 'home', source: { ...structuredClone(source), revision: 2, name: 'Renamed' } } }, first);
    expect(next.target?.source).not.toBe(first.target?.source);
    expect(next.target?.source?.source.repository).toBe(first.target?.source?.source.repository);
    expect(next.target?.repository).toBe(first.target?.repository);
    expect(next.target?.checkout).toBe(first.target?.checkout);
    expect(next.policyContext).toBe(first.policyContext);
    const absent = readProjectWidgetAreaContextV1({ serverId: 'home', projectRef: ref, activeCheckout: { ...ref, source: undefined }, source: { serverId: 'home', source } }, first);
    expect(absent.target?.source).toBeUndefined();
    expect(absent.projectIdentity).toBe(first.projectIdentity);
});

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
