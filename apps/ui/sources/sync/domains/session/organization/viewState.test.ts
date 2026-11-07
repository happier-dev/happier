import { describe, expect, it } from 'vitest';

import {
    buildSessionOrganizationListViewState,
    buildSessionOrganizationListViewStateForServers,
    buildSessionOrganizationReorderRequestFromGroupOrder,
    buildSessionOrganizationReorderRequestFromWorkspaceOrder,
    completeSessionOrganizationOrderItemAddresses,
    partitionSessionFolderWritesByServerId,
    partitionSessionOrganizationGroupOrderByServerId,
    partitionSessionWorkspaceOrderByServerId,
} from './viewState';
import {
    buildSessionListFolderOrderItemKey,
    PINNED_GROUP_KEY_V1,
} from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { buildSessionWorkspaceOrderScopeKey } from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';
import { sessionAddressKey } from '../sessionAddress';
import type { SessionOrganizationProjection, UiSessionOrganizationFolder } from './types';
import { buildSessionOrganizationProjection } from './projection';
import { buildSessionOrganizationSessionKey } from './keys';
import type { SessionOrganizationOrderItemAddress } from './viewState';
import { resolveSessionSectionChoiceLabel } from './sections';
import {
    buildSessionFolderWorkspaceTargets,
    selectAvailableSessionFolders,
    type SessionFolderV1,
    type SessionFoldersV1,
} from '@/sync/domains/session/folders';

function folderKey(serverId: string, folderId: string): string {
    return buildSessionListFolderOrderItemKey({ serverId, folderId })!;
}

function projectOrganizationPins(
    serverId: string,
    pins: SessionOrganizationProjection['pinsBySessionId'] = {},
): SessionOrganizationProjection {
    return buildSessionOrganizationProjection({
        schemaVersionByServerId: { [serverId]: 1 },
        snapshotVersionByServerId: { [serverId]: 1 },
        pinsBySessionKey: Object.fromEntries(Object.values(pins).map((pin) => [
            buildSessionOrganizationSessionKey(serverId, pin.sessionId), pin,
        ])),
        foldersByFolderKey: {},
        folderAssignmentsBySessionKey: {},
        tagsByTagKey: {},
        tagAssignmentsBySessionKey: {},
        attentionStandingsBySessionKey: {},
        appearancesBySessionKey: {},
        sessionAppearancesSupportedByServerId: {},
        orderEntriesByScopeKey: {},
        labelsByLabelKey: {},
    }, serverId);
}

describe('buildSessionOrganizationListViewState', () => {
    it('retains private assignment evidence without projecting an internal membership as a locked tag chip', () => {
        const value = { kind: 'space_membership', spaceId: 'a', spaceSettingsTarget: { serverId: 'catalog', accountId: 'owner' } };
        const internal = { tagId: 'private', tagKey: 'private', display: { t: 'plain' as const, v: value },
            displayState: { status: 'available' as const, value }, sortKey: null, archivedAt: null, createdAt: 1, updatedAt: 1 };
        const projection = { ...projectOrganizationPins('home-a'), tagsById: { private: internal },
            tagAssignmentsBySessionId: { session: ['private'], empty: [] } };
        const state = buildSessionOrganizationListViewState({ serverId: 'home-a', projection });
        const key = buildSessionOrganizationSessionKey('home-a', 'session');
        expect(state.sessionTagsV1[key]).toEqual([]);
        expect(state.sessionTagIdsBySessionKey[key]).toBe(projection.tagAssignmentsBySessionId.session);
        expect(state.sessionTagIdsBySessionKey[buildSessionOrganizationSessionKey('home-a', 'empty')]).toEqual([]);
    });
    it('retains readable colour-only workspace labels without classifying them as locked', () => {
        const color = { kind: 'custom', hex: '#123456' } as const;
        const value = { color };
        const label = { labelKind: 'workspace' as const, scopeKey: 'colour-only', display: { t: 'plain' as const, v: value },
            displayState: { status: 'available' as const, value }, archivedAt: null, createdAt: 1, updatedAt: 1 };
        const state = buildSessionOrganizationListViewState({ serverId: 'color-only-home', projection: {
            ...projectOrganizationPins('color-only-home'), labelsByLabelKey: { opened: label,
                locked: { ...label, scopeKey: 'locked', displayState: { status: 'locked', reason: 'content_unreadable' } } },
        } });
        expect(state).toMatchObject({ workspaceColorsV1: { 'colour-only': color },
            workspaceLabelsV1: { 'colour-only': { status: 'available', value: '' } } });
        expect(state).not.toHaveProperty('workspaceColorsV1.locked');
    });

    it.each([
        { reason: null, expected: 'Unavailable section' },
        { reason: 'invalid_stored_display', expected: 'Unavailable section' },
        { reason: 'content_unreadable', expected: 'Unavailable section' },
        { reason: 'storage_mode_mismatch', expected: 'Unavailable section' },
        { reason: 'account_key_unavailable', expected: 'Locked section' },
    ] as const)('labels an unreadable Section from its admitted display state without inventing a name ($reason)', ({ reason, expected }) => {
        const folder: UiSessionOrganizationFolder = {
            folderId: 'retained-section', folderKey: 'retained-section', parentFolderId: null, parentFolderKey: null,
            sortKey: 'a0', display: reason === null ? null : { t: 'plain', v: { name: 'Do not disclose' } },
            displayState: reason === null ? { status: 'available', value: null } : { status: 'locked', reason },
            archivedAt: null, createdAt: 1, updatedAt: 1,
        };
        const state = buildSessionOrganizationListViewState({ serverId: 'home-a', projection: {
            ...projectOrganizationPins('home-a'), foldersById: { [folder.folderId]: folder },
        } });
        const section = state.sections[0]!;
        expect(resolveSessionSectionChoiceLabel(section, { unavailableLabel: 'Unavailable' }).title).toBe(expected);
        expect(section.display).toEqual({ status: 'locked', reason: reason ?? 'invalid_stored_display' });
        expect(section.address).toEqual({ serverId: 'home-a', sectionId: folder.folderId });
        expect(folder.display).toEqual(reason === null ? null : { t: 'plain', v: { name: 'Do not disclose' } });
    });

    it('retains controlled legacy breadcrumbs and same-name workspace context without disclosing locked ancestors', () => {
        const legacyFolder = (folderId: string, name: string, rootPath: string, parentFolderId: string | null = null): UiSessionOrganizationFolder => {
            const value = { name, workspace: { t: 'workspaceScope' as const, serverId: 'home-a', machineId: rootPath, rootPath } };
            return { folderId, folderKey: folderId, parentFolderId, parentFolderKey: parentFolderId,
                sortKey: 'a0', display: { t: 'plain', v: value }, displayState: { status: 'available', value },
                archivedAt: null, createdAt: 1, updatedAt: 1 };
        };
        const state = buildSessionOrganizationListViewState({ serverId: 'home-a', projection: {
            ...projectOrganizationPins('home-a'), foldersById: {
                first: legacyFolder('first', 'Queue', '/first'),
                second: legacyFolder('second', 'Queue', '/second'),
                parent: legacyFolder('parent', 'Reviews', '/first'),
                nested: legacyFolder('nested', 'Queue', '/first', 'parent'),
                locked: { ...legacyFolder('locked', 'Do not disclose', '/first'),
                    displayState: { status: 'locked', reason: 'account_key_unavailable' } },
                child: legacyFolder('child', 'Queue', '/first', 'locked'),
            },
        } });
        const byId = new Map(state.sections.map(section => [section.address.sectionId, section]));
        expect(byId.get('first')?.legacyContext?.workspace).toMatchObject({ rootPath: '/first' });
        expect(byId.get('second')?.legacyContext?.workspace).toMatchObject({ rootPath: '/second' });
        expect(byId.get('nested')?.legacyContext?.ancestors).toEqual([{
            address: { serverId: 'home-a', sectionId: 'parent' },
            display: { status: 'available', value: { name: 'Reviews', icon: null } },
        }]);
        expect(byId.get('child')?.legacyContext?.ancestors).toEqual([{
            address: { serverId: 'home-a', sectionId: 'locked' },
            display: { status: 'locked', reason: 'account_key_unavailable' },
        }]);
        expect(byId.get('locked')?.legacyContext).toBeUndefined();
        const label = (id: string) => resolveSessionSectionChoiceLabel(byId.get(id)!, { unavailableLabel: 'Unavailable' });
        expect(label('first')).toEqual({ title: 'Queue', contextLabel: '/first', choiceLabel: 'Queue — /first' });
        expect(label('second').choiceLabel).toBe('Queue — /second');
        expect(label('nested').choiceLabel).toBe('Queue — /first · Reviews');
        expect(label('child').choiceLabel).toBe('Queue — /first · Locked section');
        expect(label('locked').title).toBe('Locked section');
        const opaqueWorkspace = { ...byId.get('first')!, legacyContext: {
            ancestors: [], workspace: { t: 'workspaceRef' as const, serverId: 'home-a', workspaceRefId: 'opaque' },
        } };
        expect(resolveSessionSectionChoiceLabel(opaqueWorkspace, { unavailableLabel: 'Unavailable' }).choiceLabel)
            .toBe('Queue — Unavailable');
        expect(resolveSessionSectionChoiceLabel(opaqueWorkspace, { unavailableLabel: 'Unavailable',
            workspaceDisplayByKey: { 'workspaceRef:home-a:opaque': 'Held project name' } }).choiceLabel)
            .toBe('Queue — Held project name');
        expect(resolveSessionSectionChoiceLabel(byId.get('first')!, { unavailableLabel: 'Unavailable',
            workspaceDisplayByKey: { 'workspaceScope:home-a:/first:/first': null } }).choiceLabel)
            .toBe('Queue — Unavailable');
        expect(resolveSessionSectionChoiceLabel(opaqueWorkspace, { unavailableLabel: 'Unavailable',
            workspaceDisplayByKey: { 'workspaceRef:home-a:opaque': ' ' } }).choiceLabel)
            .toBe('Queue — Unavailable');
    });

    it('omits predecessor folder mixed-order entries from the current Session order', () => {
        const state = buildSessionOrganizationListViewState({ serverId: 'home-a', projection: {
            ...projectOrganizationPins('home-a'), orderEntriesByScopeKey: { group: [
                { scopeKind: 'group', scopeKey: 'group', itemKind: 'folder', itemKey: 'legacy-folder', sortKey: '0001' },
                { scopeKind: 'group', scopeKey: 'group', itemKind: 'session', itemKey: 'one', sortKey: '0002' },
            ] },
        } });
        expect(state.sessionListGroupOrderV1.group).toEqual([sessionAddressKey({ serverId: 'home-a', sessionId: 'one' })]);
    });
    it('projects Account sections with private icons and preserves unloaded assignment membership', () => {
        const projection = projectOrganizationPins('home-a');
        const state = buildSessionOrganizationListViewState({
            serverId: 'home-a',
            projection: {
                ...projection,
                folderAssignmentsComplete: true,
                foldersById: {
                    launch: {
                        folderId: 'launch', folderKey: 'launch', parentFolderId: null, parentFolderKey: null,
                        sortKey: '0002', display: { t: 'plain', v: { name: 'Launch', icon: 'rocket-outline' } },
                        displayState: { status: 'available', value: { name: 'Launch', icon: 'rocket-outline' } },
                        archivedAt: null, createdAt: 1, updatedAt: 1,
                    },
                    locked: {
                        folderId: 'locked', folderKey: 'locked', parentFolderId: null, parentFolderKey: null,
                        sortKey: '0001', display: { t: 'encrypted', c: 'sealed' },
                        displayState: { status: 'locked', reason: 'account_key_unavailable' },
                        archivedAt: null, createdAt: 1, updatedAt: 1,
                    },
                },
                folderAssignmentsBySessionId: { 'off-window': 'launch', 'filed-child-under-lead': 'launch' },
            },
        });
        expect(state.sections).toEqual([
            { address: { serverId: 'home-a', sectionId: 'locked' }, sortKey: '0001',
                display: { status: 'locked', reason: 'account_key_unavailable' } },
            { address: { serverId: 'home-a', sectionId: 'launch' }, sortKey: '0002',
                display: { status: 'available', value: { name: 'Launch', icon: 'rocket-outline' } } },
        ]);
        expect(state.sectionMemberSessionKeysBySectionKey['["home-a","launch"]']).toEqual([
            sessionAddressKey({ serverId: 'home-a', sessionId: 'off-window' }),
            sessionAddressKey({ serverId: 'home-a', sessionId: 'filed-child-under-lead' }),
        ]);
        expect(state.sectionMemberSessionKeysBySectionKey['["home-a","locked"]']).toEqual([]);
        expect(state.sectionMembershipCompleteByServerId).toEqual({ 'home-a': true });
    });
    it('composes exact per-Home organization state without allowing the active Home to overwrite another Home', () => {
        const makeProjection = (serverId: string, label: string, pinned: boolean): SessionOrganizationProjection => ({
            ...projectOrganizationPins(serverId, pinned
                ? { 'same-session': { sessionId: 'same-session', sortKey: '0001', pinnedAt: 1, listPinned: true, railPinned: false } }
                : {}),
            schemaVersion: 1,
            version: 1,
            foldersById: {
                [`folder-${serverId}`]: {
                    folderId: `folder-${serverId}`,
                    folderKey: `folder-${serverId}`,
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: '0001',
                    display: {
                        t: 'plain' as const,
                        v: {
                            name: `Folder ${serverId}`,
                            workspace: {
                                t: 'workspaceScope' as const,
                                serverId,
                                machineId: `machine-${serverId}`,
                                rootPath: '/repo',
                            },
                        },
                    },
                    displayState: { status: 'available' as const, value: null },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            folderAssignmentsBySessionId: { 'same-session': `folder-${serverId}` },
            tagsById: {
                [`tag-${serverId}`]: {
                    tagId: `tag-${serverId}`,
                    tagKey: `tag-${serverId}`,
                    sortKey: null,
                    display: { t: 'plain' as const, v: { label } },
                    displayState: { status: 'available' as const, value: { label } },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            tagAssignmentsBySessionId: { 'same-session': [`tag-${serverId}`] },
            attentionStandingsBySessionId: {
                'same-session': { sessionId: 'same-session', standing: pinned, updatedAt: 1 } as const,
            },
            orderEntriesByScopeKey: {
                group: [{
                    scopeKind: 'group' as const,
                    scopeKey: 'shared-order',
                    itemKind: 'session' as const,
                    itemKey: 'same-session',
                    sortKey: '0001',
                }],
            },
            labelsByLabelKey: {},
        });

        const state = buildSessionOrganizationListViewStateForServers({
            serverIds: ['home-a', 'home-b'],
            projectionsByServerId: {
                'home-a': makeProjection('home-a', 'Alpha', false),
                'home-b': makeProjection('home-b', 'Beta', true),
            },
        });
        const homeAKey = sessionAddressKey({ serverId: 'home-a', sessionId: 'same-session' });
        const homeBKey = sessionAddressKey({ serverId: 'home-b', sessionId: 'same-session' });

        expect(state.pinnedSessionKeysV1).toEqual([homeBKey]);
        expect(state.sessionTagsV1[homeAKey]).toEqual([
            { tagId: 'tag-home-a', display: { status: 'available', value: 'Alpha' } },
        ]);
        expect(state.sessionTagsV1[homeBKey]).toEqual([
            { tagId: 'tag-home-b', display: { status: 'available', value: 'Beta' } },
        ]);
        expect(state.attentionStandingOverridesBySessionKey).toEqual({
            [homeAKey]: { sessionId: 'same-session', standing: false, updatedAt: 1 },
            [homeBKey]: { sessionId: 'same-session', standing: true, updatedAt: 1 },
        });
        expect(state.sessionFolderAssignmentsBySessionKey).toEqual({
            [homeAKey]: 'folder-home-a',
            [homeBKey]: 'folder-home-b',
        });
        expect(state.sessionFoldersV1.folders.map((folder) => folder.id)).toEqual([
            'folder-home-a',
            'folder-home-b',
        ]);
        expect(state.sessionListGroupOrderV1['shared-order']).toEqual([homeAKey, homeBKey]);
    });

    it('projects only the selected Machine\'s persisted Chats folders into embed picker targets', () => {
        const state = buildSessionOrganizationListViewState({
            serverId: 'server-a',
            projection: {
                ...projectOrganizationPins('server-a'),
                schemaVersion: 1,
                version: 1,
                foldersById: {
                    'folder-leads': {
                        folderId: 'folder-leads',
                        folderKey: 'folder-leads',
                        parentFolderId: null,
                        parentFolderKey: null,
                        sortKey: '0001',
                        display: {
                            t: 'plain',
                            v: {
                                name: 'Leads',
                                workspace: {
                                    t: 'managedSessions',
                                    serverId: 'server-a',
                                    machineId: 'machine-a',
                                },
                            },
                        },
                        displayState: { status: 'available', value: null },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                    'folder-other-machine': {
                        folderId: 'folder-other-machine',
                        folderKey: 'folder-other-machine',
                        parentFolderId: null,
                        parentFolderKey: null,
                        sortKey: '0002',
                        display: {
                            t: 'plain',
                            v: {
                                name: 'Other Machine',
                                workspace: {
                                    t: 'managedSessions',
                                    serverId: 'server-a',
                                    machineId: 'machine-b',
                                },
                            },
                        },
                        displayState: { status: 'available', value: null },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                },
            },
        });

        expect(buildSessionFolderWorkspaceTargets({
            folders: selectAvailableSessionFolders(state.sessionFoldersV1),
            workspace: {
                t: 'managedSessions',
                serverId: 'server-a',
                machineId: 'machine-a',
            },
        })).toEqual([{ folderId: 'folder-leads', title: 'Leads', depth: 0 }]);
    });

    it('reads a folder written with a bare plain name (an Action caller\'s shorthand) as that name, not as unavailable', () => {
        const state = buildSessionOrganizationListViewState({
            serverId: 'server-a',
            projection: {
                ...projectOrganizationPins('server-a'),
                schemaVersion: 1,
                version: 1,
                foldersById: {
                    'folder-bare': {
                        folderId: 'folder-bare', folderKey: 'folder-bare', parentFolderId: null, parentFolderKey: null, sortKey: '0001',
                        display: { t: 'plain', v: 'J15b folder' },
                        displayState: { status: 'available', value: 'J15b folder' },
                        archivedAt: null, createdAt: 1, updatedAt: 2,
                    },
                },
            },
        });
        expect(state.sessionFoldersV1.folders.map((folder) => [folder.id, folder.name])).toEqual([['folder-bare', 'J15b folder']]);
    });

    it('projects every valid group and workspace ordering entry beyond 100 items', () => {
        const groupEntries = Array.from({ length: 111 }, (_, index) => ({
            scopeKind: 'group' as const,
            scopeKey: 'server:server-a:active',
            itemKind: 'session' as const,
            itemKey: `session-${index}`,
            sortKey: String(index).padStart(8, '0'),
        }));
        const workspaceEntries = Array.from({ length: 111 }, (_, index) => ({
            scopeKind: 'workspace' as const,
            scopeKey: 'server-a',
            itemKind: 'workspace' as const,
            itemKey: `workspace:/repo-${index}`,
            sortKey: String(index).padStart(8, '0'),
        }));

        const state = buildSessionOrganizationListViewState({
            serverId: 'server-a',
            projection: {
                ...projectOrganizationPins('server-a'),
                schemaVersion: 1,
                version: 1,
                foldersById: {},
                folderAssignmentsBySessionId: {},
                tagsById: {},
                tagAssignmentsBySessionId: {},
                attentionStandingsBySessionId: {},
                orderEntriesByScopeKey: {
                    group: groupEntries,
                    workspace: workspaceEntries,
                },
                labelsByLabelKey: {},
            },
        });

        expect(state.sessionListGroupOrderV1['server:server-a:active']).toHaveLength(111);
        expect(state.sessionListGroupOrderV1['server:server-a:active']?.[110]).toBe(
            sessionAddressKey({ serverId: 'server-a', sessionId: 'session-110' }),
        );
        const workspaceScopeKey = buildSessionWorkspaceOrderScopeKey('server-a');
        expect(state.sessionWorkspaceOrderV1[workspaceScopeKey]).toHaveLength(111);
        expect(state.sessionWorkspaceOrderV1[workspaceScopeKey]?.[110]).toBe('workspace:/repo-110');
    });

    it('projects session tag assignments as display labels instead of server tag ids', () => {
        const state = buildSessionOrganizationListViewState({
            serverId: 'server-a',
            projection: {
                ...projectOrganizationPins('server-a'),
                schemaVersion: 1,
                version: 4,
                foldersById: {},
                folderAssignmentsBySessionId: {},
                tagsById: {
                    tag_urgent: {
                        tagId: 'tag_urgent',
                        tagKey: 'legacy/tag/urgent',
                        sortKey: null,
                        display: { t: 'plain', v: { label: 'Urgent' } },
                        displayState: { status: 'available', value: { label: 'Urgent' } },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                    tag_unknown_label: {
                        tagId: 'tag_unknown_label',
                        tagKey: 'legacy/tag/unknown',
                        sortKey: null,
                        display: { t: 'plain', v: {} },
                        displayState: { status: 'available', value: {} },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                },
                tagAssignmentsBySessionId: {
                    'session-1': ['tag_urgent', 'tag_unknown_label', 'missing_tag'],
                },
                attentionStandingsBySessionId: {},
                orderEntriesByScopeKey: {},
                labelsByLabelKey: {},
            },
        });

        const sessionKey = sessionAddressKey({ serverId: 'server-a', sessionId: 'session-1' });
        expect(state.sessionTagsV1).toEqual({
            [sessionKey]: [
                {
                    tagId: 'tag_urgent',
                    display: { status: 'available', value: 'Urgent' },
                },
                {
                    tagId: 'tag_unknown_label',
                    display: {
                        status: 'locked',
                        reason: 'content_unreadable',
                    },
                },
                {
                    tagId: 'missing_tag',
                    display: {
                        status: 'locked',
                        reason: 'content_unreadable',
                    },
                },
            ],
        });
        expect(state.sessionTagDisplayStatesBySessionKey).toEqual({
            [sessionKey]: [
                {
                    tagId: 'tag_urgent',
                    display: { status: 'available', value: 'Urgent' },
                },
                {
                    tagId: 'tag_unknown_label',
                    display: { status: 'locked', reason: 'content_unreadable' },
                },
                {
                    tagId: 'missing_tag',
                    display: { status: 'locked', reason: 'content_unreadable' },
                },
            ],
        });
    });

    it('retains locked folder, tag, and label structure without using keys or ids as names', () => {
        const locked = {
            status: 'locked' as const,
            reason: 'account_key_unavailable' as const,
        };
        const state = buildSessionOrganizationListViewState({
            serverId: 'server-a',
            projection: {
                ...projectOrganizationPins('server-a', {
                    'session-1': { sessionId: 'session-1', sortKey: null, pinnedAt: 1, listPinned: true, railPinned: false },
                }),
                schemaVersion: 1,
                version: 9,
                foldersById: {
                    'folder-private-id': {
                        folderId: 'folder-private-id',
                        folderKey: 'private/folder/key',
                        parentFolderId: null,
                        parentFolderKey: null,
                        sortKey: null,
                        display: { t: 'encrypted', c: 'ciphertext' },
                        displayState: locked,
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                },
                folderAssignmentsBySessionId: {
                    'session-1': 'folder-private-id',
                },
                tagsById: {
                    'tag-private-id': {
                        tagId: 'tag-private-id',
                        tagKey: 'private/tag/key',
                        sortKey: null,
                        display: { t: 'encrypted', c: 'ciphertext' },
                        displayState: locked,
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                },
                tagAssignmentsBySessionId: {
                    'session-1': ['tag-private-id'],
                },
                attentionStandingsBySessionId: {
                    'session-1': { sessionId: 'session-1', standing: false, updatedAt: 3 },
                },
                orderEntriesByScopeKey: {
                    group: [{
                        scopeKind: 'group',
                        scopeKey: 'group',
                        itemKind: 'folder',
                        itemKey: 'folder-private-id',
                        sortKey: '0001',
                    }],
                },
                labelsByLabelKey: {
                    workspace: {
                        labelKind: 'workspace',
                        scopeKey: 'private/workspace/key',
                        display: { t: 'encrypted', c: 'ciphertext' },
                        displayState: locked,
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                },
            },
        });

        expect(state.folderDisplayStatesByFolderKey).toEqual({
            '["server-a","folder-private-id"]': locked,
        });
        expect(state.sessionFoldersV1.folders).toEqual([
            expect.objectContaining({
                id: 'folder-private-id',
                serverId: 'server-a',
                parentId: null,
                name: '',
                workspace: null,
                displayState: locked,
            }),
        ]);
        expect(state.labelDisplayStatesByKey).toEqual({
            workspace: locked,
        });
        expect(state.workspaceLabelsV1).toEqual({
            'private/workspace/key': locked,
        });
        const sessionKey = sessionAddressKey({ serverId: 'server-a', sessionId: 'session-1' });
        expect(state.sessionFolderAssignmentsBySessionKey).toEqual({
            [sessionKey]: 'folder-private-id',
        });
        expect(state.sessionListGroupOrderV1).toEqual({});
        expect(state.sessionTagsV1).toEqual({
            [sessionKey]: [{
                tagId: 'tag-private-id',
                display: locked,
            }],
        });
        expect(state.sessionTagDisplayStatesBySessionKey[sessionKey])
            .toEqual([{
                tagId: 'tag-private-id',
                display: locked,
            }]);
        // Keep the complete intent so timed reminders share the same canonical policy owner.
        expect(state.attentionStandingOverridesBySessionKey).toEqual({
            [sessionKey]: { sessionId: 'session-1', standing: false, updatedAt: 3 },
        });
    });
});

describe('buildSessionOrganizationReorderRequestFromGroupOrder', () => {
    it('uses the current structured address lookup without parsing URL-shaped session keys', () => {
        const firstKey = sessionAddressKey({ serverId: 'https://home.example.test:8443', sessionId: 'session:one' });
        const secondKey = sessionAddressKey({ serverId: 'https://home.example.test', sessionId: '8443:session:one' });
        const request = buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: 'https://home.example.test:8443',
            scopeKey: 'current-group',
            itemKeys: [firstKey, secondKey],
            orderItemAddressByItemKey: {
                [firstKey]: { itemKind: 'session', serverId: 'https://home.example.test:8443', sessionId: 'session:one' },
            },
        });

        expect(request?.entries).toEqual([
            { itemKind: 'session', itemKey: 'session:one', sortKey: '00000001' },
        ]);
    });

    it('retains released legacy import handling for server-scoped item keys', () => {
        const request = buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: 'srv_identity',
            serverIdAliases: ['server-profile-a'],
            scopeKey: 'server:srv_identity:active:project:repo',
            itemKeys: ['server-profile-a:session-a', 'folder:folder-a', 'srv_identity:session-b'],
            legacyServerScopedItemKeys: true,
        });

        expect(request?.entries).toEqual([
            { itemKind: 'session', itemKey: 'session-a', sortKey: '00000001' },
            { itemKind: 'folder', itemKey: 'folder-a', sortKey: '00000002' },
            { itemKind: 'session', itemKey: 'session-b', sortKey: '00000003' },
        ]);
    });
});

describe('multi-Home organization order writes', () => {
    const homeAKey = sessionAddressKey({ serverId: 'home-a', sessionId: 'same-session' });
    const homeBKey = sessionAddressKey({ serverId: 'home-b', sessionId: 'same-session' });
    const offscreenHomeAKey = sessionAddressKey({ serverId: 'home-a', sessionId: 'offscreen-session' });

    function makeOrderProjection(serverId: string): SessionOrganizationProjection {
        return {
            ...projectOrganizationPins(serverId, {
                'same-session': { sessionId: 'same-session', sortKey: '0001', pinnedAt: 1, listPinned: true, railPinned: false },
            }),
            schemaVersion: 1,
            version: 1,
            foldersById: {
                [`folder-${serverId}`]: {
                    folderId: `folder-${serverId}`,
                    folderKey: `folder-${serverId}`,
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: '0001',
                    display: { t: 'plain', v: { name: `Folder ${serverId}` } },
                    displayState: { status: 'available', value: { name: `Folder ${serverId}` } },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            folderAssignmentsBySessionId: {},
            tagsById: {},
            tagAssignmentsBySessionId: {},
            attentionStandingsBySessionId: {},
            orderEntriesByScopeKey: {
                pinned: [{
                    scopeKind: 'pinned',
                    scopeKey: 'pins',
                    itemKind: 'session',
                    itemKey: 'same-session',
                    sortKey: '0001',
                }],
                group: [
                    {
                        scopeKind: 'group',
                        scopeKey: 'shared-order',
                        itemKind: 'session',
                        itemKey: 'same-session',
                        sortKey: '0001',
                    },
                    {
                        scopeKind: 'group',
                        scopeKey: 'shared-order',
                        itemKind: 'folder',
                        itemKey: `folder-${serverId}`,
                        sortKey: '0002',
                    },
                ],
                workspace: [{
                    scopeKind: 'workspace',
                    scopeKey: serverId,
                    itemKind: 'workspace',
                    itemKey: `/repo-${serverId}`,
                    sortKey: '0001',
                }],
            },
            labelsByLabelKey: {},
        } as unknown as SessionOrganizationProjection;
    }

    function buildTwoHomeState() {
        return buildSessionOrganizationListViewStateForServers({
            serverIds: ['home-a', 'home-b'],
            projectionsByServerId: {
                'home-a': makeOrderProjection('home-a'),
                'home-b': makeOrderProjection('home-b'),
            },
        });
    }

    it('publishes an exact owning address for every order item it mints, not only visible rows', () => {
        const state = buildSessionOrganizationListViewState({
            serverId: 'home-a',
            projection: {
                ...makeOrderProjection('home-a'),
                attentionStandingsBySessionId: {
                    'offscreen-session': { sessionId: 'offscreen-session', standing: false, updatedAt: 1 },
                },
            } as unknown as SessionOrganizationProjection,
        });

        expect(state.orderItemAddressByItemKey[homeAKey]).toEqual({
            itemKind: 'session',
            serverId: 'home-a',
            sessionId: 'same-session',
        });
        // An item the current viewport never renders still has to resolve, otherwise a
        // reorder write would silently drop or corrupt it.
        expect(state.orderItemAddressByItemKey[offscreenHomeAKey]).toEqual({
            itemKind: 'session',
            serverId: 'home-a',
            sessionId: 'offscreen-session',
        });
        expect(state.orderItemAddressByItemKey[folderKey('home-a', 'folder-home-a')]).toEqual({
            itemKind: 'folder',
            serverId: 'home-a',
            folderId: 'folder-home-a',
        });
    });

    it('keeps two Homes distinct for the same Home-local Session id', () => {
        const state = buildTwoHomeState();

        expect(state.orderItemAddressByItemKey[homeAKey]).toEqual({
            itemKind: 'session',
            serverId: 'home-a',
            sessionId: 'same-session',
        });
        expect(state.orderItemAddressByItemKey[homeBKey]).toEqual({
            itemKind: 'session',
            serverId: 'home-b',
            sessionId: 'same-session',
        });
    });

    it('keeps two Homes distinct when they reuse the same Home-local folder id', () => {
        const withSharedFolderId = (serverId: string): SessionOrganizationProjection => ({
            ...makeOrderProjection(serverId),
            foldersById: {
                'same-folder': {
                    folderId: 'same-folder',
                    parentFolderId: null,
                    display: { t: 'plain', v: { name: `${serverId} folder` } },
                    displayState: { status: 'available', value: { name: `${serverId} folder` } },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            orderEntriesByScopeKey: {
                group: [{
                    scopeKind: 'group',
                    scopeKey: 'shared-order',
                    itemKind: 'folder',
                    itemKey: 'same-folder',
                    sortKey: '0001',
                }],
            },
        } as unknown as SessionOrganizationProjection);
        const state = buildSessionOrganizationListViewStateForServers({
            serverIds: ['home-a', 'home-b'],
            projectionsByServerId: {
                'home-a': withSharedFolderId('home-a'),
                'home-b': withSharedFolderId('home-b'),
            },
        });
        const folderEntries = Object.entries(state.orderItemAddressByItemKey)
            .filter(([, address]) => address.itemKind === 'folder');

        expect(folderEntries).toHaveLength(2);
        expect(new Set(folderEntries.map(([itemKey]) => itemKey)).size).toBe(2);
        expect(folderEntries.map(([, address]) => address)).toEqual(expect.arrayContaining([
            { itemKind: 'folder', serverId: 'home-a', folderId: 'same-folder' },
            { itemKind: 'folder', serverId: 'home-b', folderId: 'same-folder' },
        ]));
        expect(state.sessionListGroupOrderV1['shared-order']).toBeUndefined();
        expect(partitionSessionOrganizationGroupOrderByServerId({
            next: state.sessionListGroupOrderV1,
            orderItemAddressByItemKey: state.orderItemAddressByItemKey,
        })).toEqual({});
    });

    it('never hands one Home a request built from another Home items', () => {
        const state = buildTwoHomeState();
        const sharedOrder = state.sessionListGroupOrderV1['shared-order'] ?? [];
        expect(sharedOrder).toEqual([
            homeAKey,
            homeBKey,
        ]);

        const homeARequest = buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: 'home-a',
            scopeKey: 'shared-order',
            itemKeys: sharedOrder,
            orderItemAddressByItemKey: state.orderItemAddressByItemKey,
        });
        const homeBRequest = buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: 'home-b',
            scopeKey: 'shared-order',
            itemKeys: sharedOrder,
            orderItemAddressByItemKey: state.orderItemAddressByItemKey,
        });

        expect(homeARequest?.entries).toEqual([
            { itemKind: 'session', itemKey: 'same-session', sortKey: '00000001' },
        ]);
        expect(homeBRequest?.entries).toEqual([
            { itemKind: 'session', itemKey: 'same-session', sortKey: '00000001' },
        ]);
    });

    it('applies the same exact-Home selection to the pinned scope', () => {
        const state = buildTwoHomeState();
        const pinnedOrder = state.sessionListGroupOrderV1[PINNED_GROUP_KEY_V1] ?? [];
        expect(pinnedOrder).toEqual([homeAKey, homeBKey]);

        const request = buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: 'home-a',
            scopeKey: PINNED_GROUP_KEY_V1,
            itemKeys: pinnedOrder,
            orderItemAddressByItemKey: state.orderItemAddressByItemKey,
        });

        expect(request?.scopeKind).toBe('pinned');
        expect(request?.scopeKey).toBe('pins');
        expect(request?.entries).toEqual([
            { itemKind: 'session', itemKey: 'same-session', sortKey: '00000001' },
        ]);
    });

    it('drops an unknown canonical item key instead of persisting it as an opaque Session id', () => {
        const state = buildTwoHomeState();
        const unknownKey = sessionAddressKey({ serverId: 'home-a', sessionId: 'never-projected' });

        const request = buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: 'home-a',
            scopeKey: 'shared-order',
            itemKeys: [unknownKey, homeAKey],
            orderItemAddressByItemKey: state.orderItemAddressByItemKey,
        });

        expect(request?.entries).toEqual([
            { itemKind: 'session', itemKey: 'same-session', sortKey: '00000001' },
        ]);
    });

    it('matches the target Home through its equivalent profile aliases', () => {
        const state = buildTwoHomeState();

        const request = buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: 'srv_identity',
            serverIdAliases: ['home-a'],
            scopeKey: 'shared-order',
            itemKeys: [homeBKey, homeAKey],
            orderItemAddressByItemKey: state.orderItemAddressByItemKey,
        });

        expect(request?.entries).toEqual([
            { itemKind: 'session', itemKey: 'same-session', sortKey: '00000001' },
        ]);
    });

    it('partitions a merged group order into one request map per exact Home', () => {
        const state = buildTwoHomeState();

        expect(partitionSessionOrganizationGroupOrderByServerId({
            next: state.sessionListGroupOrderV1,
            orderItemAddressByItemKey: state.orderItemAddressByItemKey,
        })).toEqual({
            'home-a': {
                [PINNED_GROUP_KEY_V1]: [homeAKey],
                'shared-order': [homeAKey],
            },
            'home-b': {
                [PINNED_GROUP_KEY_V1]: [homeBKey],
                'shared-order': [homeBKey],
            },
        });
    });

    it('refuses a workspace order scope owned by another Home and partitions it to its owner', () => {
        const state = buildTwoHomeState();
        const homeAScopeKey = buildSessionWorkspaceOrderScopeKey('home-a');
        const homeBScopeKey = buildSessionWorkspaceOrderScopeKey('home-b');

        expect(buildSessionOrganizationReorderRequestFromWorkspaceOrder({
            serverId: 'home-a',
            scopeKey: homeBScopeKey,
            itemKeys: ['workspace:/repo-home-b'],
        })).toBeNull();
        expect(buildSessionOrganizationReorderRequestFromWorkspaceOrder({
            serverId: 'home-b',
            scopeKey: homeBScopeKey,
            itemKeys: ['workspace:/repo-home-b'],
        })).toEqual({
            scopeKind: 'workspace',
            scopeKey: 'home-b',
            entries: [{ itemKind: 'workspace', itemKey: 'workspace:/repo-home-b', sortKey: '00000001' }],
        });

        expect(partitionSessionWorkspaceOrderByServerId({
            next: state.sessionWorkspaceOrderV1,
        })).toEqual({
            'home-a': { [homeAScopeKey]: ['/repo-home-a'] },
            'home-b': { [homeBScopeKey]: ['/repo-home-b'] },
        });
    });

    it('addresses a corpus member that owns no organization record yet', () => {
        const state = buildTwoHomeState();
        const plainHomeBKey = sessionAddressKey({ serverId: 'home-b', sessionId: 'plain-session' });
        // A Session that was never pinned, tagged, foldered or manually ordered is still a member
        // of its Home's corpus. Reordering it must persist it to that Home instead of being
        // dropped for having no prior organization record.
        const orderItemAddressByItemKey = completeSessionOrganizationOrderItemAddresses({
            orderItemAddressByItemKey: state.orderItemAddressByItemKey,
            memberHomes: [
                { serverId: 'home-a', sessionIds: ['same-session'] },
                { serverId: 'home-b', sessionIds: ['same-session', 'plain-session'] },
            ],
        });

        expect(orderItemAddressByItemKey[plainHomeBKey]).toEqual({
            itemKind: 'session',
            serverId: 'home-b',
            sessionId: 'plain-session',
        });
        expect(partitionSessionOrganizationGroupOrderByServerId({
            next: { 'shared-order': [homeAKey, plainHomeBKey] },
            orderItemAddressByItemKey,
        })).toEqual({
            'home-a': { 'shared-order': [homeAKey] },
            'home-b': { 'shared-order': [plainHomeBKey] },
        });
        expect(buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: 'home-b',
            scopeKey: 'shared-order',
            itemKeys: [homeAKey, plainHomeBKey],
            orderItemAddressByItemKey,
        })?.entries).toEqual([
            { itemKind: 'session', itemKey: 'plain-session', sortKey: '00000001' },
        ]);
    });

    it('returns the same address projection when every member is already addressed', () => {
        const state = buildTwoHomeState();

        expect(completeSessionOrganizationOrderItemAddresses({
            orderItemAddressByItemKey: state.orderItemAddressByItemKey,
            memberHomes: [{ serverId: 'home-a', sessionIds: ['same-session'] }],
        })).toBe(state.orderItemAddressByItemKey);
    });
});

describe('partitionSessionFolderWritesByServerId', () => {
    const folderAt = (serverId: string, id: string, name: string): SessionFolderV1 => ({
        id,
        name,
        parentId: null,
        createdAt: 1,
        updatedAt: 1,
        workspace: { t: 'workspaceScope', serverId, machineId: null, rootPath: '/repo' },
    });
    const folders = (...list: readonly SessionFolderV1[]): SessionFoldersV1 => ({ v: 1, folders: [...list] });
    const homeAFolder = folderAt('home-a', 'folder-home-a', 'Home A folder');
    const homeBFolder = folderAt('home-b', 'shared-folder-id', 'Home B folder');
    const orderItemAddressByItemKey: Readonly<Record<string, SessionOrganizationOrderItemAddress>> = {
        [folderKey('home-a', 'folder-home-a')]: { itemKind: 'folder', serverId: 'home-a', folderId: 'folder-home-a' },
        [folderKey('home-b', 'shared-folder-id')]: { itemKind: 'folder', serverId: 'home-b', folderId: 'shared-folder-id' },
    };

    it('renames a folder only at the Home that stores it', () => {
        const renamedHomeBFolder = { ...homeBFolder, name: 'Renamed on Home B', updatedAt: 2 };
        const current = folders(homeAFolder, homeBFolder);
        const next = folders(homeAFolder, renamedHomeBFolder);

        // The merged tree carries both Homes' folder ids. Sending it to the focused Home would
        // recreate Home B's folder there and leave the real one untouched.
        expect(partitionSessionFolderWritesByServerId({
            current,
            next,
            orderItemAddressByItemKey,
            fallbackServerId: 'home-a',
        })).toEqual({
            'home-b': {
                current: folders(homeBFolder),
                next: folders(renamedHomeBFolder),
            },
        });
    });

    it('deletes a folder only at the Home that stores it, even when another Home reuses the id', () => {
        const homeADuplicate = folderAt('home-a', 'shared-folder-id', 'Home A duplicate');

        const partitioned = partitionSessionFolderWritesByServerId({
            current: folders(homeADuplicate, homeBFolder),
            next: folders(homeADuplicate),
            orderItemAddressByItemKey,
            fallbackServerId: 'home-a',
        });

        expect(Object.keys(partitioned)).toEqual(['home-b']);
        expect(partitioned['home-b']?.next.folders).toEqual([]);
    });

    it('creates a new folder at the Home its workspace names rather than the focused Home', () => {
        const created = folderAt('home-b', 'folder-new', 'New');

        const partitioned = partitionSessionFolderWritesByServerId({
            current: folders(homeAFolder, homeBFolder),
            next: folders(homeAFolder, homeBFolder, created),
            orderItemAddressByItemKey,
            fallbackServerId: 'home-a',
        });

        expect(Object.keys(partitioned)).toEqual(['home-b']);
        expect(partitioned['home-b']?.next.folders.map((folder) => folder.id))
            .toEqual(['shared-folder-id', 'folder-new']);
    });

    it('emits nothing when no Home has a changed folder definition', () => {
        expect(partitionSessionFolderWritesByServerId({
            current: folders(homeAFolder, homeBFolder),
            next: folders(homeAFolder, { ...homeBFolder, updatedAt: 99 }),
            orderItemAddressByItemKey,
            fallbackServerId: 'home-a',
        })).toEqual({});
    });
});
