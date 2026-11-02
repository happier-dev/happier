import { projectLegacySessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { getSessionName, getSessionStatus } from '@/utils/sessions/sessionUtils';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';

import { applySessionListRenderablePatch, areSessionListRenderablesEqual, buildSessionListRenderableFromSession } from './sessionListRenderable';
import { buildSessionFromListRenderable, createSessionListPresentationSource, readSessionListPresentationPendingFlags } from './sessionListRenderableSessionProjection';
import { sessionRuntimeObservations } from '../sessionRuntimeObservation';
import type { Message } from '@happier-dev/session-core/messages';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { buildSessionListRowFilterFacts } from './sessionListWorkFilter';
import { matchSessionListFilterV1, normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { areStoredSessionsEqual } from '@/sync/store/domains/areStoredSessionsEqual';
import { SESSION_LIST_DOCUMENT_ADMISSION } from '../sessionDocumentAdmission';
import { hasAuthoritativeSessionRouteData } from '../hasAuthoritativeSessionRouteData';

it('does not relabel held full metadata when a display-only row advances its revision', () => {
    const admission = { scope: 'home/account', encryptionMode: 'plain' as const, metadataLayoutVersion: 0,
        metadataAudience: 'owner' as const, dataEncryptionKey: null };
    const base = createSessionFixture({ serverId: 'home', encryptionMode: 'plain', metadataVersion: 1, agentStateVersion: 1,
        metadata: { name: 'Held full document', path: '/held', host: 'host', work: { memoryEnabled: true } },
        [SESSION_LIST_DOCUMENT_ADMISSION]: { ...admission, openedMetadataVersion: 1, openedAgentStateVersion: 1,
            observedMetadataVersion: 2, observedAgentStateVersion: 1 } });
    const row = buildSessionListRenderableFromSession({ ...base, metadataVersion: 2, agentStateVersion: 2,
        metadata: { name: 'Fresh display title', path: '/display', host: 'host' },
        [SESSION_LIST_DOCUMENT_ADMISSION]: { ...admission, openedMetadataVersion: 2,
            observedMetadataVersion: 2, observedAgentStateVersion: 2 } });
    const control = buildSessionFromListRenderable(row, { baseSession: base });
    expect(control.metadata).toBe(base.metadata);
    expect(control.metadataVersion).toBe(1);
    expect(control.agentState).toBe(base.agentState);
    expect(control.agentStateVersion).toBe(1);
    expect(hasAuthoritativeSessionRouteData(control)).toBe(false);
    expect(createSessionListPresentationSource(row, { baseSession: base }).metadata?.name).toBe('Fresh display title');
});

it.each(['readable', 'blocked'] as const)('does not grant full route readiness by reconstructing an admitted display with no held Session (%s)', state => {
    const readable = buildSessionListRenderableFromSession(createSessionFixture({ encryptionMode: 'plain',
        metadataLayoutVersion: 0, metadataVersion: 2, agentStateVersion: 1,
        [SESSION_LIST_DOCUMENT_ADMISSION]: { scope: 'home/account', encryptionMode: 'plain', metadataLayoutVersion: 0,
            metadataAudience: 'owner', dataEncryptionKey: null, openedMetadataVersion: 2, openedAgentStateVersion: 1,
            observedMetadataVersion: 2, observedAgentStateVersion: 1 } }));
    const row = state === 'readable' ? readable : { ...readable, metadata: null,
        encryptedContentAvailability: 'encrypted_content_unavailable' as const };
    const reconstructed = buildSessionFromListRenderable(row);
    expect(reconstructed.agentState).toBeNull();
    expect(hasAuthoritativeSessionRouteData(reconstructed)).toBe(false);
});

it('does not overlay a foreign full base onto an admitted display', () => {
    const admission = { scope: 'home/account', encryptionMode: 'plain' as const, metadataLayoutVersion: 0,
        metadataAudience: 'owner' as const, dataEncryptionKey: null };
    const base = createSessionFixture({ metadataLayoutVersion: 0, encryptionMode: 'plain',
        metadata: { path: '/foreign-private', host: 'foreign', work: { memoryEnabled: true } },
        [SESSION_LIST_DOCUMENT_ADMISSION]: { ...admission, scope: 'other-home/account', openedMetadataVersion: 1, openedAgentStateVersion: 1 } });
    const row = buildSessionListRenderableFromSession(createSessionFixture({ metadataLayoutVersion: 0, encryptionMode: 'plain',
        metadata: { path: '/admitted', host: 'admitted' },
        [SESSION_LIST_DOCUMENT_ADMISSION]: { ...admission, openedMetadataVersion: 1 } }));
    const control = buildSessionFromListRenderable(row, { baseSession: base });
    expect(control.metadata?.work).toBeUndefined();
    expect(createSessionListPresentationSource(row, { baseSession: base }).metadataFallback).toBeUndefined();
});

describe('locked shared title projection', () => {
    const title = 'Previously authorized shared title';
    const locked = createSessionFixture({
        serverId: 'home-a', metadataLayoutVersion: 1, encryptionMode: 'e2ee',
        encryptedContentAvailability: 'encrypted_access_needs_repair',
        metadata: null, ownerMetadataView: null,
        access: createSessionAccessFixture('view'), accessLevel: 'view',
        lockedDisplayTitle: title,
    });

    it('carries only the trusted title through a cold locked projection and reconstruction', () => {
        const cold = buildSessionListRenderableFromSession(locked);
        expect(getSessionName(cold)).toBe(title);
        expect(cold.metadata).toBeNull();
        const reconstructed = buildSessionFromListRenderable(cold, { serverId: 'home-a' });
        expect(getSessionName(reconstructed)).toBe(title);
        expect(reconstructed.metadata).toBeNull();
        expect(reconstructed.ownerMetadataView).toBeNull();
    });

    it('does not copy previous metadata while carrying a trusted warm locked title', () => {
        const cold = buildSessionListRenderableFromSession(locked);
        const warm = buildSessionListRenderableFromSession(locked, {
            ...cold,
            metadata: { summaryText: 'Old title', path: '/private/owner', host: 'owner.local' },
        });
        expect(getSessionName(warm)).toBe(title);
        expect(warm.metadata).toBeNull();
    });

    it('does not revive a retired title from the previous row after a Home change', () => {
        const previous = buildSessionListRenderableFromSession(locked);
        const cleared = buildSessionListRenderableFromSession({
            ...locked, serverId: 'home-b', lockedDisplayTitle: null,
        }, previous);
        expect(getSessionName(cleared)).not.toBe(title);
        expect(cleared.metadata).toBeNull();
        expect(getSessionName(buildSessionFromListRenderable(cleared, {
            baseSession: locked, serverId: 'home-b',
        }))).not.toBe(title);
    });

    it('clears the retained title when shared content becomes readable without a title', () => {
        const previous = buildSessionListRenderableFromSession(locked);
        const readable = buildSessionListRenderableFromSession({
            ...locked, encryptedContentAvailability: 'ready',
            metadata: parseDecryptedSessionMetadata({ v: 1 }, 1),
        }, previous);
        expect(getSessionName(readable)).not.toBe(title);
        expect(getSessionName(buildSessionFromListRenderable(readable, { baseSession: locked }))).not.toBe(title);
    });

    it('clears the retained title when access no longer identifies a recipient', () => {
        const previous = buildSessionListRenderableFromSession(locked);
        for (const access of [createSessionAccessFixture('owner'), null]) {
            const cleared = buildSessionListRenderableFromSession({ ...locked, access, accessLevel: undefined }, previous);
            expect(getSessionName(cleared)).not.toBe(title);
            expect(getSessionName(buildSessionFromListRenderable(cleared, { baseSession: locked }))).not.toBe(title);
        }
    });

    it('observes title-only changes and retirement in the canonical row comparison', () => {
        const row = buildSessionListRenderableFromSession(locked);
        const previous = { ...row, lockedDisplayTitle: title };
        expect(areSessionListRenderablesEqual(previous, { ...row, lockedDisplayTitle: 'Changed title' })).toBe(false);
        expect(areSessionListRenderablesEqual(previous, { ...row, lockedDisplayTitle: null })).toBe(false);
        expect(areSessionListRenderablesEqual(previous, { ...row, lockedDisplayTitle: title })).toBe(true);
    });

    it('clears the memory title when a list patch changes content or recipient access', () => {
        const row = { ...buildSessionListRenderableFromSession(locked), lockedDisplayTitle: title };
        const readable = applySessionListRenderablePatch(row, { metadata: { path: '', summaryText: null } });
        expect(readable).toHaveProperty('lockedDisplayTitle', null);
        const retired = applySessionListRenderablePatch(row, { access: null, accessLevel: undefined });
        expect(getSessionName(retired)).not.toBe(title);
    });
});

describe('buildSessionFromListRenderable', () => {
    it('keeps held lead counts when a warm row omits them', async () => {
        const { readSessionWorkStatusFacts } = await import('@/components/work/status/sessionWorkStatusFacts');
        const { readPutUnderCandidatePresentation } = await import('@/components/sessions/work/putUnderPresentation');
        const base = createSessionFixture({ id: 'warm-lead', serverId: 'home', updatedAt: 900,
            active: true, activeAt: 1_000, presence: 'online', latestTurnStatus: 'completed',
            managedSessions: { total: 2, working: 1, needsYou: 0, stalled: 0, finished: 1, attentionPrimary: null } });
        const row = { ...buildSessionListRenderableFromSession(base), updatedAt: 100, managedSessions: undefined };
        const source = createSessionListPresentationSource(row, { baseSession: base, serverId: 'home' });
        expect(buildSessionFromListRenderable(row, { baseSession: base }).managedSessions)
            .toBe(base.managedSessions);
        expect(readSessionWorkStatusFacts(row, 1_000, source).settled).toBe(false);
        expect(readPutUnderCandidatePresentation({ record: row, baseSession: base, serverId: 'home' }))
            .toMatchObject({ leadsCount: 2, workingCount: 1, updatedAt: 900 });
    });
    it.each([undefined, 1_200])('keeps projected pending fallback ordered by the exact Home full-publication witness (%s)', observedAt => {
        const base = createSessionFixture({ id: 'row-pending-witness', serverId: 'row-witness-home', active: true,
            updatedAt: 1_000, agentState: null, pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0 });
        const row = { ...buildSessionListRenderableFromSession(base), pendingRequestObservedAt: observedAt };
        const messages: Message[] = [{ id: 'terminal-permission', kind: 'tool-call', localId: null, createdAt: 1_500,
            tool: { id: 'terminal-tool', name: 'Bash', state: 'completed', input: {}, createdAt: 1_500,
                startedAt: 1_500, completedAt: 1_600, description: null,
                permission: { id: 'terminal-permission', status: 'approved' } }, children: [] }];
        const address = { serverId: 'row-witness-home', sessionId: row.id };
        sessionRuntimeObservations.recordFullPublication(address, 2_000, base);
        try {
            const read = (serverId: string) => readSessionListPresentationPendingFlags(
                createSessionListPresentationSource(row, { baseSession: base, serverId }), messages).hasPendingPermissionRequests;
            expect(read('row-witness-home')).toBe(observedAt === undefined);
            expect(read('different-home')).toBe(false);
            expect(base.updatedAt).toBe(1_000);
        } finally { sessionRuntimeObservations.forget(address); }
    });
    it('does not copy unrelated held metadata while projecting mixed admitted rows', () => {
        const nowMs = 1_000_000;
        const base = createSessionFixture({ serverId: 'home', active: true, activeAt: nowMs,
            metadata: { path: '/held', host: 'machine', work: { statusReason: 'Held private explanation' } } });
        const row = buildSessionListRenderableFromSession({ ...base, seq: base.seq + 1,
            metadata: { path: '/current', host: 'machine', name: 'Current title' } });
        let unrelatedReads = 0;
        // A real data getter detects whole-Metadata enumeration; no domain logic is replaced.
        Object.defineProperty(base.metadata, 'unconsumedProjectionPayload', { enumerable: true,
            get: () => { unrelatedReads++; return 'unrelated held content'; } });
        for (let pass = 0; pass < 2; pass++) for (let index = 0; index < 1_001; index++) {
            const source = createSessionListPresentationSource(row, { baseSession: base, serverId: 'home' });
            const attention = buildSessionActivityAttention({ session: row, presentationSource: source, nowMs });
            expect(attention.title).toBe('Current title');
            expect(attention.awareness.statusReason).toBe('Held private explanation');
        }
        expect(unrelatedReads).toBe(0);
    });
    it('presents mixed tuples and held request bodies without reconstructing a Session', () => {
        const nowMs = 1_000_000;
        const base = createSessionFixture({ id: 'mixed', serverId: 'home', active: true, activeAt: nowMs,
            metadataVersion: 3, metadata: { path: '/new', host: 'machine', name: 'Current title' },
            latestTurnStatus: 'completed', latestTurnStatusObservedAt: nowMs,
            agentState: { requests: { r: { kind: 'permission', tool: 'Bash', arguments: {}, createdAt: nowMs } } },
            pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0 });
        const row = buildSessionListRenderableFromSession({ ...base, seq: base.seq + 1, metadataVersion: 2,
            metadata: { path: '/old', host: 'old', name: 'Old title' }, latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1 });
        const expected = buildSessionActivityAttention({ session: buildSessionFromListRenderable(row, { baseSession: base, serverId: 'home' }), nowMs });
        const actual = buildSessionActivityAttention({ session: row,
            presentationSource: createSessionListPresentationSource(row, { baseSession: base, serverId: 'home' }), nowMs });
        expect(actual.session).toBe(row);
        expect(actual.awareness).toEqual(expected.awareness);
        expect(actual.personalAttention).toEqual(expected.personalAttention);
        expect(actual.workStatus).toEqual(expected.workStatus);
        expect([actual.title, actual.subtitle]).toEqual([expected.title, expected.subtitle]);
    });
    it('retains the protected owner Account and invalidates stale starter projections', () => {
        const session = createSessionFixture({ ownerAccountId: 'owner', origin: { kind: 'none' } });
        const row = buildSessionListRenderableFromSession(session);
        expect(row.ownerAccountId).toBe('owner');
        expect(buildSessionFromListRenderable(row).ownerAccountId).toBe('owner');
        expect(areSessionListRenderablesEqual(row, { ...row, ownerAccountId: 'other' })).toBe(false);
    });
    it('uses independently current metadata for work facts when an opened report has older metadata', () => {
        const metadata = (title: string) => ({ path: '/repo', host: 'test', sessionWorkStateV1: {
            v: 1 as const, backendId: 'claude', updatedAt: 1_000_000,
            items: [{ id: 'task', kind: 'task' as const, origin: 'happier' as const, title,
                status: 'active' as const, updatedAt: 1_000_000 }],
        } });
        const base = createSessionFixture({ seq: 20, metadataVersion: 1, active: true, activeAt: 1_000_000,
            metadata: { ...metadata('Earlier work'), work: { memoryEnabled: true } } });
        const row = buildSessionListRenderableFromSession({ ...base, seq: 19, metadataVersion: 2, metadata: metadata('Current work') });
        expect(getSessionStatus(row, 1_000_000).awareness.currentWork?.title).toBe('Current work');
        const current = buildSessionFromListRenderable(row, { baseSession: base });
        expect(getSessionStatus(current, 1_000_000).awareness.currentWork)
            .toEqual(getSessionStatus(row, 1_000_000).awareness.currentWork);
        expect(current.metadata?.work).toEqual(base.metadata?.work);
        expect(current.metadata?.sessionWorkStateV1).toEqual(base.metadata?.sessionWorkStateV1);
        expect(current.workDisplay).toEqual(row.workDisplay);
        expect(current.metadataVersion).toBe(2);
        const newerBase = { ...base, metadataVersion: 3, metadata: metadata('Newest work') };
        const retained = buildSessionFromListRenderable(row, { baseSession: newerBase });
        expect(getSessionStatus(retained, 1_000_000).awareness.currentWork)
            .toEqual(getSessionStatus(newerBase, 1_000_000).awareness.currentWork);
        expect(retained.metadataVersion).toBe(3);
    });
    it('keeps the public Agent and owner view on the selected layout-v1 metadata tuple', () => {
        const base = createSessionFixture({ metadataLayoutVersion: 1, metadataVersion: 3,
            metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'codex' } }, 1),
            ownerMetadataView: { path: '/newer', host: 'machine', work: { memoryEnabled: true } } });
        const row = buildSessionListRenderableFromSession({ ...base, metadataVersion: 2,
            metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'claude' } }, 1),
            ownerMetadataView: { path: '/older', host: 'machine' } });
        const retained = buildSessionFromListRenderable(row, { baseSession: base });
        expect(readSessionPresentationAgentId(retained)).toBe('codex');
        expect(readSessionOwnerMetadataView(retained)).toEqual(base.ownerMetadataView);
        expect(retained.metadataVersion).toBe(3);
    });
    it('merges independently ordered turn facts instead of reviving an older in-progress state', () => {
        const base = createSessionFixture({ id: 'report', seq: 10, active: true, latestTurnStatus: 'completed', latestTurnStatusObservedAt: 30 });
        const row = buildSessionListRenderableFromSession({ ...base, seq: 11, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: 20 });
        const report = buildSessionFromListRenderable(row, { baseSession: base });
        expect(report.seq).toBe(11);
        expect(report.latestTurnStatus).toBe('completed');
    });
    it('keeps the list work facts when a layout-v1 report has not been opened', () => {
        const nowMs = 1_000_000;
        const source = createSessionFixture({ metadataLayoutVersion: 1, active: true, activeAt: nowMs,
            metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'claude' } }, 1),
            ownerMetadataView: { path: '/repo', host: 'test', sessionWorkStateV1: { v: 1, backendId: 'claude', updatedAt: nowMs,
                items: [{ id: 'task', kind: 'task', origin: 'happier', title: 'Payments rollout', status: 'blocked', updatedAt: nowMs }] } } });
        const row = buildSessionListRenderableFromSession(source);
        const report = buildSessionFromListRenderable(row);
        expect(getSessionStatus(row, nowMs).awareness.currentWork).toBeDefined();
        expect(getSessionStatus(report, nowMs).awareness.currentWork).toEqual(getSessionStatus(row, nowMs).awareness.currentWork);
        expect(report.workDisplay).toEqual(row.workDisplay);
        expect(readSessionOwnerMetadataView(report)?.sessionWorkStateV1).toBeUndefined();
    });
    it('keeps the declared public Agent identity when an unopened layout-v1 report is reconstructed', () => {
        const source = createSessionFixture({ metadataLayoutVersion: 1,
            metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'claude' } }, 1),
            ownerMetadataView: { path: '/repo', host: 'test', flavor: 'codex' } });
        const row = buildSessionListRenderableFromSession(source);
        const report = buildSessionFromListRenderable(row);
        expect(readSessionPresentationAgentId(report)).toBe('claude');
        expect(readSessionOwnerMetadataView(report)?.path).toBe('/repo');
        const { flavor: _previousAgentId, ...withoutAgent } = row.metadata!;
        const changed = buildSessionFromListRenderable({ ...row, metadata: withoutAgent,
            seq: row.seq + 1, metadataVersion: row.metadataVersion + 1 }, { baseSession: report });
        expect(readSessionPresentationAgentId(changed)).toBeNull();
        const unreadable = buildSessionFromListRenderable({ ...row, metadata: null, metadataUnavailable: true });
        expect(readSessionPresentationAgentId(unreadable)).toBeNull();
        const warmUnreadable = buildSessionFromListRenderable({ ...row, metadata: null, metadataUnavailable: true }, { baseSession: source });
        expect(warmUnreadable.metadata).toBeNull();
        expect(warmUnreadable.ownerMetadataView).toBeNull();
    });
    it('preserves an explicit detached list edge rather than reviving the opened session lead', () => {
        const base = createSessionFixture({ manager: { sessionId: 'former-lead' } });
        const detached = buildSessionListRenderableFromSession({ ...base, manager: null });
        expect(buildSessionFromListRenderable(detached, { baseSession: base }).manager).toBeNull();
        expect(buildSessionFromListRenderable({ ...detached, manager: undefined }, { baseSession: base }).manager)
            .toEqual({ sessionId: 'former-lead' });
    });
    it('keeps legacy row metadata readable without reviving an unavailable layout-v1 owner view', () => {
        const legacy = createSessionFixture({
            metadata: {
                path: '/home/alice/project',
                host: 'workstation',
                machineId: 'machine-a',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });
        const row = buildSessionListRenderableFromSession(legacy);
        const reconstructed = buildSessionFromListRenderable(row);
        expect(readSessionOwnerMetadataView(reconstructed)).toMatchObject({
            path: '/home/alice/project',
            machineId: 'machine-a',
            hiddenSystemSession: true,
        });

        const unavailable = buildSessionFromListRenderable({
            ...row,
            metadataLayoutVersion: 1,
            metadataUnavailable: true,
        });
        expect(readSessionOwnerMetadataView(unavailable)).toBeNull();
        expect(readSessionOwnerMetadataView(buildSessionFromListRenderable({
            ...row,
            metadataUnavailable: true,
        }))).toBeNull();
        const contracted = buildSessionFromListRenderable({ ...row, metadataLayoutVersion: 1, metadata: null,
            metadataVersion: 0, metadataUnavailable: true, access: createSessionAccessFixture('view'), accessLevel: 'view' },
        { baseSession: legacy });
        expect(contracted.metadata).toBeNull();
        expect(contracted.ownerMetadataView).toBeNull();
    });

    it('preserves the safe responsible Account summary through list renderable reconstruction', () => {
        const responsibleAccount = {
            kind: 'account' as const,
            accountId: 'account-alice',
            name: 'Alice',
            firstName: 'Alice',
            lastName: null,
            username: 'alice',
            avatarUrl: null,
        };
        const source = createSessionFixture({
            id: 'assigned-session',
            responsibleAccountId: responsibleAccount.accountId,
            responsibleAccount,
        });

        const renderable = buildSessionListRenderableFromSession(source);
        expect(renderable.responsibleAccountId).toBe(responsibleAccount.accountId);
        expect(renderable.responsibleAccount).toEqual(responsibleAccount);

        const reconstructed = buildSessionFromListRenderable(renderable);
        expect(reconstructed.responsibleAccountId).toBe(responsibleAccount.accountId);
        expect(reconstructed.responsibleAccount).toEqual(responsibleAccount);
    });

    it('keeps omitted and explicit-null responsibility summaries distinct', () => {
        const omitted = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'unsupported-session',
        }));
        const unassigned = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'unassigned-session',
            responsibleAccountId: null,
            responsibleAccount: null,
        }));

        expect('responsibleAccount' in omitted).toBe(false);
        expect(unassigned.responsibleAccount).toBeNull();
        expect('responsibleAccount' in buildSessionFromListRenderable(omitted)).toBe(false);
        expect(buildSessionFromListRenderable(unassigned).responsibleAccount).toBeNull();
    });

    it('reconstructs a layout-v1 owner metadata view without exposing it to recipients', () => {
        const ownerMetadata = {
            path: '/home/alice/project',
            homeDir: '/home/alice',
            host: 'workstation',
            machineId: 'machine-a',
        };
        const renderable = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'layout-v1-owner',
            metadataLayoutVersion: 1,
            metadata: null,
            ownerMetadataView: ownerMetadata,
            access: {
                role: 'owner',
                level: 'owner',
                capabilities: projectLegacySessionAccessCapabilitiesV1({
                    level: 'owner',
                    canApprovePermissions: true,
                }),
            },
        }));

        const ownerSession = buildSessionFromListRenderable(renderable);
        expect(ownerSession.metadataLayoutVersion).toBe(1);
        expect(readSessionOwnerMetadataView(ownerSession)).toMatchObject(ownerMetadata);

        const recipientSession = buildSessionFromListRenderable({
            ...renderable,
            access: {
                role: 'recipient',
                level: 'view',
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
            },
            accessLevel: 'view',
        });
        expect(recipientSession.metadataLayoutVersion).toBe(1);
        expect(recipientSession.ownerMetadataView).toBeNull();
        expect(readSessionOwnerMetadataView(recipientSession)).toBeNull();
    });
    it('carries the admitted Project relationship without reviving an omitted or cleared base relationship', () => {
        const session = createSessionFixture({ projectKey: 'payments' });
        const row = buildSessionListRenderableFromSession(session);
        expect(buildSessionFromListRenderable(row).projectKey).toBe('payments');
        expect(buildSessionFromListRenderable({ ...row, projectKey: null }, { baseSession: session }).projectKey).toBeNull();
        expect(buildSessionFromListRenderable({ ...row, projectKey: undefined }, { baseSession: session }).projectKey).toBeUndefined();
    });

});
