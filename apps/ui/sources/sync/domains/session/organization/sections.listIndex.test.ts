import { describe, expect, it } from 'vitest';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionOrganizationSessionKey } from './keys';
import { buildSessionSectionGroupKey, projectSessionSectionListIndex, readLegacySessionFolderGroupScope,
    readLegacySessionSectionGroupAddress, readSessionSectionGroupAddress, type SessionSection } from './sections';

describe('projectSessionSectionListIndex', () => {
    it('reads only known qualified section scopes and keeps predecessor root wrappers read-only', () => {
        const address = { serverId: 'home-a', sectionId: 'section-a' };
        expect(readSessionSectionGroupAddress(buildSessionSectionGroupKey(address))).toEqual(address);
        const legacy = JSON.stringify(['folder-group', 'home-a', 'workspaceScope:home-a:machine:/path:with:colons', 'section-a']);
        expect(readLegacySessionSectionGroupAddress(legacy)).toEqual(address);
        expect(readSessionSectionGroupAddress(legacy)).toBeNull();
        const root = JSON.stringify(['folder-group', 'home-a', 'opaque workspace', null]);
        expect(readLegacySessionFolderGroupScope(root)).toEqual({ serverId: 'home-a', sectionId: null });
        expect(readLegacySessionSectionGroupAddress(root)).toBeNull();
        expect(readLegacySessionFolderGroupScope(JSON.stringify(['unknown', 'home-a', 'workspace', 'section-a']))).toBeNull();
    });

    it('files across Projects into flat qualified Account bands without workspace inference or changing Project roots', () => {
        const sections: SessionSection[] = [
            { address: { serverId: 'home-a', sectionId: 'nested' }, sortKey: 'a0',
                display: { status: 'available', value: { name: 'Queue', icon: null } },
                legacyContext: { ancestors: [{ address: { serverId: 'home-a', sectionId: 'parent' },
                    display: { status: 'available', value: { name: 'Legacy parent', icon: null } } }], workspace: null } },
            { address: { serverId: 'home-b', sectionId: 'nested' }, sortKey: 'a0',
                display: { status: 'available', value: { name: 'Other Account', icon: null } } },
            { address: { serverId: 'home-a', sectionId: 'locked' }, sortKey: 'a1',
                display: { status: 'locked', reason: 'account_key_unavailable' } },
        ];
        const firstProject: SessionListIndexItem = { type: 'header', headerKind: 'project', title: 'First',
            serverId: 'home-a', groupKey: 'canonical-project-first' };
        const secondProject: SessionListIndexItem = { type: 'header', headerKind: 'project', title: 'Second',
            serverId: 'home-a', groupKey: 'canonical-project-second' };
        const workspace = { t: 'workspaceScope', serverId: 'home-a', machineId: 'owner-machine', rootPath: '/actual/checkout' } as const;
        const source: SessionListIndexItem[] = [firstProject,
            { type: 'session', serverId: 'home-a', sessionId: 'first', groupKind: 'project', groupKey: firstProject.groupKey, workspace },
            { type: 'session', serverId: 'home-a', sessionId: 'unfiled', groupKind: 'project', groupKey: firstProject.groupKey },
            secondProject,
            { type: 'session', serverId: 'home-a', sessionId: 'second', groupKind: 'project', groupKey: secondProject.groupKey },
            { type: 'session', serverId: 'home-b', sessionId: 'first', groupKind: 'project', groupKey: 'other-home-project' },
        ];
        const result = projectSessionSectionListIndex({ source, sections, assignmentsBySessionKey: {
            [buildSessionOrganizationSessionKey('home-a', 'first')]: 'nested',
            [buildSessionOrganizationSessionKey('home-a', 'second')]: 'nested',
            [buildSessionOrganizationSessionKey('home-b', 'first')]: 'nested',
            [buildSessionOrganizationSessionKey('home-a', 'off-window')]: 'locked',
        } });
        const headers = result.items.filter((item): item is Extract<SessionListIndexItem, { type: 'header' }> => item.type === 'header' && item.headerKind === 'folder');
        expect(headers.map(item => [item.serverId, item.folderId, item.folderDepth])).toEqual([
            ['home-a', 'nested', 0], ['home-b', 'nested', 0], ['home-a', 'locked', 0],
        ]);
        expect(headers.every(item => item.workspace === undefined && item.workspaceScopeHint == null)).toBe(true);
        expect(headers[2]?.displayState).toEqual({ status: 'locked', reason: 'account_key_unavailable' });
        expect(headers[2]?.title).toBe('');
        expect(headers[2]?.eligibleCount).toBeUndefined(); // No loaded rows is not proof of zero members.
        const first = result.items.find(item => item.type === 'session' && item.serverId === 'home-a' && item.sessionId === 'first');
        expect(first).toMatchObject({ groupKind: 'folder', folderId: 'nested', folderDepth: 1,
            groupKey: buildSessionSectionGroupKey(sections[0]!.address), workspace });
        expect(result.items.flatMap(item => item.type === 'session' && item.groupKey === buildSessionSectionGroupKey(sections[0]!.address)
            ? [item.sessionId] : [])).toEqual(['first', 'second']);
        expect(result.items).toContain(firstProject);
        expect(result.items).toContain(secondProject);
        expect(result.items.find(item => item.type === 'session' && item.sessionId === 'unfiled')).toBe(source[2]);
        expect(headers.every(item => !item.groupKey?.includes('/actual/checkout'))).toBe(true);
    });

    it('keeps unfiled corpus references and does not invent unavailable definition membership', () => {
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', groupKey: 'today' },
            { type: 'session', serverId: 'home-a', sessionId: 'unfiled', groupKind: 'date', groupKey: 'today' },
        ];
        expect(projectSessionSectionListIndex({ source, sections: [], assignmentsBySessionKey: {} }).items).toBe(source);
        const result = projectSessionSectionListIndex({ source, sections: [], assignmentsBySessionKey: {
            [buildSessionOrganizationSessionKey('home-a', 'unfiled')]: 'not-loaded',
        } });
        expect(result.items).toEqual([source[0], { ...source[1], folderId: 'not-loaded' }]);
        expect(result.items[1]).toMatchObject({ groupKind: 'date', groupKey: 'today' });
    });
});
