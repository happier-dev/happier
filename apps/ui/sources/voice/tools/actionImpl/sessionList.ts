import { readStoredSessionMessages } from "@happier-dev/session-core/messages";
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { storage } from '@/sync/domains/state/storage';
import { buildSessionAwarenessListResultV1, markSessionListQueryResultV1, type SessionListViewV1 } from '@happier-dev/protocol/sessions/awareness/action';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { matchSessionBotFilterV1, matchSessionProjectScopeV1, resolveSessionProjectScopeV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { projectSessionSummaryIdentityV1, projectSessionSummaryV1 } from '@happier-dev/protocol/sessions/control/listResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { createSessionProjectKeyResolverV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionListRenderableOwnerMetadataView } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { admitProjectWorkspaceCensusForSubject } from '@/sync/domains/workspaces/projectWorkspaceCensusAdmission';
import { readProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { readCurrentProjectAccountRows } from '@/sync/store/domains/projectAccountRows';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { fetchSessionListQueryPageForHome, readOrdinarySessionListLifecycle } from '@/sync/domains/session/listing/sessionListQueryRuntime';
import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { HappyError } from '@/utils/errors/errors';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { readAwarenessPresence } from '@/sync/domains/session/attention/runtimePresentation';

import {
  parseCursorKey as parseLegacyCursorKey,
  normalizeNonEmptyString,
  resolveVoiceUpdatesPrefs,
  toRoleAndText,
} from './shared';
import { acquireAdmittedSessionReferenceCorpusOptions } from './admittedSessionReferenceCorpus';
import { collectVoiceSessionCorpus } from './voiceSessionRows';

type VoiceSessionListCursorKey = Readonly<{
  updatedAt: number;
  id: string;
  serverId: string;
}>;

type ParsedVoiceSessionListCursor =
  | Readonly<{ kind: 'qualified'; key: VoiceSessionListCursorKey }>
  | Readonly<{ kind: 'legacy'; key: Readonly<{ updatedAt: number; id: string }> }>;

/**
 * The summary-list cursor is an opaque structured tuple because its order is Home-qualified.
 * The legacy delimiter form remains read-only for an in-flight released Voice turn; new cursors
 * always carry the exact Home and cannot collapse equal Session ids from different Homes.
 */
function parseVoiceSessionListCursor(cursor: string | null | undefined): ParsedVoiceSessionListCursor | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(cursor);
    if (
      Array.isArray(value)
      && value.length === 4
      && value[0] === 1
      && typeof value[1] === 'number'
      && Number.isFinite(value[1])
      && typeof value[2] === 'string'
      && value[2].length > 0
      && typeof value[3] === 'string'
      && value[3].length > 0
    ) {
      return {
        kind: 'qualified',
        key: { updatedAt: value[1], id: value[2], serverId: value[3] },
      };
    }
  } catch {
    // The incumbent released cursor is not JSON. Delegate its exact parsing to its owner below.
  }
  const legacy = parseLegacyCursorKey(cursor);
  return legacy ? { kind: 'legacy', key: legacy } : null;
}

function formatVoiceSessionListCursor(key: VoiceSessionListCursorKey | null): string | null {
  return key ? JSON.stringify([1, key.updatedAt, key.id, key.serverId]) : null;
}

function compareVoiceSessionListKeysDesc(left: VoiceSessionListCursorKey, right: VoiceSessionListCursorKey): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  if (left.id !== right.id) return left.id < right.id ? 1 : -1;
  return left.serverId < right.serverId ? 1 : left.serverId > right.serverId ? -1 : 0;
}

function isVoiceSessionListKeyAfterCursor(
  key: VoiceSessionListCursorKey,
  cursor: ParsedVoiceSessionListCursor,
): boolean {
  if (key.updatedAt !== cursor.key.updatedAt) return key.updatedAt < cursor.key.updatedAt;
  if (key.id !== cursor.key.id) return key.id < cursor.key.id;
  return cursor.kind === 'qualified' ? key.serverId < cursor.key.serverId : false;
}

function readRetainedPreview(state: ReturnType<typeof storage.getState>, serverId: string, sessionId: string) {
  if (!areServerProfileIdentifiersEquivalent(serverId, getActiveServerSnapshot().serverId)) return undefined;
  const messages = readStoredSessionMessages(state, sessionId);
  const last = messages.at(-1);
  if (!last) return undefined;
  const prefs = resolveVoiceUpdatesPrefs(state.settings);
  if (!prefs.shareRecentMessages && (last.kind === 'agent-text' || last.kind === 'user-text')) return undefined;
  const preview = toRoleAndText(last, {
    shareToolNames: prefs.shareToolNames,
    shareToolArgs: prefs.shareToolArgs,
    shareFilePaths: prefs.shareFilePaths,
  });
  return preview.text && preview.role
    ? { role: preview.role, text: preview.text, createdAt: last.createdAt ?? null }
    : undefined;
}

function projectMountedSessionSummary(
  session: SessionListRenderableSession,
  serverId: string,
  presence: string | null,
) {
  return {
    ...projectSessionSummaryV1({ row: session,
      metadata: session.metadataUnavailable ? null : readSessionListRenderableOwnerMetadataView(session),
      encryption: null }),
    title: getSessionName(session, serverId), serverId, presence,
  };
}

export async function listSessionsForVoiceTool(params: Readonly<{
  context?: Pick<ActionExecutorContext, 'sessionListAccess'>;
  project?: QualifiedProjectKeyV1;
  limit?: number;
  cursor?: string | null;
  includeLastMessagePreview?: boolean;
  view?: SessionListViewV1;
  query?: SessionListQueryV1;
  serverId?: string | null;
  signal?: AbortSignal;
}>) {
  if (params.serverId || params.view === 'awareness' || params.query || params.project) {
    const serverId = params.serverId ?? params.project?.serverId ?? getActiveServerSnapshot().serverId;
    const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
    if (params.project && !areServerProfileIdentifiersEquivalent(params.project.serverId, serverId)) return failure('server_scope_mismatch');
    if (params.signal?.aborted) return failure('tool_cancelled');
    if (params.view === 'awareness' && params.includeLastMessagePreview) return failure('invalid_parameters');
    try {
      let cursor = params.cursor ?? params.query?.cursor;
      let attentionCursor = params.query?.attentionCursor;
      let previousPage: Awaited<ReturnType<typeof fetchSessionListQueryPageForHome>> | null = null;
      const seenCursors = new Set<string>();
      let botFilterUnavailableCount = 0;
      let projectFilterUnavailableCount = 0;
      let metadataUpgradeRequiredCount = 0;
      for (;;) {
        let page = await fetchSessionListQueryPageForHome(serverId, {
          limit: params.limit ?? params.query?.limit,
          // Ad-hoc Voice/Action reads share the canonical row parser/hydrator but never own
          // ordinary, archived, or mounted-query membership.
          membership: 'rowOnly',
          source: params.query
            ? { kind: 'query', body: { ...params.query, cursor, attentionCursor }, allowV1Fallback: false }
            : { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: true },
          ...(cursor !== undefined ? { cursor } : {}),
          ...(attentionCursor !== undefined ? { attentionCursor } : {}),
          signal: params.signal ?? new AbortController().signal,
        });
        // A page that resolves after this tool call was cancelled is not a stale Home:
        // report the cancellation the caller actually caused.
        if (params.signal?.aborted) return failure('tool_cancelled');
        if (!page.current) return failure('stale_response');
        if (previousPage && params.query) {
          page = attentionCursor
            ? { ...page, nextCursor: previousPage.nextCursor, hasNext: previousPage.hasNext }
            : { ...page, attentionNextCursor: previousPage.attentionNextCursor,
              attentionHasNext: previousPage.attentionHasNext };
        }
        previousPage = page;
        const state = storage.getState();
        const rows = page.sessionIds
          .filter((sessionId) => page.isSessionCurrent?.(sessionId) !== false)
          .map((sessionId) => findSessionListLookupSession(state, { serverId, sessionId })?.session);
        if (rows.some((row) => !row)) return failure('invalid_response');
        const projectRows = readCurrentProjectAccountRows(state);
        const workspaceContext = workspaceRefResolutionContextV1();
        const workspaceRefs = readProjectAccountWorkspaceRefs(state);
        const sessionProjectKeyResolver = params.project ? createSessionProjectKeyResolverV1(workspaceRefs, workspaceContext) : undefined;
        const projectScope = params.project ? resolveSessionProjectScopeV1(params.project, workspaceRefs, workspaceContext.normalizeServerId) : undefined;
        const sessions = rows.flatMap((row) => {
          if (!row) return [];
          if (projectScope) {
            const census = admitProjectWorkspaceCensusForSubject({
              subject: { kind: 'session', ownerAccountId: row.ownerAccountId, access: row.access, accessLevel: row.accessLevel },
              rowServerId: serverId, censusServerId: projectRows?.scope.serverId, viewerAccountId: state.profileScope?.accountId,
              workspaceRefs, sessionProjectKeyResolver,
            });
            const projectMatch = matchSessionProjectScopeV1(row.metadataUnavailable ? null : readSessionListRenderableOwnerMetadataView(row), serverId, projectScope,
              census.workspaceRefs, { ...workspaceContext, projectKey: row.projectKey,
                sessionProjectKeyResolver: census.sessionProjectKeyResolver });
            if (projectMatch === 'unavailable') projectFilterUnavailableCount += 1;
            if (projectMatch !== 'match') return [];
          }
          const match = matchSessionBotFilterV1(row.metadata, params.query?.bot);
          if (match === 'unavailable') botFilterUnavailableCount += 1;
          return match === 'match' ? [row] : [];
        });
        metadataUpgradeRequiredCount += page.metadataUpgradeRequiredCount ?? 0;
        if (params.project && sessions.length === 0) {
          const nextCursor = page.hasNext ? page.nextCursor : null;
          const nextAttentionCursor = !nextCursor && params.query && page.attentionHasNext
            ? page.attentionNextCursor : null;
          const continuation = nextCursor ?? nextAttentionCursor;
          if (continuation) {
            const key = JSON.stringify([nextCursor ? 'ordinary' : 'attention', continuation]);
            if (seenCursors.has(key)) return failure('cursor_not_advancing');
            seenCursors.add(key);
            cursor = nextCursor ?? undefined;
            attentionCursor = nextAttentionCursor ?? undefined;
            continue;
          }
        }
        if (params.view === 'awareness') {
          const pageResult = {
            ...(params.project ? { project: params.project, projectFilterUnavailableCount } : {}),
            sessions: sessions.map((session) => {
              const awareness = projectUiSessionAwareness(session, Date.now());
              return isSessionAwarenessContentReadableV1(awareness.encryption)
                ? { ...awareness, title: getSessionName(session, serverId) }
                : awareness;
            }),
            nextCursor: page.nextCursor,
            hasNext: page.hasNext,
            ...(metadataUpgradeRequiredCount > 0 ? { metadataUpgradeRequiredCount } : {}),
            ...(botFilterUnavailableCount > 0 ? { botFilterUnavailableCount } : {}),
          };
          // Lane 07 attention continuation is a strict-query fact: a strict query proves
          // both page families, while an ordinary awareness read never queried that
          // family and reports nothing for it (the CLI host does the same).
          return params.query
            ? buildSessionAwarenessListResultV1({
                ...pageResult,
                attentionNextCursor: page.attentionNextCursor ?? null,
                attentionHasNext: page.attentionHasNext ?? false,
              })
            : buildSessionAwarenessListResultV1(pageResult);
        }
        const privacy = readVoicePrivacySettings(state.settings);
        const result = {
          ...(params.project ? { project: params.project, projectFilterUnavailableCount } : {}),
          ok: true as const,
          sessions: sessions.map((session) => {
            const preview = params.includeLastMessagePreview ? readRetainedPreview(state, serverId, session.id) : undefined;
            const presence = readAwarenessPresence(session.presence);
            // The host stamps mounted UI demand. Voice disclosure preferences govern
            // provider-facing reads, while product UI consumes the canonical summary.
            if (params.context?.sessionListAccess === 'mounted_ui') {
              return { ...projectMountedSessionSummary(session, serverId, presence === 'unknown' ? null : presence),
                ...(preview ? { lastMessagePreview: preview } : {}) };
            }
            return {
              id: session.id, active: session.active, presence: presence === 'unknown' ? null : presence, updatedAt: session.updatedAt,
              serverId,
              ...projectSessionSummaryIdentityV1(session.metadata),
              ...(session.manager != null ? { manager: session.manager } : {}),
              ...(privacy.shareSessionSummary && session.metadata?.summaryText ? { title: session.metadata.summaryText } : {}),
              ...(preview ? { lastMessagePreview: preview } : {}),
            };
          }),
          nextCursor: page.nextCursor,
          hasNext: page.hasNext,
          attentionNextCursor: page.attentionNextCursor ?? null,
          attentionHasNext: page.attentionHasNext ?? false,
          ...(metadataUpgradeRequiredCount > 0 ? { metadataUpgradeRequiredCount } : {}),
          ...(botFilterUnavailableCount > 0 ? { botFilterUnavailableCount } : {}),
        };
        return markSessionListQueryResultV1(result);
      }
    } catch (error) {
      return failure(params.signal?.aborted ? 'tool_cancelled' : error instanceof HappyError && error.code ? error.code : 'network_error');
    }
  }
  const initialState = storage.getState();
  const limit =
    typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.max(1, Math.min(100, Math.floor(params.limit)))
      : 100;
  const includeLastMessagePreview = params.includeLastMessagePreview === true;
  const cursorKey = parseVoiceSessionListCursor(params.cursor ?? null);

  const corpusOptions = await acquireAdmittedSessionReferenceCorpusOptions(initialState, {
    signal: params.signal,
  });
  if (params.signal?.aborted) return { ok: false as const, errorCode: 'tool_cancelled', error: 'tool_cancelled' };

  // Acquisition is a row-only read and may update the shared lookup rows while it is
  // in flight. Re-read after the await, then enumerate only the qualified corpus it
  // returned. A missing corpus is incomplete coverage, never permission to fall back
  // to retained row-cache presence.
  const state = storage.getState();
  const corpus = collectVoiceSessionCorpus(state, corpusOptions ?? {
    knownServerIds: [],
    addresses: [],
    coverage: 'incomplete',
  });
  const visibleSessionRows = corpus.rows;
  const rows = visibleSessionRows
    .map((row) => {
      const updatedAt = row.updatedAt;
      return {
        id: row.id,
        key: { updatedAt, id: row.id, serverId: row.serverId } satisfies VoiceSessionListCursorKey,
        active: row.active,
        presence: row.presence,
        updatedAt,
        title: row.title ?? row.id,
        locationLabel: normalizeNonEmptyString(row.locationLabel),
        serverId: row.serverId,
        serverName: normalizeNonEmptyString(row.serverName),
      };
    })
;

  const privacy = readVoicePrivacySettings(state?.settings);

  const pageRows = rows
    .sort((a, b) => compareVoiceSessionListKeysDesc(a.key, b.key))
    .filter((s) => (cursorKey ? isVoiceSessionListKeyAfterCursor(s.key, cursorKey) : true))
    .slice(0, limit);

  const sessions = pageRows
    .map((s) => {
      const preview = includeLastMessagePreview ? readRetainedPreview(state, s.serverId, s.id) : undefined;
      if (params.context?.sessionListAccess === 'mounted_ui') {
        // The admitted corpus contains the exact hydrated, Home-qualified list rows.
        const row = readSessionListRowForServerId(state.sessionListRowsByServerId, s.serverId, s.id)!;
        return { ...projectMountedSessionSummary(row, s.serverId, s.presence),
          ...(s.serverName ? { serverName: s.serverName } : {}), ...(preview ? { lastMessagePreview: preview } : {}) };
      }
      // The session `title` is the session summary text, so it is gated by `shareSessionSummary`.
      // Location labels are repo/workspace path tails, so they are gated by `shareFilePaths`.
      const out: { id: string; active: boolean; presence: string | null; updatedAt: number; title?: string; locationLabel?: string; serverId?: string; serverName?: string; lastMessagePreview?: { role: string; text: string; createdAt: number | null } } & ReturnType<typeof projectSessionSummaryIdentityV1> = {
        id: s.id,
        active: s.active,
        presence: s.presence,
        updatedAt: s.updatedAt,
        ...projectSessionSummaryIdentityV1(readSessionListRowForServerId(state.sessionListRowsByServerId, s.serverId ?? '', s.id)?.metadata),
      };
      if (privacy.shareSessionSummary && typeof s.title === 'string' && s.title.trim().length > 0) {
        out.title = s.title;
      }
      if (privacy.shareFilePaths && typeof s.locationLabel === 'string' && s.locationLabel.trim().length > 0) {
        out.locationLabel = s.locationLabel;
      }
      if (typeof s.serverId === 'string' && s.serverId.trim().length > 0) {
        out.serverId = s.serverId;
      }
      if (typeof s.serverName === 'string' && s.serverName.trim().length > 0) {
        out.serverName = s.serverName;
      }
      if (preview) out.lastMessagePreview = preview;
      return out;
    });

  const nextCursor = formatVoiceSessionListCursor(pageRows.at(-1)?.key ?? null);
  // This summary enumerates the retained ordinary corpus. Read its omission
  // observations from the same per-Home lifecycle, never from a filtered pane.
  const serverIds = new Set([
    ...Object.keys(state.ordinarySessionListMembershipByServerId),
    getActiveServerSnapshot().serverId,
  ].map(resolveServerProfileScopeIdForIdentifier).filter(Boolean));
  let metadataUpgradeRequiredCount = 0;
  for (const serverId of serverIds) {
    metadataUpgradeRequiredCount += readOrdinarySessionListLifecycle(serverId).frontier.metadataUpgradeRequiredCount ?? 0;
  }

  return {
    ok: true,
    sessions,
    nextCursor,
    coverage: corpus.coverage.complete ? 'complete' as const : 'incomplete' as const,
    ...(metadataUpgradeRequiredCount > 0 ? { metadataUpgradeRequiredCount } : {}),
  };
}
