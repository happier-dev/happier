import type { SessionPersonalAttentionReasonV1 } from '@happier-dev/protocol/sessions/personal/attention';

import type {
  SessionListSampleGroup,
  SessionListSampleRow,
} from '@/components/settings/session/SessionListPreview';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import type { SessionListLayoutChoice } from '@/sync/domains/session/listing/sessionListLayout';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { t } from '@/text';

export type SessionListAttentionPlacementChoice = 'both' | 'top' | 'inPlace';

type SampleKey = 'reconnect' | 'craft' | 'review' | 'pricing' | 'docs';

function sampleRow(key: SampleKey): SessionListSampleRow {
  switch (key) {
    case 'reconnect':
      return {
        id: 'personalize-reconnect',
        title: t('personalize.sampleSessionReconnect'),
        project: '~/happier',
        status: { label: t('personalize.sampleWorking'), tone: 'neutral' },
      };
    case 'craft':
      return {
        id: 'personalize-craft',
        title: t('personalize.sampleSessionCraft'),
        project: '~/happier',
        status: { label: t('personalize.sampleNeedsYou'), tone: 'attention' },
      };
    case 'review':
      return {
        id: 'personalize-review',
        title: t('personalize.sampleSessionReview'),
        project: '~/happier',
        status: { label: t('personalize.sampleNeedsYou'), tone: 'attention' },
      };
    case 'pricing':
      return {
        id: 'personalize-pricing',
        title: t('personalize.sampleSessionPricing'),
        project: '~/website',
        status: { label: t('personalize.sampleReady'), tone: 'attention' },
      };
    case 'docs':
      return {
        id: 'personalize-docs',
        title: t('personalize.sampleSessionDocs'),
        project: '~/website',
      };
  }
}

const SAMPLE_NOW_MS = 1_000_000;

function sampleSession(
  key: SampleKey,
  primary: SessionPersonalAttentionReasonV1 | null,
  patch: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
  return {
    id: `personalize-${key}`,
    seq: 2,
    createdAt: 1,
    updatedAt: SAMPLE_NOW_MS,
    active: true,
    activeAt: SAMPLE_NOW_MS,
    metadataVersion: 1,
    agentStateVersion: 1,
    metadata: null,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
    viewer: {
      latestFailureSeq: null,
      readState: {
        state: 'tracking',
        lastViewedSessionSeq: primary === 'ready_after_read' ? 1 : 2,
        unreadSince: null,
      },
      relevance: { relevant: true, reasons: ['followed_by_me'] },
      follow: { follows: true, notificationLevel: 'none' },
      notification: { level: 'none', source: 'preference' },
      attention: {
        needsAttention: primary !== null,
        reasons: primary ? [primary] : [],
        primary,
        presentation: 'full',
      },
    },
    ...patch,
  };
}

// Static viewer/runtime facts, shaped exactly like the live listing owner's inputs.
const SAMPLE_SESSIONS: Readonly<
  Record<SampleKey, SessionListRenderableSession>
> = {
  reconnect: sampleSession('reconnect', null, {
    thinking: true,
    thinkingAt: SAMPLE_NOW_MS,
    latestTurnStatus: 'in_progress',
    latestTurnStatusObservedAt: SAMPLE_NOW_MS,
  }),
  craft: sampleSession('craft', 'permission_required', {
    hasPendingPermissionRequests: true,
    pendingRequestObservedAt: SAMPLE_NOW_MS,
  }),
  review: sampleSession('review', 'user_action_required', {
    hasPendingUserActionRequests: true,
    pendingRequestObservedAt: SAMPLE_NOW_MS,
  }),
  pricing: sampleSession('pricing', 'ready_after_read', {
    latestTurnStatus: 'completed',
    latestTurnStatusObservedAt: SAMPLE_NOW_MS,
    lastTurnCompletedAt: SAMPLE_NOW_MS,
  }),
  docs: sampleSession('docs', null, { active: false }),
};

/**
 * A small sample sessions list arranged by the live listing owner under a layout and an attention
 * placement: the groups Settings and Personalize draw their arrangement previews from. Only the
 * sample sessions are static; grouping, promotion and ordering are the real owner's.
 */
export function buildSessionListArrangementSample(
  layout: SessionListLayoutChoice,
  attention: SessionListAttentionPlacementChoice,
): SessionListSampleGroup[] {
  const groups: Array<{ heading: string; keys: SampleKey[] }> =
    layout === 'projects'
      ? [
          { heading: '~/happier', keys: ['reconnect', 'craft', 'review'] },
          { heading: '~/website', keys: ['pricing', 'docs'] },
        ]
      : [
          {
            heading: t('sessionHistory.today'),
            keys: ['reconnect', 'review', 'pricing'],
          },
          { heading: t('sessionHistory.yesterday'), keys: ['craft', 'docs'] },
        ];
  const rows = new Map(
    groups.flatMap((group) =>
      group.keys.map(
        (key) =>
          [
            SAMPLE_SESSIONS[key].id,
            { session: SAMPLE_SESSIONS[key], row: sampleRow(key) },
          ] as const,
      ),
    ),
  );
  const source: SessionListIndexItem[] = groups.flatMap(
    (group, index): SessionListIndexItem[] => {
      const groupKey = `personalize-group-${index}`;
      const groupKind = layout === 'projects' ? 'project' : 'date';
      return [
        { type: 'header' as const, title: group.heading, groupKey },
        ...group.keys.map(
          (key): Extract<SessionListIndexItem, { type: 'session' }> => ({
            type: 'session',
            serverId: 'personalize-sample-home',
            sessionId: SAMPLE_SESSIONS[key].id,
            groupKey,
            groupKind,
          }),
        ),
      ];
    },
  );
  const arranged =
    computeVisibleSessionListIndex({
      source,
      sessionListLayoutChoice: layout,
      sessionListAttentionPlacementV1: attention,
      resolveSessionRow: (_serverId, id) => rows.get(id)?.session ?? null,
      nowMs: SAMPLE_NOW_MS,
      hideInactiveSessions: false,
      pinnedSessionKeysV1: [],
      sessionListGroupOrderV1: {},
      presentation: { enabled: false, presentation: 'grouped' },
    }) ?? [];
  const result: Array<{ heading: string; rows: SessionListSampleRow[] }> = [];
  for (const item of arranged) {
    if (item.type === 'header') result.push({ heading: item.title, rows: [] });
    else if (item.type === 'session') {
      const row = rows.get(item.sessionId)?.row;
      if (row) result.at(-1)?.rows.push(row);
    }
  }
  return result.filter((group) => group.rows.length > 0);
}
