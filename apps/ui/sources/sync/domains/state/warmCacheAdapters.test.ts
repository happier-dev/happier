import { describe, expect, it, vi } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { SESSION_LIST_DOCUMENT_ADMISSION, admitOpenedSessionListDisplayMetadata,
    hasCurrentSessionListDisplayMetadata } from '@/sync/domains/session/sessionDocumentAdmission';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    buildMachineDisplayCacheEntryFromRenderable,
    buildMachineDisplayCacheEntriesFromRenderables,
    buildPersistedSessionListCacheEntriesFromRenderables,
    buildSessionListRenderableFromCacheEntry,
    buildSessionListCacheEntryFromRenderable,
    buildSessionListCacheEntriesFromRenderables,
    readSessionListWarmCacheDisplay,
    SESSION_LIST_WARM_CACHE_MAX_ENTRIES,
} from './warmCacheAdapters';
import { SessionListCacheEntryV1Schema, type SessionListCacheEntryV1 } from './warmCachePersistence';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

function makeWindowRenderable(id: string, meaningfulActivityAt: number): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 5,
        updatedAt: meaningfulActivityAt,
        meaningfulActivityAt,
        active: true,
        activeAt: meaningfulActivityAt,
        archivedAt: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online' as const,
    } as unknown as SessionListRenderableSession;
}

describe('warmCacheAdapters', () => {
    it('persists a distinct compact-display proof only for an opened readable projection', () => {
        const row = createSessionListRenderableSessionFixture({ metadata: { path: '/private', name: 'Opened display' },
            metadataVersion: 3, agentStateVersion: 2, encryptionMode: 'plain', encryptedContentAvailability: 'ready',
            [SESSION_LIST_DOCUMENT_ADMISSION]: { scope: 'private-credential-material-must-not-be-serialized', encryptionMode: 'plain',
                metadataLayoutVersion: 0, dataEncryptionKey: null, metadataAudience: 'owner' } });
        row[SESSION_LIST_DOCUMENT_ADMISSION] = admitOpenedSessionListDisplayMetadata(row[SESSION_LIST_DOCUMENT_ADMISSION]!, row);
        const entry = buildSessionListCacheEntryFromRenderable(row);
        const persisted = SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(entry)));
        expect(persisted).toHaveProperty('displayProof', expect.objectContaining({ metadataVersion: 3 }));
        expect(persisted.displayProof).not.toHaveProperty('agentStateVersion');
        expect(buildSessionListCacheEntryFromRenderable({ ...row, metadata: null,
            encryptedContentAvailability: 'encrypted_content_unavailable' })).not.toHaveProperty('displayProof');
        expect(buildSessionListCacheEntryFromRenderable({ ...row, encryptionMode: 'e2ee',
            encryptedContentAvailability: undefined })).not.toHaveProperty('displayProof');
        expect(JSON.stringify(persisted)).not.toContain('sessionListDocumentAdmission');
        expect(JSON.stringify(persisted)).not.toContain('private-credential-material');
        const admission = row[SESSION_LIST_DOCUMENT_ADMISSION]!;
        const versions = { id: row.id, metadataVersion: row.metadataVersion, agentStateVersion: row.agentStateVersion };
        expect(readSessionListWarmCacheDisplay(persisted, admission, versions)?.metadata?.name).toBe('Opened display');
        for (const foreign of [
            { ...admission, scope: 'other-account-currentness' },
            { ...admission, metadataAudience: 'shared' as const },
            { ...admission, dataEncryptionKey: 'replacement-envelope' },
            { ...admission, metadataLayoutVersion: 1 },
            { ...admission, encryptionMode: 'e2ee' as const },
        ]) expect(readSessionListWarmCacheDisplay(persisted, foreign, versions)).toBeUndefined();
        expect(readSessionListWarmCacheDisplay(persisted, admission, { ...versions, id: 'another-session' })).toBeUndefined();
        expect(readSessionListWarmCacheDisplay({ ...persisted, metadataVersion: 4 }, admission, versions)).toBeUndefined();
        expect(readSessionListWarmCacheDisplay({ ...persisted, displayProof: undefined }, admission, versions)).toBeUndefined();
        const untitled = SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(
            buildSessionListCacheEntryFromRenderable({ ...row, metadata: { path: '' } }))));
        expect(readSessionListWarmCacheDisplay(untitled, admission, versions)?.metadata).not.toBeNull();
        expect(readSessionListWarmCacheDisplay(untitled, admission, versions)).toBeDefined();
    });

    it('keeps proved last-known display at its actual revision while a different remote revision hydrates', () => {
        const row = createSessionListRenderableSessionFixture({ metadata: { path: '/private', name: 'Last-known title' },
            metadataVersion: 3, encryptionMode: 'plain', encryptedContentAvailability: 'ready' });
        row[SESSION_LIST_DOCUMENT_ADMISSION] = admitOpenedSessionListDisplayMetadata({ scope: 'same-authorized-home',
            encryptionMode: 'plain', metadataLayoutVersion: 0, dataEncryptionKey: null, metadataAudience: 'owner' }, row);
        const persisted = SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(buildSessionListCacheEntryFromRenderable(row))));
        for (const observedMetadataVersion of [2, 4]) {
            const restored = readSessionListWarmCacheDisplay(persisted, row[SESSION_LIST_DOCUMENT_ADMISSION]!,
                { id: row.id, metadataVersion: observedMetadataVersion });
            expect(restored?.metadata?.name).toBe('Last-known title');
            expect(restored?.metadataVersion).toBe(3);
            expect(restored?.[SESSION_LIST_DOCUMENT_ADMISSION]?.openedMetadataVersion).toBe(3);
            expect(restored && hasCurrentSessionListDisplayMetadata({ ...restored, metadataVersion: observedMetadataVersion })).toBe(false);
            expect(restored).not.toHaveProperty('agentState');
        }
    });

    it('restores admitted shared display with only a readable summary', () => {
        const row = createSessionListRenderableSessionFixture({ metadata: { path: '', summaryText: 'Shared summary' } });
        const restored = buildSessionListRenderableFromCacheEntry(SessionListCacheEntryV1Schema.parse(
            JSON.parse(JSON.stringify(buildSessionListCacheEntryFromRenderable(row)))));
        expect(restored.metadata?.summaryText).toBe('Shared summary');
    });

    it('preserves a cleared usage-limit recovery display across cache serialization', () => {
        const row = createSessionListRenderableSessionFixture({ metadata: { path: '/repo', sessionUsageLimitRecoveryV1: null } });
        const persisted = SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(buildSessionListCacheEntryFromRenderable(row))));
        expect(persisted).toHaveProperty('sessionUsageLimitRecoveryV1', null);
        expect(buildSessionListRenderableFromCacheEntry(persisted).metadata).toHaveProperty('sessionUsageLimitRecoveryV1', null);
    });

    it('roundtrips canonical activity and lifecycle display facts without memory-only authority', () => {
        const source = createSessionFixture({ metadata: { path: '/repo', host: 'home', lifecycleState: 'running',
            sessionAgentActivityHeadlineV1: { v: 1, backendId: 'codex', updatedAt: 1, activeEntries: [] },
            sessionWorkflowActivityHeadlineV1: { v: 1, backendId: 'codex', updatedAt: 1, activeRuns: [] },
            sessionGuardStateV1: { v: 1, kind: 'stopping', stopAt: 5, rule: 'idle_sessions' },
            sessionWorkStateV1: { v: 1, backendId: 'codex', updatedAt: 1, primaryItemId: 'task', items: [
                { id: 'task', kind: 'task', origin: 'vendor', status: 'blocked', title: 'Current task', updatedAt: 1, statusReason: 'blocked' },
                { id: 'goal', kind: 'goal', origin: 'vendor', status: 'active', title: 'Active goal', updatedAt: 1 },
                { id: 'history', kind: 'task', origin: 'vendor', status: 'complete', title: 'Private completed history', updatedAt: 1 },
            ] },
            forkV1: { v: 1, parentSessionId: 'parent', parentCutoffSeqInclusive: 1, createdAtMs: 1, strategy: 'replay',
                requestId: 'private-fork-request', agentHint: { agentSessionId: 'private-native-session' } },
            readStateV1: { v: 1, sessionSeq: 1, pendingActivityAt: 2, updatedAt: 3 },
            terminal: { controlServiceabilityV1: { v: 1, state: 'recoverable_unservable', observedAt: 1 } },
        } });
        const row = buildSessionListRenderableFromSession(source);
        const entry = SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(buildSessionListCacheEntryFromRenderable(row))));
        const restored = buildSessionListRenderableFromCacheEntry(entry);
        expect(restored.agentActivityHeadline).toEqual(row.agentActivityHeadline);
        expect(restored.workflowHeadline).toEqual(row.workflowHeadline);
        expect(restored.guardState).toEqual(row.guardState);
        expect(restored.forkV1).toEqual({ v: 1, parentSessionId: 'parent', parentCutoffSeqInclusive: 1,
            createdAtMs: 1, strategy: 'replay' });
        expect(JSON.stringify(entry)).not.toContain('private-fork-request');
        expect(JSON.stringify(entry)).not.toContain('private-native-session');
        expect(restored.workDisplay).toEqual({ v: 1,
            primaryItem: { id: 'task', kind: 'task', status: 'blocked', title: 'Current task', statusReason: 'blocked' },
            hasActiveGoal: true });
        expect(JSON.stringify(entry)).not.toContain('Private completed history');
        expect(entry).not.toHaveProperty('workState');
        expect(restored.metadata?.lifecycleState).toBe(row.metadata?.lifecycleState);
        expect(restored.metadata?.readStateV1).toEqual(row.metadata?.readStateV1);
        expect(restored.metadata?.terminalControlServiceabilityV1).toEqual(row.metadata?.terminalControlServiceabilityV1);
        expect(entry).not.toHaveProperty('agentTargetKey');
        expect(entry).not.toHaveProperty('workerQuestionHandling');
        expect(entry).not.toHaveProperty('currentRequestRef');
        expect(entry).not.toHaveProperty('lockedDisplayTitle');
    });
    it('retains last observed branch across a cold restore and clears it with unavailable private metadata', () => {
        for (const branch of ['feature/actual', null]) {
            const row = createSessionListRenderableSessionFixture({ metadata: { path: '/repo', branch }, metadataVersion: 2 });
            const entry = buildSessionListCacheEntryFromRenderable(row);
            const persisted = SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(entry)));
            expect(buildSessionListRenderableFromCacheEntry(persisted).metadata).toHaveProperty('branch', branch);
            expect(buildSessionListCacheEntryFromRenderable({ ...row }, entry)).toBe(entry);
            const contracted = buildSessionListCacheEntryFromRenderable({ ...row, metadata: null, metadataVersion: 3,
                encryptedContentAvailability: 'encrypted_content_unavailable' }, entry);
            expect(contracted).not.toHaveProperty('branch');
            expect(buildSessionListRenderableFromCacheEntry(contracted).metadata).toBeNull();
        }
    });
    it('compares admitted nested hydration fields without serializing unchanged rows', () => {
        const row = createSessionListRenderableSessionFixture({ rollbackEligibleTurnStarts: [1, 2],
            metadata: { path: '/admitted' }, encryptionMode: 'plain', encryptedContentAvailability: 'ready',
            [SESSION_LIST_DOCUMENT_ADMISSION]: { scope: 'fingerprinted-scope', encryptionMode: 'plain',
                metadataLayoutVersion: 0, dataEncryptionKey: null, metadataAudience: 'owner' } });
        row[SESSION_LIST_DOCUMENT_ADMISSION] = admitOpenedSessionListDisplayMetadata(row[SESSION_LIST_DOCUMENT_ADMISSION]!, row);
        const previous = buildSessionListCacheEntryFromRenderable(row);
        const machine = { id: 'build', updatedAt: 20, active: false, activeAt: 10,
            metadataVersion: 3, metadata: { agentInventory: { checkedAt: 12, installedAgentIds: ['codex'] } } };
        const previousMachine = buildMachineDisplayCacheEntryFromRenderable(machine);
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            for (let arrival = 0; arrival < 20; arrival++) {
                expect(buildSessionListCacheEntryFromRenderable({ ...row, rollbackEligibleTurnStarts: [1, 2] }, previous))
                    .toBe(previous);
                expect(buildMachineDisplayCacheEntryFromRenderable({ ...machine,
                    metadata: { agentInventory: { checkedAt: 12, installedAgentIds: ['codex'] } },
                }, previousMachine)).toBe(previousMachine);
            }
            expect(stringify).not.toHaveBeenCalled();
            expect(buildSessionListCacheEntryFromRenderable({ ...row, rollbackEligibleTurnStarts: [1, 3] }, previous))
                .not.toBe(previous);
            expect(buildMachineDisplayCacheEntryFromRenderable({ ...machine,
                metadata: { agentInventory: { checkedAt: 13, installedAgentIds: ['codex'] } },
            }, previousMachine)).not.toBe(previousMachine);
        } finally {
            stringify.mockRestore();
        }
    });

    it('roundtrips current access authority and its fail-closed null sentinel', () => {
        const access = {
            role: 'recipient' as const,
            level: 'edit' as const,
            capabilities: {
                readTranscript: true,
                submitAgentInput: true,
                editSessionRecords: true,
                approveRuntimePermissions: false,
                manageAccess: false,
                managePermissionDelegation: false,
                managePublicLink: false,
                archiveSession: false,
                renameSession: false,
                assignResponsibility: false,
                stopSession: false,
                deleteSession: false,
            },
            sources: [{ kind: 'team' as const, teamId: 'team-1', requiredByTeamPolicy: false }],
            audienceContext: { kind: 'team' as const, teamId: 'team-1' },
            primaryTeamId: 'team-1',
        };
        const cached = SessionListCacheEntryV1Schema.parse(
            buildSessionListCacheEntryFromRenderable(
                createSessionListRenderableSessionFixture({ access, accessLevel: 'edit' }),
            ),
        );

        expect(buildSessionListRenderableFromCacheEntry(cached).access).toEqual(access);

        const unavailableCached = SessionListCacheEntryV1Schema.parse(
            buildSessionListCacheEntryFromRenderable(
                createSessionListRenderableSessionFixture({ access: null, accessLevel: undefined }),
            ),
        );
        expect(buildSessionListRenderableFromCacheEntry(unavailableCached).access).toBeNull();

        const legacyRenderable = createSessionListRenderableSessionFixture({
            access: undefined,
            accessLevel: undefined,
        });
        const legacyCached = buildSessionListCacheEntryFromRenderable(legacyRenderable);
        const currentUnavailable = buildSessionListCacheEntryFromRenderable({
            ...legacyRenderable,
            access: null,
        }, legacyCached);
        expect(currentUnavailable).not.toBe(legacyCached);
        expect(currentUnavailable.effectiveAccess).toBeNull();
    });

    it('roundtrips omitted, null and assigned responsibility with the safe summary', () => {
        const omitted = buildSessionListCacheEntryFromRenderable(createSessionListRenderableSessionFixture());
        expect('responsibleAccountId' in omitted).toBe(false);
        expect('responsibleAccount' in omitted).toBe(false);

        const unassigned = buildSessionListCacheEntryFromRenderable(createSessionListRenderableSessionFixture({
            responsibleAccountId: null,
            responsibleAccount: null,
        }));
        const restoredUnassigned = buildSessionListRenderableFromCacheEntry(SessionListCacheEntryV1Schema.parse(unassigned));
        expect(restoredUnassigned.responsibleAccountId).toBeNull();
        expect(restoredUnassigned.responsibleAccount).toBeNull();

        const responsibleAccount = {
            kind: 'account' as const,
            accountId: 'account-alice',
            name: 'Alice',
            firstName: 'Alice',
            lastName: null,
            username: 'alice',
            avatarUrl: null,
        };
        const assigned = buildSessionListCacheEntryFromRenderable(createSessionListRenderableSessionFixture({
            responsibleAccountId: responsibleAccount.accountId,
            responsibleAccount,
        }));
        const restoredAssigned = buildSessionListRenderableFromCacheEntry(SessionListCacheEntryV1Schema.parse(assigned));
        expect(restoredAssigned.responsibleAccountId).toBe(responsibleAccount.accountId);
        expect(restoredAssigned.responsibleAccount).toEqual(responsibleAccount);
    });

    it('does not reconstruct runtime presence from durable active state', () => {
        const cached = buildSessionListCacheEntryFromRenderable(makeWindowRenderable('active-cached', 10));

        expect(buildSessionListRenderableFromCacheEntry(cached)).not.toHaveProperty('presence');
    });

    it('roundtrips a private quiet viewer without reviving a stale unread cache flag', () => {
        const viewer = {
            latestFailureSeq: null,
            readState: { state: 'not_started' as const },
            relevance: { relevant: true, reasons: ['responsible_for_me' as const] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
            follow: { follows: false, notificationLevel: 'none' as const },
            notification: { level: 'none' as const, source: 'preference' as const },
        };
        const renderable = createSessionListRenderableSessionFixture({
            seq: 8, lastViewedSessionSeq: 0, hasUnreadMessages: true, viewer,
        });
        const cached = buildSessionListCacheEntryFromRenderable(renderable);
        const restored = buildSessionListRenderableFromCacheEntry(SessionListCacheEntryV1Schema.parse(cached));
        expect(restored.viewer).toEqual(viewer);
        expect(restored.hasUnreadMessages).toBe(false);
        const changed = buildSessionListCacheEntryFromRenderable({ ...renderable, viewer: { ...viewer, relevance: { relevant: false, reasons: [] } } }, cached);
        expect(changed.viewer?.relevance.relevant).toBe(false);
        expect(buildSessionListCacheEntryFromRenderable(renderable, cached)).toBe(cached);
    });

    it('does not revive a released shared-recipient unread flag from warm cache', () => {
        const recipient = createSessionListRenderableSessionFixture({
            viewer: undefined,
            access: undefined,
            accessLevel: 'view',
            lastViewedSessionSeq: 2,
            hasUnreadMessages: true,
        });
        const cached = buildSessionListCacheEntryFromRenderable(recipient);

        expect(cached.hasUnreadMessages).toBe(false);
        expect(buildSessionListRenderableFromCacheEntry({
            ...cached,
            hasUnreadMessages: true,
        }).hasUnreadMessages).toBe(false);
    });

    it('keeps a layout-1 row readable and visible across a cold restore, hidden-system rows included', async () => {
        const { isUserFacingSession } = await import('@/sync/domains/session/listing/isUserFacingSession');
        // The list row carries this viewer's projected metadata (the owner view for an owner,
        // the shared view for a recipient). That projection is what the warm cache must keep:
        // without it every current-layout row reloads as "metadata unavailable" and the owner's
        // offline list comes back empty.
        const owner = createSessionListRenderableSessionFixture({
            id: 'layout-1-owner',
            metadataLayoutVersion: 1,
            metadataUnavailable: false,
            metadata: { name: 'Owner title', path: '/home/u/repo', host: 'box', machineId: 'machine-1', flavor: 'codex' },
        });
        const reloaded = buildSessionListRenderableFromCacheEntry(buildSessionListCacheEntryFromRenderable(owner));
        expect(reloaded.metadataUnavailable).toBe(false);
        expect(reloaded.metadata).toMatchObject({ name: 'Owner title', path: '/home/u/repo', machineId: 'machine-1' });
        expect(isUserFacingSession(reloaded)).toBe(true);

        const hidden = createSessionListRenderableSessionFixture({
            id: 'layout-1-hidden-system',
            metadataLayoutVersion: 1,
            metadataUnavailable: false,
            metadata: { path: '/home/u/voice', hiddenSystemSession: true },
        });
        const reloadedHidden = buildSessionListRenderableFromCacheEntry(buildSessionListCacheEntryFromRenderable(hidden));
        expect(isUserFacingSession(reloadedHidden)).toBe(false);
    });

    it('keeps the settled content fact across a cold restore so an own readable row never reads as locked', async () => {
        const { projectUiSessionAwareness } = await import('@/sync/domains/session/awareness/sessionAwareness');
        const { isSessionAwarenessContentReadableV1} = await import('@happier-dev/protocol/sessions/awareness/availability');
        const roundtrip = (renderable: SessionListRenderableSession) => {
            const entry = SessionListCacheEntryV1Schema.parse(
                JSON.parse(JSON.stringify(buildSessionListCacheEntryFromRenderable(renderable))),
            );
            return buildSessionListRenderableFromCacheEntry(entry);
        };
        const readable = (renderable: SessionListRenderableSession) =>
            isSessionAwarenessContentReadableV1(projectUiSessionAwareness(renderable, 1_000).encryption);

        const ownE2ee = roundtrip(createSessionListRenderableSessionFixture({
            id: 'own-e2ee',
            metadataLayoutVersion: 1,
            metadataUnavailable: false,
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'ready',
            metadata: { path: '/home/u/repo' },
        }));
        expect(ownE2ee.encryptionMode).toBe('e2ee');
        expect(ownE2ee.encryptedContentAvailability).toBe('ready');
        expect(readable(ownE2ee)).toBe(true);

        const plain = roundtrip(createSessionListRenderableSessionFixture({
            id: 'plain',
            encryptionMode: 'plain',
            encryptedContentAvailability: 'ready',
            metadata: { path: '/home/u/plain' },
        }));
        expect(readable(plain)).toBe(true);

        // A settled locked answer stays locked across the restore; nothing is upgraded to ready.
        const locked = roundtrip(createSessionListRenderableSessionFixture({
            id: 'locked',
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_access_pending',
            metadata: null,
        }));
        expect(locked.encryptedContentAvailability).toBe('encrypted_access_pending');
        expect(readable(locked)).toBe(false);

        // An unsettled row stays unsettled: the cache never invents a fact.
        const unsettled = roundtrip(createSessionListRenderableSessionFixture({
            id: 'unsettled',
            encryptionMode: 'e2ee',
            encryptedContentAvailability: undefined,
            metadata: { path: '/home/u/other' },
        }));
        expect(unsettled.encryptedContentAvailability).toBeUndefined();
        expect(readable(unsettled)).toBe(false);
    });

    it('does not preserve or resurrect legacy private cache fields after the privacy layout contracts', () => {
        const previousEntry: SessionListCacheEntryV1 = {
            sessionId: 'privacy-contraction',
            seq: 7,
            metadataVersion: 9,
            agentStateVersion: 8,
            updatedAt: 10,
            createdAt: 1,
            active: true,
            activeAt: 10,
            archivedAt: null,
            name: 'Legacy title',
            path: '/private/worktree',
            homeDir: '/private',
            host: 'private-host',
            machineId: 'private-machine',
            flavor: 'codex',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'private-machine',
                remoteSessionId: 'private-native-id',
                source: { kind: 'codexHome', home: 'local' },
            },
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: true,
        };
        const contractedRecipientRenderable = {
            id: 'privacy-contraction',
            seq: 8,
            createdAt: 1,
            updatedAt: 11,
            active: true,
            activeAt: 11,
            archivedAt: null,
            metadataLayoutVersion: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        };

        const contractedEntry = buildSessionListCacheEntryFromRenderable(
            contractedRecipientRenderable as SessionListRenderableSession,
            previousEntry,
        );
        const reloaded = buildSessionListRenderableFromCacheEntry(contractedEntry);

        expect(contractedEntry).toMatchObject({
            metadataLayoutVersion: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            name: undefined,
            path: '',
            homeDir: null,
            host: null,
            machineId: null,
            flavor: null,
            externalSessionV1: null,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        });
        expect(reloaded.metadata).toBeNull();
        expect(JSON.stringify(reloaded)).not.toContain('private-native-id');
        expect(JSON.stringify(reloaded)).not.toContain('/private/worktree');
    });

    it('invalidates and roundtrips the canonical external-session agent identity', () => {
        const createRenderable = (agentId: string): SessionListRenderableSession => ({
            id: 'external-agent-change',
            seq: 1,
            createdAt: 5,
            updatedAt: 20,
            active: true,
            activeAt: 20,
            metadataVersion: 2,
            agentStateVersion: 4,
            lastViewedSessionSeq: 0,
            metadata: {
                path: '/home/u/repo',
                externalSessionV1: {
                    v: 1,
                    agentId,
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
            hasUnreadMessages: false,
        });
        const previousEntry = buildSessionListCacheEntryFromRenderable(createRenderable('codex'));
        const nextEntry = buildSessionListCacheEntryFromRenderable(
            createRenderable('claude'),
            previousEntry,
        );

        expect(nextEntry).not.toBe(previousEntry);
        expect(nextEntry.externalSessionV1).toMatchObject({ v: 1, agentId: 'claude' });
        expect(buildSessionListRenderableFromCacheEntry(nextEntry).metadata?.externalSessionV1).toEqual({
            v: 1,
            agentId: 'claude',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: { kind: 'codexHome', home: 'user' },
        });
    });

    it('preserves previous session cache metadata and agent-state projection while a replacement renderable is still stale', () => {
        const previousEntry = {
            sessionId: 's1',
            metadataVersion: 1,
            agentStateVersion: 3,
            updatedAt: 10,
            createdAt: 5,
            active: true,
            activeAt: 10,
            archivedAt: null,
            pendingCount: 1,
            pendingVersion: 2,
            name: 'Cached title',
            path: '/home/u/repo',
            homeDir: '/home/u',
            machineId: 'm1',
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: 30,
        };

        const nextRenderable = {
            id: 's1',
            seq: 1,
            createdAt: 5,
            updatedAt: 20,
            active: true,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 4,
            pendingVersion: 5,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
        };

        const entry = (buildSessionListCacheEntryFromRenderable as any)(nextRenderable, previousEntry);

        expect(entry).toEqual(expect.objectContaining({
            sessionId: 's1',
            metadataVersion: 1,
            agentStateVersion: 3,
            updatedAt: 20,
            pendingCount: 4,
            pendingVersion: 5,
            name: 'Cached title',
            path: '/home/u/repo',
            homeDir: '/home/u',
            machineId: 'm1',
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: 30,
        }));
    });

    it('reuses the previous session cache map when renderables are semantically identical', () => {
        const renderable = {
            id: 's1',
            seq: 1,
            createdAt: 5,
            updatedAt: 20,
            active: true,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 4,
            pendingVersion: 5,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Cached title',
                summaryText: null,
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'host-a',
                machineId: 'm1',
                flavor: null,
                externalSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
            accessLevel: null,
            canApprovePermissions: false,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        };

        const originalKeys = Object.keys;
        const keysSpy = vi.spyOn(Object, 'keys');
        const previousEntries = {
            s1: buildSessionListCacheEntryFromRenderable(renderable as any),
        };
        keysSpy.mockImplementation((value) => {
            if (value === previousEntries) {
                throw new Error('previous session entries should not be enumerated');
            }
            return originalKeys(value as never);
        });

        const nextEntries = buildSessionListCacheEntriesFromRenderables(
            { s1: renderable as any },
            previousEntries,
        );

        expect(nextEntries).toBe(previousEntries);
        keysSpy.mockRestore();
    });

    it('evicts a stale entry when a same-size renderable set swapped one member', () => {
        const previousEntries = buildSessionListCacheEntriesFromRenderables({
            a: makeWindowRenderable('a', 20),
            b: makeWindowRenderable('b', 20),
        });
        const nextEntries = buildSessionListCacheEntriesFromRenderables(
            { b: makeWindowRenderable('b', 20), c: makeWindowRenderable('c', 20) },
            previousEntries,
        );

        expect(Object.keys(nextEntries).sort()).toEqual(['b', 'c']);
    });

    it('persists only the most recent window of sessions, ordered by the server list key', () => {
        const renderables: Record<string, SessionListRenderableSession> = {};
        const total = SESSION_LIST_WARM_CACHE_MAX_ENTRIES + 25;
        for (let index = 0; index < total; index += 1) {
            const id = `s${String(index).padStart(4, '0')}`;
            renderables[id] = makeWindowRenderable(id, 1_000 + index);
        }

        const persisted = buildPersistedSessionListCacheEntriesFromRenderables(renderables);

        expect(Object.keys(persisted)).toHaveLength(SESSION_LIST_WARM_CACHE_MAX_ENTRIES);
        expect(persisted['s0000']).toBeUndefined();
        expect(persisted[`s${String(total - 1).padStart(4, '0')}`]).toBeDefined();

        // Capping must not cost referential stability, or every fetch would rewrite the blob.
        expect(buildPersistedSessionListCacheEntriesFromRenderables(renderables, persisted)).toBe(persisted);
    });

    it('leaves the in-memory metadata fallback uncapped', () => {
        const renderables: Record<string, SessionListRenderableSession> = {};
        const total = SESSION_LIST_WARM_CACHE_MAX_ENTRIES + 25;
        for (let index = 0; index < total; index += 1) {
            const id = `s${String(index).padStart(4, '0')}`;
            renderables[id] = makeWindowRenderable(id, 1_000 + index);
        }

        expect(Object.keys(buildSessionListCacheEntriesFromRenderables(renderables))).toHaveLength(total);
    });

    it('reuses each domain-owned empty map when renderables are empty', () => {
        const firstSessionEntries = buildSessionListCacheEntriesFromRenderables({});
        const secondSessionEntries = buildSessionListCacheEntriesFromRenderables({});
        const firstMachineEntries = buildMachineDisplayCacheEntriesFromRenderables({});
        const secondMachineEntries = buildMachineDisplayCacheEntriesFromRenderables({});

        expect(firstSessionEntries).toBe(secondSessionEntries);
        expect(firstSessionEntries).toEqual({});
        expect(firstMachineEntries).toBe(secondMachineEntries);
        expect(firstMachineEntries).toEqual({});
    });

    it('reuses the previous session cache entry when renderable data is semantically identical', () => {
        const renderable = {
            id: 's1',
            seq: 1,
            createdAt: 5,
            updatedAt: 20,
            active: true,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 4,
            pendingVersion: 5,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Cached title',
                summaryText: null,
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'host-a',
                machineId: 'm1',
                flavor: null,
                externalSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
            accessLevel: null,
            canApprovePermissions: false,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        };

        const previousEntry = buildSessionListCacheEntryFromRenderable(renderable as any);
        const nextEntry = buildSessionListCacheEntryFromRenderable(renderable as any, previousEntry);

        expect(nextEntry).toBe(previousEntry);
    });

    it('preserves previous machine display cache metadata while a replacement renderable is still stale', () => {
        const previousEntry = {
            machineId: 'm1',
            metadataVersion: 2,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            revokedAt: null,
            displayName: 'Cached machine',
            host: 'mbp',
            homeDir: '/home/u',
        };

        const nextRenderable = {
            id: 'm1',
            updatedAt: 20,
            active: true,
            activeAt: 20,
            revokedAt: null,
            metadataVersion: 3,
            metadata: null,
        };

        const entry = (buildMachineDisplayCacheEntryFromRenderable as any)(nextRenderable, previousEntry);

        expect(entry).toEqual(expect.objectContaining({
            machineId: 'm1',
            metadataVersion: 2,
            updatedAt: 20,
            activeAt: 20,
            displayName: 'Cached machine',
            host: 'mbp',
            homeDir: '/home/u',
        }));
    });

    it('keeps a no-folder session marked across a cold restore, so its private folder is never read as a workspace', () => {
        const entry = buildSessionListCacheEntryFromRenderable({
            id: 's1',
            seq: 1,
            createdAt: 5,
            updatedAt: 20,
            active: false,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 0,
            pendingVersion: 0,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Chat',
                path: '/home/u/.happier/session-directories/0684bb134966dab76169d5471c632881143b317dc0f3dd4162c9910bd949e116',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                flavor: 'codex',
                externalSessionV1: null,
                hiddenSystemSession: false,
                sessionDirectoryV1: { v: 1, kind: 'managed' },
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'offline',
        } as any);

        const restored = buildSessionListRenderableFromCacheEntry(SessionListCacheEntryV1Schema.parse(entry));
        expect(readSessionDirectoryKind(restored.metadata)).toBe('managed');
        // A session in a folder stays a session in a folder.
        const inFolder = buildSessionListCacheEntryFromRenderable({
            ...buildSessionListRenderableFromCacheEntry(entry),
            metadata: { ...restored.metadata!, sessionDirectoryV1: null },
        } as any);
        expect(readSessionDirectoryKind(buildSessionListRenderableFromCacheEntry(inFolder).metadata)).toBe('path');
    });

    it('keeps a Bot a Bot across a cold restore, so the Bots roster and Bot filter still find it', () => {
        const botRenderable = {
            ...makeWindowRenderable('bot-1', 20),
            metadata: { bot: { kind: 'bot' as const }, name: 'Release captain', path: '/home/u/happier', host: 'mbp', machineId: 'm1' },
        } as unknown as SessionListRenderableSession;
        const restored = buildSessionListRenderableFromCacheEntry(
            SessionListCacheEntryV1Schema.parse(buildSessionListCacheEntryFromRenderable(botRenderable)),
        );
        expect(restored.metadata?.bot).toEqual({ kind: 'bot' });

        // An ordinary Session restores without a marker, and demoting a Bot is a cache change.
        const ordinary = { ...botRenderable, metadata: { ...botRenderable.metadata!, bot: undefined } } as SessionListRenderableSession;
        const ordinaryEntry = buildSessionListCacheEntryFromRenderable(ordinary);
        expect(buildSessionListRenderableFromCacheEntry(ordinaryEntry).metadata?.bot).toBeUndefined();
        const previous = buildSessionListCacheEntriesFromRenderables({ 'bot-1': botRenderable });
        expect(buildSessionListCacheEntriesFromRenderables({ 'bot-1': ordinary }, previous)).not.toBe(previous);
    });

    it('roundtrips keepVisibleWhenInactive through cache entries', () => {
        const entry = buildSessionListCacheEntryFromRenderable({
            id: 's1',
            seq: 1,
            createdAt: 5,
            updatedAt: 20,
            active: false,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 0,
            pendingVersion: 0,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Cached title',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                flavor: 'codex',
                externalSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'offline',
            keepVisibleWhenInactive: true,
        } as any);

        expect(entry.keepVisibleWhenInactive).toBe(true);
        expect(buildSessionListRenderableFromCacheEntry(entry).keepVisibleWhenInactive).toBe(true);
    });

    it('roundtrips session unread state through cache entries', () => {
        const entry = buildSessionListCacheEntryFromRenderable({
            id: 's1',
            seq: 7,
            createdAt: 5,
            updatedAt: 20,
            active: true,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 0,
            pendingVersion: 0,
            lastViewedSessionSeq: 4,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Cached title',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                flavor: 'codex',
                externalSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            hasUnreadMessages: true,
        } as any);

        expect(entry.seq).toBe(7);
        expect(entry.lastViewedSessionSeq).toBe(4);
        expect(entry.hasUnreadMessages).toBe(true);
        expect(buildSessionListRenderableFromCacheEntry(entry)).toEqual(expect.objectContaining({
            seq: 7,
            lastViewedSessionSeq: 4,
            hasUnreadMessages: true,
        }));
    });

    it('roundtrips durable session status and attention projection through cache entries', () => {
        const renderable = {
            id: 's_attention',
            seq: 12,
            createdAt: 5,
            updatedAt: 20,
            meaningfulActivityAt: 20,
            active: true,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 1,
            pendingVersion: 4,
            lastViewedSessionSeq: 10,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Needs review',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                flavor: 'codex',
                externalSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 500,
            presence: 'online',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_200,
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'auth_error',
                source: 'auth_error',
                occurredAt: 1_200,
            },
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_250,
            runtimeActivityRevision: 10_000,
            latestReadyEventSeq: 11,
            latestReadyEventAt: 1_100,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: 1_000,
            rollbackEligibleTurnStarts: [3, 9],
            hasUnreadMessages: true,
        } satisfies SessionListRenderableSession & { rollbackEligibleTurnStarts: readonly number[] };

        const entry = buildSessionListCacheEntryFromRenderable(renderable);

        expect(entry).toEqual(expect.objectContaining({
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_200,
            lastRuntimeIssue: expect.objectContaining({ code: 'auth_error' }),
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_250,
            runtimeActivityRevision: 10_000,
            latestReadyEventSeq: 11,
            latestReadyEventAt: 1_100,
            pendingRequestObservedAt: 1_000,
            rollbackEligibleTurnStarts: [3, 9],
        }));
        expect(buildSessionListRenderableFromCacheEntry(entry)).toEqual(expect.objectContaining({
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_200,
            lastRuntimeIssue: expect.objectContaining({ code: 'auth_error' }),
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_250,
            runtimeActivityRevision: 10_000,
            latestReadyEventSeq: 11,
            latestReadyEventAt: 1_100,
            pendingRequestObservedAt: 1_000,
            rollbackEligibleTurnStarts: [3, 9],
        }));
    });

    it('does not hydrate placeholder session metadata from an empty warm-cache identity', () => {
        const renderable = buildSessionListRenderableFromCacheEntry({
            sessionId: 's-placeholder',
            metadataVersion: 0,
            agentStateVersion: 0,
            updatedAt: 20,
            createdAt: 10,
            active: true,
            activeAt: 20,
            archivedAt: null,
            path: '',
        });

        expect(renderable.metadata).toBeNull();
        expect(renderable.metadataUnavailable).toBe(true);
    });

    it('does not preserve placeholder session metadata from a previous empty warm-cache identity', () => {
        const entry = buildSessionListCacheEntryFromRenderable({
            id: 's-placeholder',
            seq: 1,
            createdAt: 10,
            updatedAt: 20,
            active: true,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 0,
            pendingVersion: 0,
            metadataVersion: 1,
            agentStateVersion: 0,
            metadata: null,
            metadataUnavailable: true,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any, {
            sessionId: 's-placeholder',
            metadataVersion: 0,
            agentStateVersion: 0,
            updatedAt: 10,
            createdAt: 10,
            active: true,
            activeAt: 10,
            archivedAt: null,
            path: '',
        });

        expect(entry.path).toBe('');
        expect(entry.name).toBeUndefined();
        expect(entry.host).toBeNull();
        expect(entry.machineId).toBeNull();
    });

    it('reuses the previous machine display cache map when renderables are semantically identical', () => {
        const renderable = {
            id: 'm1',
            updatedAt: 20,
            active: true,
            activeAt: 20,
            revokedAt: null,
            metadataVersion: 3,
            metadata: {
                displayName: 'Cached machine',
                host: 'mbp',
                homeDir: '/home/u',
            },
        };

        const originalKeys = Object.keys;
        const keysSpy = vi.spyOn(Object, 'keys');
        const previousEntries = {
            m1: buildMachineDisplayCacheEntryFromRenderable(renderable as any),
        };
        keysSpy.mockImplementation((value) => {
            if (value === previousEntries) {
                throw new Error('previous machine entries should not be enumerated');
            }
            return originalKeys(value as never);
        });

        const nextEntries = buildMachineDisplayCacheEntriesFromRenderables(
            { m1: renderable as any },
            previousEntries,
        );

        expect(nextEntries).toBe(previousEntries);
        keysSpy.mockRestore();
    });

    it('reuses the previous machine display cache entry when renderable data is semantically identical', () => {
        const renderable = {
            id: 'm1',
            updatedAt: 20,
            active: true,
            activeAt: 20,
            revokedAt: null,
            metadataVersion: 3,
            metadata: {
                displayName: 'Cached machine',
                host: 'mbp',
                homeDir: '/home/u',
            },
        };

        const previousEntry = buildMachineDisplayCacheEntryFromRenderable(renderable as any);
        const nextEntry = buildMachineDisplayCacheEntryFromRenderable(renderable as any, previousEntry);

        expect(nextEntry).toBe(previousEntry);
    });
});
