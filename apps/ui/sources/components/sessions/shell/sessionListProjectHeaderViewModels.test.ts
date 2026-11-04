import { describe, expect, it, vi } from 'vitest';
import * as workspaceDisplay from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { t } from '@/text';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListIndexWithServerScope } from '@/sync/store/sessionListIndex/buildSessionListIndexWithServerScope';
import { projectSessionSectionListIndex } from '@/sync/domains/session/organization/sections';
import { buildSessionFolderAssignmentKey } from '@/sync/domains/session/folders/assignmentKeys';
import { projectGroupIdentityKey, readSessionListProjectDisplay } from '@/sync/domains/workspaces/projectGroupDisplay';
import { buildSessionSectionMoveMenuItems, readSessionSectionMoveMenuChoice } from '@/components/sessions/organization/sessionSectionMoveMenu';

import { buildSessionListProjectHeaderViewModels } from './sessionListProjectHeaderViewModels';
import { buildSessionListRowViewModels } from './sessionListRowViewModels';
import { sessionTagKey } from './sessionTagUtils';

describe('buildSessionListProjectHeaderViewModels', () => {
    it('does not retain a full Session list in the bounded header projection cache', async () => {
        const { Session: InspectorSession } = await import('node:inspector');
        const retained = (() => {
            const listItems: SessionListIndexItem[] = [
                { type: 'session', serverId: 'header-retention-home', sessionId: 'header-retention-row' },
                { type: 'header', headerKind: 'project', groupKey: 'header-retention-group', title: '/retention' },
            ];
            const projectOrganizations = [{ key: { kind: 'project-organization' as const, serverId: 'header-retention-home', projectKey: 'project' },
                revision: 1, value: { label: 'Private label' } }];
            buildSessionListProjectHeaderViewModels({ listItems, workspaceRefs: [], projectOrganizations });
            return { list: new WeakRef(listItems), organizations: new WeakRef(projectOrganizations) };
        })();
        const inspector = new InspectorSession();
        inspector.connect();
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
            expect(retained.list.deref(), 'header labels must not retain the full Session list').toBeUndefined();
            expect(retained.organizations.deref(), 'header labels must not retain superseded organization bodies').toBeUndefined();
        } finally { inspector.disconnect(); }
    });
    it('updates the affected name-collision group and preserves locked and unlisted naming', () => {
        const machines = ['a', 'b', 'c'].map(id => createMachineFixture({ id,
            metadata: { ...createMachineFixture().metadata!, host: `build-${id}`, displayName: id === 'c' ? 'Other' : 'Build' } }));
        const input = { listItems: machines.map(machine => ({ type: 'header' as const, headerKind: 'project' as const,
            groupKey: machine.id, title: '/repo', workspaceScopeHint: { serverId: 'collision-home', machineId: machine.id, rootPath: '/repo' } })),
            machinesById: new Map(machines.map(machine => [machine.id, machine])), workspaceRefs: [], workspaceLabels: {} };
        const first = buildSessionListProjectHeaderViewModels(input);
        expect(first.projectHeaderViewModelByGroupKey.get('b')?.machineSubtitle).toBe('Build · build-b');
        input.machinesById.set('a', { ...machines[0]!, metadata: { ...machines[0]!.metadata!, displayName: 'Renamed' } });
        const renamed = buildSessionListProjectHeaderViewModels(input);
        expect(renamed.projectHeaderViewModelByGroupKey.get('b')?.machineSubtitle).toBe('Build');
        expect(renamed.projectHeaderViewModelByGroupKey.get('c')).toBe(first.projectHeaderViewModelByGroupKey.get('c'));
        input.machinesById.set('a', { ...machines[0]!, metadata: null, availability: { kind: 'locked', reason: 'decryption_failed' } });
        expect(buildSessionListProjectHeaderViewModels(input).projectHeaderViewModelByGroupKey.get('a')?.machineSubtitle)
            .toBe(t('machine.lockedMachine'));
        input.machinesById.delete('a');
        expect(buildSessionListProjectHeaderViewModels(input).projectHeaderViewModelByGroupKey.get('a')?.machineSubtitle)
            .toBe(t('machine.unlistedMachine'));
    });
    it('updates only Machine labels while keeping Project structure unchanged on a rename', () => {
        const machines = Array.from({ length: 20 }, (_, i) => createMachineFixture({ id: `header-machine-${i}`,
            metadata: { ...createMachineFixture().metadata!, displayName: `Machine ${i}` } }));
        const input = { listItems: machines.map(machine => ({ type: 'header' as const, headerKind: 'project' as const,
            groupKey: machine.id, title: '/repo', workspaceScopeHint: { serverId: 'header-home', machineId: machine.id, rootPath: '/repo' } })),
            machinesById: new Map(machines.map(machine => [machine.id, machine])), workspaceRefs: [], workspaceLabels: {} };
        const before = buildSessionListProjectHeaderViewModels(input);
        const derive = vi.spyOn(workspaceDisplay, 'resolveWorkspaceDisplayPresentation');
        try {
            input.machinesById.set(machines[0]!.id, { ...machines[0]!, metadata: { ...machines[0]!.metadata!, displayName: 'Renamed' } });
            const after = buildSessionListProjectHeaderViewModels(input);
            expect(after.projectHeaderViewModelByGroupKey.get(machines[0]!.id)?.machineSubtitle).toBe('Renamed');
            expect(after.scopeHintByLegacyWorkspaceKey).toBe(before.scopeHintByLegacyWorkspaceKey);
            expect(after.projectDisplayByKey).toBe(before.projectDisplayByKey);
            expect(after.groupProjectByGroupKey).toBe(before.groupProjectByGroupKey);
            expect(derive).not.toHaveBeenCalled();
            expect(after.projectHeaderViewModelByGroupKey.get(machines[1]!.id)).toBe(before.projectHeaderViewModelByGroupKey.get(machines[1]!.id));
        } finally { derive.mockRestore(); }
    });
    it('keeps the project path when hydration omits the redundant scope hint', () => {
        const project = { t: 'workspaceScope' as const, serverId: 'stable-home', machineId: 'stable-machine', rootPath: '/home/ubuntu/release' };
        const input = { listItems: [{ type: 'header' as const, headerKind: 'project' as const,
            groupKey: 'stable-project', title: 'No folder', workspace: project }], workspaceRefs: [], workspaceLabels: {} };
        const first = buildSessionListProjectHeaderViewModels(input);
        expect(first.projectHeaderViewModelByGroupKey.get('stable-project')?.displayTitle).toBe('release');
        const moved = buildSessionListProjectHeaderViewModels({ ...input,
            listItems: [{ ...input.listItems[0]!, workspace: { ...project, rootPath: '/home/ubuntu/another' } }] });
        expect(moved.projectHeaderViewModelByGroupKey.get('stable-project')?.displayTitle).toBe('another');
    });
    it('keeps the Chats identity despite an inherited legacy workspace label', () => {
        const inheritedLabel = buildSessionListProjectHeaderViewModels({
            listItems: [{
                type: 'header', title: 'Chats', headerKind: 'project',
                groupKey: 'managed-chats', workspaceKey: 'managed-label',
            }],
            workspaceRefs: [],
            workspaceLabels: { 'managed-label': 'Old custom label' },
        });
        expect(inheritedLabel.projectHeaderViewModelByGroupKey.get('managed-chats')?.displayTitle).toBe('Chats');
        const result = buildSessionListProjectHeaderViewModels({
            listItems: [{
                type: 'header', title: 'Chats', headerKind: 'project',
                groupKey: 'managed-chats', workspaceKey: 'managed-label',
                workspace: { t: 'managedSessions', serverId: 'server-a', machineId: 'machine-a' },
            }],
            workspaceRefs: [],
            workspaceLabels: { 'managed-label': 'Old custom label' },
        });
        expect(result.projectHeaderViewModelByGroupKey.get('managed-chats')).toMatchObject({
            displayTitle: 'Chats', hasCustomLabel: false, workspaceRefId: null, scopeHint: null,
        });
    });
    it('reuses a shared empty state when there are no project headers', () => {
        const first = buildSessionListProjectHeaderViewModels({
            listItems: [],
            workspaceRefs: [],
            workspaceLabels: {},
        });
        const second = buildSessionListProjectHeaderViewModels({
            listItems: [
                {
                    type: 'header',
                    title: 'Today',
                    headerKind: 'date',
                    groupKey: 'server:server-a:day:2026-02-19',
                },
            ] as any,
            workspaceRefs: [],
            workspaceLabels: {},
        });

        expect(first).toBe(second);
        expect(first.projectHeaderViewModelByGroupKey).toBe(second.projectHeaderViewModelByGroupKey);
        expect(first.scopeHintByLegacyWorkspaceKey).toBe(second.scopeHintByLegacyWorkspaceKey);
        expect(first.projectHeaderViewModelByGroupKey.size).toBe(0);
        expect(first.scopeHintByLegacyWorkspaceKey.size).toBe(0);
    });

    it('uses the accepted Project baseline without binding unresolved headers to private checkout facts', () => {
        const scopeHint = {
            serverId: 'server_a',
            machineId: 'machine_a',
            rootPath: '/repo',
        };

        const input = {
            listItems: [
                {
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'project:repo',
                    workspaceKey: 'legacy_repo',
                    projectKey: { serverId: 'server_a', projectKey: 'wr_1' },
                    workspaceScopeHint: scopeHint,
                    serverId: 'server_a',
                    serverName: 'Server A',
                },
            ] satisfies SessionListIndexItem[],
            workspaceRefs: [
                {
                    id: 'wr_1',
                    serverId: 'server_a',
                    machineId: 'machine_a',
                    rootPath: '/repo',
                    label: 'Important Repo',
                    createdAtMs: 1,
                    lastOpenedAtMs: null,
                },
            ],
            workspaceLabels: {},
        };
        const result = buildSessionListProjectHeaderViewModels(input);

        expect(result.scopeHintByLegacyWorkspaceKey.get('legacy_repo')).toEqual(scopeHint);
        expect(result.projectHeaderViewModelByGroupKey.get('project:repo')).toMatchObject({
            collapseKey: 'project:repo',
            displayTitle: 'Important Repo',
            hasCustomLabel: false,
            legacyWorkspaceKey: 'legacy_repo',
            scopeHint,
            workspaceRefId: 'wr_1',
        });
        const fallback = buildSessionListProjectHeaderViewModels({ ...input, listItems: [{
            type: 'header', headerKind: 'project', title: '/repo', groupKey: 'unresolved-exact-checkout',
            serverId: 'server_a', workspaceScopeHint: scopeHint,
        }] });
        expect(fallback.projectHeaderViewModelByGroupKey.get('unresolved-exact-checkout')).toMatchObject({
            displayTitle: 'repo', workspaceRefId: null, hasCustomLabel: false,
        });
    });

    it('ignores migrated legacy labels when no canonical workspace scope hint exists', () => {
        const result = buildSessionListProjectHeaderViewModels({
            listItems: [
                {
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'project:repo',
                    workspaceKey: 'legacy_repo',
                    serverId: 'server_a',
                    serverName: 'Server A',
                },
            ] as any,
            workspaceRefs: [],
            workspaceLabels: {
                legacy_repo: 'Legacy Label',
            },
        });

        expect(result.scopeHintByLegacyWorkspaceKey.size).toBe(0);
        expect(result.projectHeaderViewModelByGroupKey.get('project:repo')).toMatchObject({
            collapseKey: 'project:repo',
            displayTitle: 'repo',
            hasCustomLabel: false,
            legacyWorkspaceKey: 'legacy_repo',
            scopeHint: null,
            workspaceRefId: null,
        });
    });

    it('uses the workspace basename for unlabeled project headers by default', () => {
        const result = buildSessionListProjectHeaderViewModels({
            listItems: [
                {
                    type: 'header',
                    title: '~/Documents/Development/happier/remote-dev',
                    headerKind: 'project',
                    groupKey: 'project:repo',
                    workspaceKey: 'legacy_repo',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine_a',
                        rootPath: '/Users/lee/Documents/Development/happier/remote-dev',
                    },
                    serverId: 'server_a',
                    serverName: 'Server A',
                },
            ] as any,
            workspaceRefs: [],
            workspaceLabels: {},
        });

        expect(result.projectHeaderViewModelByGroupKey.get('project:repo')).toMatchObject({
            displayTitle: 'remote-dev',
            hasCustomLabel: false,
        });
    });

    it('reuses the same project-header state for identical non-empty inputs', () => {
        const listItems = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'project:repo',
                workspaceKey: 'legacy_repo',
                projectKey: { serverId: 'server_a', projectKey: 'wr_1' },
                workspaceScopeHint: {
                    serverId: 'server_a',
                    machineId: 'machine_a',
                    rootPath: '/repo',
                },
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ] satisfies SessionListIndexItem[];

        const workspaceRefs = [
            {
                id: 'wr_1',
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: '/repo',
                label: 'Important Repo',
                createdAtMs: 1,
                lastOpenedAtMs: null,
            },
        ];

        const first = buildSessionListProjectHeaderViewModels({
            listItems,
            workspaceRefs,
            workspaceLabels: {},
        });
        const second = buildSessionListProjectHeaderViewModels({
            listItems: [...listItems],
            workspaceRefs: [...workspaceRefs],
            workspaceLabels: {},
        });

        expect(first).toBe(second);
        expect(first.projectHeaderViewModelByGroupKey).toBe(second.projectHeaderViewModelByGroupKey);
        expect(first.scopeHintByLegacyWorkspaceKey).toBe(second.scopeHintByLegacyWorkspaceKey);
        expect(first.projectHeaderViewModelByGroupKey.get('project:repo')).toMatchObject({
            collapseKey: 'project:repo',
            displayTitle: 'Important Repo',
            hasCustomLabel: false,
            legacyWorkspaceKey: 'legacy_repo',
            workspaceRefId: 'wr_1',
        });
    });
});
describe('project header state identity', () => {
    // Each case owns its Home so the process-wide caches cannot couple cases.
    const fixture = (home: string) => {
        const machine = createMachineFixture({ id: `${home}-machine`, metadata: { ...createMachineFixture().metadata!, displayName: 'Box' } });
        const refs = Array.from({ length: 6 }, (_, i) => ({ id: `wr_${i}`, serverId: home, machineId: machine.id,
            rootPath: `/repo-${i}`, label: `Repo ${i}`, createdAtMs: 1, lastOpenedAtMs: null }));
        const headers = (m: typeof machine) => refs.map((ref, i) => ({ type: 'header' as const, headerKind: 'project' as const,
            groupKey: `g${i}`, title: ref.rootPath, workspaceKey: `legacy_${i}`, projectKey: { serverId: home, projectKey: ref.id },
            serverId: home, machine: m }));
        return { machine, refs, headers };
    };

    it('keeps the previous state when only a volatile machine presence fact and the list identity changed', () => {
        const { machine, refs, headers } = fixture('identity-volatile');
        const first = buildSessionListProjectHeaderViewModels({ listItems: headers(machine), workspaceRefs: refs.map(r => ({ ...r })) });
        const second = buildSessionListProjectHeaderViewModels({
            listItems: [...headers({ ...machine, activeAt: machine.activeAt + 1, updatedAt: machine.updatedAt + 1 }),
                { type: 'session', serverId: 'identity-volatile', sessionId: 's1' }],
            workspaceRefs: refs.map(r => ({ ...r })),
        });
        expect(second).toBe(first);
    });

    it('gives a new identity only to the entries a real change touches', () => {
        const { machine, refs, headers } = fixture('identity-change');
        const first = buildSessionListProjectHeaderViewModels({ listItems: headers(machine), workspaceRefs: refs });
        const second = buildSessionListProjectHeaderViewModels({ listItems: headers(machine), workspaceRefs: refs,
            projectOrganizations: [{ key: { kind: 'project-organization' as const, serverId: 'identity-change', projectKey: 'wr_2' },
                revision: 1, value: { label: 'Renamed' } }] });
        expect(second).not.toBe(first);
        for (const [key, entry] of first.projectHeaderViewModelByGroupKey) {
            if (key === 'g2') expect(second.projectHeaderViewModelByGroupKey.get(key)?.displayTitle).toBe('Renamed');
            else expect(second.projectHeaderViewModelByGroupKey.get(key)).toBe(entry);
        }
        for (const [key, entry] of first.projectDisplayByKey) {
            if (!key.includes('wr_2')) expect(second.projectDisplayByKey.get(key)).toBe(entry);
        }
        expect(second.scopeHintByLegacyWorkspaceKey).toBe(first.scopeHintByLegacyWorkspaceKey);
        expect(second.groupProjectByGroupKey).toBe(first.groupProjectByGroupKey);
    });

    it('does not rebuild the project display index while its inputs keep their identity', () => {
        const { machine, refs, headers } = fixture('identity-index');
        const first = buildSessionListProjectHeaderViewModels({ listItems: headers(machine), workspaceRefs: refs });
        const second = buildSessionListProjectHeaderViewModels({ listItems: headers(machine).map(h => ({ ...h, title: 'changed' })), workspaceRefs: refs });
        expect(second.projectDisplayByKey).toBe(first.projectDisplayByKey);
    });
});

describe('accepted Project title ownership', () => {
    it('keeps the admitted keyless Home folder display after its only row is filed', () => {
        const serverId = 'headerless-keyless-home';
        const session = createSessionListRenderableSessionFixture({ id: 'filed-keyless-member', projectKey: null,
            encryptionMode: 'plain', metadata: { host: 'test.local', machineId: 'keyless-machine', path: '/home/person', homeDir: '/home/person' } });
        const section = { address: { serverId, sectionId: 'leads' },
            display: { status: 'available' as const, value: { name: 'Leads', icon: null } }, sortKey: null };
        const base = buildSessionListIndexWithServerScope({ sessions: { [session.id]: session }, machines: {},
            serverScope: { serverId }, layoutV1: 'projects' });
        const baseDisplay = buildSessionListProjectHeaderViewModels({ listItems: base, workspaceRefs: [] });
        expect([...baseDisplay.projectHeaderViewModelByGroupKey.values()].map(header => header.displayTitle)).toEqual(['Home folder']);
        const listItems = projectSessionSectionListIndex({
            source: base.filter(item => item.type === 'session'), sections: [section],
            assignmentsBySessionKey: { [buildSessionFolderAssignmentKey(serverId, session.id)]: section.address.sectionId },
        }).items;
        const filed = listItems.find((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session')!;
        expect(filed.projectKey).toBeUndefined();
        expect(filed.workspace).toMatchObject({ t: 'workspaceScope', serverId, machineId: 'keyless-machine', rootPath: '/home/person' });
        const display = buildSessionListProjectHeaderViewModels({ listItems, workspaceRefs: [] });
        expect(display.projectHeaderViewModelByGroupKey.size).toBe(0);
        const models = buildSessionListRowViewModels({ listItems,
            rowRenderableByKey: new Map([[sessionTagKey(serverId, session.id), session]]),
            reachableSessionDisplayById: new Map(), relativeNowMs: 1_000, runtimeNowMs: 1_000,
            pinnedSessionKeys: new Set(), sessionTags: {}, selectedSessionId: null, showServerBadge: false, showPinnedServerBadge: false,
            rowContext: { enabled: true, identityDisplay: 'agentLogo', projectDisplayByKey: display.projectDisplayByKey,
                groupProjectByGroupKey: display.groupProjectByGroupKey },
        });
        expect(models.find(model => model !== null)?.rowContext?.project?.label).toBe('Home folder');
        const projectTitle = readSessionListProjectDisplay(filed, display.projectDisplayByKey)?.title ?? null;
        const menu = buildSessionSectionMoveMenuItems({ serverId, sections: [section], currentSectionIds: [filed.folderId ?? null],
            projectTitle, canCreate: true });
        expect(menu.find(item => readSessionSectionMoveMenuChoice(item.id)?.kind === 'project')?.title).toBe('Back to Home folder');
        const recent = buildSessionListIndexWithServerScope({ sessions: { [session.id]: session }, machines: {},
            serverScope: { serverId }, layoutV1: 'recent_activity' });
        const recentRow = recent.find((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session')!;
        expect(readSessionListProjectDisplay(recentRow, display.projectDisplayByKey)?.title).toBe('Home folder');
        // Publishing a key withdraws this transient fallback even before private Project display arrives.
        expect(readSessionListProjectDisplay({ ...filed, projectKey: { serverId, projectKey: 'published' } }, display.projectDisplayByKey))
            .toBeUndefined();
    });

    it('keeps a filed row’s accepted Project name in its context and Back menu without a Project header', () => {
        const serverId = 'headerless-project-home';
        const project = { serverId, projectKey: 'headerless-project' };
        const session = createSessionListRenderableSessionFixture({ id: 'only-filed-member', projectKey: project.projectKey,
            encryptionMode: 'plain', metadata: { host: 'test.local', machineId: 'headerless-machine', path: '/home/person', homeDir: '/home/person' } });
        const section = { address: { serverId, sectionId: 'leads' },
            display: { status: 'available' as const, value: { name: 'Leads', icon: null } }, sortKey: null };
        const base = buildSessionListIndexWithServerScope({ sessions: { [session.id]: session }, machines: {},
            serverScope: { serverId }, layoutV1: 'projects' });
        const listItems = projectSessionSectionListIndex({
            source: base.filter(item => item.type === 'session'), sections: [section],
            assignmentsBySessionKey: { [buildSessionFolderAssignmentKey(serverId, session.id)]: section.address.sectionId },
        }).items;
        expect(listItems.some(item => item.type === 'header' && item.headerKind === 'project')).toBe(false);
        const filed = listItems.find((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session')!;
        expect(filed.projectKey).toEqual(project);

        const workspaceRefs = [{ id: 'headerless-ref', ...project, machineId: 'headerless-machine', rootPath: '/home/person',
            label: 'Home folder', createdAtMs: 1 }];
        const display = buildSessionListProjectHeaderViewModels({ listItems, workspaceRefs,
            projectOrganizations: [{ key: { kind: 'project-organization', ...project }, revision: 1, value: { label: 'Release home' } }] });
        expect(display.projectHeaderViewModelByGroupKey.size).toBe(0);
        const projectTitle = display.projectDisplayByKey.get(projectGroupIdentityKey(project))?.title ?? null;
        expect(projectTitle).toBe('Release home');
        const models = buildSessionListRowViewModels({ listItems,
            rowRenderableByKey: new Map([[sessionTagKey(serverId, session.id), session]]),
            reachableSessionDisplayById: new Map(), relativeNowMs: 1_000, runtimeNowMs: 1_000,
            pinnedSessionKeys: new Set(), sessionTags: {}, selectedSessionId: null, showServerBadge: false, showPinnedServerBadge: false,
            rowContext: { enabled: true, identityDisplay: 'agentLogo', projectDisplayByKey: display.projectDisplayByKey,
                groupProjectByGroupKey: display.groupProjectByGroupKey },
        });
        expect(models.find(model => model !== null)?.rowContext?.project?.label).toBe('Release home');
        const menu = buildSessionSectionMoveMenuItems({ serverId, sections: [section], currentSectionIds: [filed.folderId ?? null],
            projectTitle, canCreate: true });
        expect(menu.find(item => readSessionSectionMoveMenuChoice(item.id)?.kind === 'project')?.title).toBe('Back to Release home');

        const reset = buildSessionListProjectHeaderViewModels({ listItems, workspaceRefs, projectOrganizations: [] });
        expect(reset.projectDisplayByKey.get(projectGroupIdentityKey(project))?.title).toBe('Home folder');
        const unavailable = buildSessionListProjectHeaderViewModels({ listItems, workspaceRefs: [], projectOrganizations: [] });
        expect(unavailable.projectDisplayByKey.get(projectGroupIdentityKey(project))).toBeUndefined();
    });

    it('uses the Project label and stable first accepted checkout without legacy workspace labels', async () => {
        const projectKey = { serverId: 'title-home', projectKey: 'anchor' };
        const first = { id: 'old', serverId: 'title-home', projectKey: 'anchor', machineId: 'offline', rootPath: '/old/repo', label: 'First checkout', createdAtMs: 1 };
        const recent = { ...first, id: 'new', machineId: 'online', rootPath: '/new/repo', label: 'New checkout', createdAtMs: 2 };
        const groupKey = JSON.stringify(['project', projectKey.serverId, projectKey.projectKey]);
        const input = { listItems: [{ type: 'header' as const, headerKind: 'project' as const, title: 'Pending', groupKey, workspaceKey: groupKey, projectKey }],
            workspaceRefs: [recent, first], workspaceLabels: { [groupKey]: 'Retired label' },
            projectOrganizations: [{ key: { kind: 'project-organization' as const, ...projectKey }, revision: 3, value: { label: 'Project name', hidden: true } }] };
        const result = buildSessionListProjectHeaderViewModels(input).projectHeaderViewModelByGroupKey.get(groupKey);
        expect(result).toMatchObject({ displayTitle: 'Project name', workspaceRefId: first.id, hasCustomLabel: true,
            scopeHint: { serverId: 'title-home', machineId: 'offline', rootPath: '/old/repo' } });
        const reset = buildSessionListProjectHeaderViewModels({ ...input, projectOrganizations: [] })
            .projectHeaderViewModelByGroupKey.get(groupKey);
        expect(reset).toMatchObject({ displayTitle: 'First checkout', hasCustomLabel: false, workspaceRefId: first.id });
        buildSessionListProjectHeaderViewModels({ ...input, projectOrganizations: [],
            workspaceRefs: [{ ...first, rootPath: '/repo|part', label: 'label' }],
        });
        const changed = buildSessionListProjectHeaderViewModels({ ...input, projectOrganizations: [],
            workspaceRefs: [{ ...first, rootPath: '/repo', label: 'part|label' }],
        }).projectHeaderViewModelByGroupKey.get(groupKey);
        expect(changed).toMatchObject({ displayTitle: 'part|label',
            scopeHint: { serverId: 'title-home', machineId: 'offline', rootPath: '/repo' } });
    });
});
