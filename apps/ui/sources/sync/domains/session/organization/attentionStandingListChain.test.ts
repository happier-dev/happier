/**
 * LANE-1 diagnosis: drives the REAL attention-standing chain end to end —
 *
 *   store optimistic write (setSessionAttentionStandingOptimistic)
 *     -> buildSessionOrganizationProjection
 *     -> buildSessionOrganizationListViewState
 *     -> SessionAttentionStandingPolicy (the pure equivalent of useSessionAttentionStandingInputs)
 *     -> computeVisibleSessionListIndex (attentionPromotion.mode !== 'off')
 *
 * The only boundary stood in for is the zustand store container itself; every
 * domain module below is the real one.
 */
import { describe, expect, it } from 'vitest';

import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import type { SessionListIndexItem } from '@/sync/domains/session/listing/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    createSessionOrganizationDomain,
    type SessionOrganizationDomain,
} from '@/sync/store/domains/sessionOrganization';
import type { SessionOrganizationSnapshot } from '@happier-dev/protocol';

import type { SessionAttentionStandingPolicy } from './attentionStanding';
import { buildSessionOrganizationProjection } from './projection';
import type { NormalizedSessionOrganizationState } from './types';
import { buildSessionOrganizationListViewState } from './viewState';

const SERVER_ID = 'srv-a';
const SESSION_ID = 'quiet-session';
const NOW = 3_000_000;

function createStoreHarness(): { get: () => SessionOrganizationDomain } {
    let state = {} as SessionOrganizationDomain;
    const get = () => state;
    const set = (updater: (draft: SessionOrganizationDomain) => Partial<SessionOrganizationDomain>) => {
        state = { ...state, ...updater(state) };
    };
    state = createSessionOrganizationDomain({ get, set } as never);
    return { get };
}

function emptySnapshot(input: Partial<SessionOrganizationSnapshot> = {}): SessionOrganizationSnapshot {
    return {
        schemaVersion: 1,
        version: input.version ?? 1,
        pins: input.pins ?? [],
        folders: input.folders ?? [],
        folderAssignments: input.folderAssignments ?? [],
        tags: input.tags ?? [],
        tagAssignments: input.tagAssignments ?? [],
        orderEntries: input.orderEntries ?? [],
        labels: input.labels ?? [],
        attentionStandings: input.attentionStandings,
    };
}

/**
 * Exactly the selector `useSessionOrganizationProjection` runs
 * (apps/ui/sources/sync/store/hooks.ts:328-342) against the live store state.
 */
function readNormalizedOrganizationState(state: SessionOrganizationDomain): NormalizedSessionOrganizationState {
    return {
        schemaVersionByServerId: state.sessionOrganizationSchemaVersionByServerId,
        snapshotVersionByServerId: state.sessionOrganizationSnapshotVersionByServerId,
        pinsBySessionKey: state.sessionOrganizationPinsBySessionKey,
        foldersByFolderKey: state.sessionOrganizationFoldersByFolderKey,
        folderAssignmentsBySessionKey: state.sessionOrganizationFolderAssignmentsBySessionKey,
        tagsByTagKey: state.sessionOrganizationTagsByTagKey,
        tagAssignmentsBySessionKey: state.sessionOrganizationTagAssignmentsBySessionKey,
        attentionStandingsBySessionKey: state.sessionOrganizationAttentionStandingsBySessionKey,
        orderEntriesByScopeKey: state.sessionOrganizationOrderEntriesByScopeKey,
        labelsByLabelKey: state.sessionOrganizationLabelsByLabelKey,
    };
}

function makeQuietSessionRow(): SessionListRenderableSession {
    // No attention reason and no working signals: placement projects { kind: 'none' }.
    return {
        id: SESSION_ID,
        seq: 4,
        createdAt: NOW - 100_000,
        updatedAt: NOW - 50_000,
        active: false,
        activeAt: NOW - 50_000,
        archivedAt: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        hasUnreadMessages: false,
        lastViewedSessionSeq: 4,
        meaningfulActivityAt: NOW - 50_000,
        keepVisibleWhenInactive: false,
    } as SessionListRenderableSession;
}

const GROUP_KEY = `server:${SERVER_ID}:day:2026-08-19`;

const SOURCE: SessionListIndexItem[] = [
    { type: 'header', headerKind: 'date', title: 'Today', serverId: SERVER_ID, groupKey: GROUP_KEY },
    { type: 'session', sessionId: SESSION_ID, serverId: SERVER_ID, section: 'inactive', groupKey: GROUP_KEY, groupKind: 'date' },
];

function resolveSessionRow(serverId: string | null | undefined, sessionId: string): SessionListRenderableSession | null {
    return String(serverId ?? '').trim() === SERVER_ID && sessionId === SESSION_ID ? makeQuietSessionRow() : null;
}

/** The pure equivalent of `useSessionAttentionStandingInputs(...).policy`. */
function buildPolicyFromStore(state: SessionOrganizationDomain, defaultStanding: boolean): SessionAttentionStandingPolicy {
    const projection = buildSessionOrganizationProjection(readNormalizedOrganizationState(state), SERVER_ID);
    const viewState = buildSessionOrganizationListViewState({ serverId: SERVER_ID, projection });
    return { defaultStanding, overridesBySessionKey: viewState.attentionStandingOverridesBySessionKey };
}

function renderRows(policy: SessionAttentionStandingPolicy): string[] {
    const result = computeVisibleSessionListIndex({
        source: SOURCE,
        resolveSessionRow,
        hideInactiveSessions: false,
        pinnedSessionKeysV1: [],
        sessionListGroupOrderV1: {},
        presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        attentionPromotion: { mode: 'global', standingPolicy: policy },
        workingPlacement: { mode: 'global' },
        nowMs: NOW,
    });
    return (result ?? []).map((item) => (item.type === 'header'
        ? `h:${item.headerKind ?? 'unknown'}`
        : `s:${item.sessionId}:${item.groupKind ?? 'none'}:${item.attentionPromotionReason ?? 'none'}`));
}

describe('attention standing reaches the visible session list through the real chain', () => {
    it('moves an ungrouped, reason-less session into the attention band after the optimistic keep lands', () => {
        const harness = createStoreHarness();
        harness.get().applySessionOrganizationSnapshot(SERVER_ID, emptySnapshot({ attentionStandings: [] }));

        // Baseline: no standing anywhere -> the session stays in its own group.
        expect(renderRows(buildPolicyFromStore(harness.get(), false))).toEqual([
            'h:date',
            `s:${SESSION_ID}:date:none`,
        ]);

        // The exact optimistic write `setSessionAttentionStanding` performs.
        harness.get().setSessionAttentionStandingOptimistic(SERVER_ID, SESSION_ID, {
            sessionId: SESSION_ID,
            standing: true,
            updatedAt: NOW,
        });

        const policy = buildPolicyFromStore(harness.get(), false);
        expect(policy.overridesBySessionKey).toEqual({ [`${SERVER_ID}:${SESSION_ID}`]: true });

        expect(renderRows(policy)).toEqual([
            'h:attention',
            `s:${SESSION_ID}:attention:standing`,
        ]);
    });
});
