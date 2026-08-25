import type {
  ActionsService,
  PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';

type PendingPermissionList = PluginActionResultById['session.permission.remote.pending.list'];

type CurrentConversationPendingPermissionRequest = PendingPermissionList['requests'][number];

/**
 * The supported pre-semantic permission projection. It is normalized at this
 * sole reader boundary so every Channels consumer continues to share one
 * pending list rather than growing a per-consumer compatibility branch.
 */
type LegacyConversationPendingPermissionRequest = Readonly<{
  kind: 'legacy_permission';
  requestId: string;
  turnId: string;
  createdAtMs: number;
  allowedScopes: readonly ('request' | 'session')[];
}>;

export type ConversationPendingPermissionRequest =
  | CurrentConversationPendingPermissionRequest
  | LegacyConversationPendingPermissionRequest;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readLegacyConversationPendingPermissionRequest(
  value: unknown,
): LegacyConversationPendingPermissionRequest | null {
  const record = asRecord(value);
  if (record === null || record.kind !== undefined) return null;
  const { requestId, turnId, createdAtMs, allowedScopes } = record;
  if (
    typeof requestId !== 'string'
    || typeof turnId !== 'string'
    || typeof createdAtMs !== 'number'
    || !Number.isSafeInteger(createdAtMs)
    || createdAtMs < 0
    || !Array.isArray(allowedScopes)
    || !allowedScopes.every((scope) => scope === 'request' || scope === 'session')
  ) return null;
  return {
    kind: 'legacy_permission',
    requestId,
    turnId,
    createdAtMs,
    allowedScopes,
  };
}

function normalizeConversationPendingPermissionRequest(
  request: CurrentConversationPendingPermissionRequest,
): ConversationPendingPermissionRequest | null {
  if (request.kind === 'permission' || request.kind === 'user_action') return request;
  return readLegacyConversationPendingPermissionRequest(request as unknown);
}

/** The exact binding-scoped source authority the canonical projection is keyed by. */
export type ConversationPendingPermissionSource = Readonly<{
  sessionId: string;
  sourceRef: string;
  sourceRevisionOrEpoch: string;
}>;

export type ConversationPendingPermissionProjection = Readonly<{
  requests: readonly ConversationPendingPermissionRequest[];
  /**
   * A durable source-matched request the canonical owner cannot answer for
   * yet. Absence from `requests` is never proof of absence while this is set.
   */
  truncated: boolean;
}>;

/**
 * The sole Channels reader of the canonical pending remote-permission
 * projection.
 *
 * The host answers in bounded keyset pages, so a request behind the first page
 * is reachable only by continuing. Both Channels consumers — chat-approval
 * mediation and permission-wait custody — must see the same complete
 * projection, or a later request becomes permanently unanswerable from chat
 * while its custody is silently suppressed as no longer pending. Continuation
 * lives in the canonical Action, never in a Channels-local cursor row.
 */
export async function readConversationPendingPermissions(input: Readonly<{
  actions: ActionsService;
  source: ConversationPendingPermissionSource;
  signal: AbortSignal;
}>): Promise<ConversationPendingPermissionProjection> {
  const requests: ConversationPendingPermissionRequest[] = [];
  let truncated = false;
  let cursor: string | null = null;
  for (;;) {
    const page: PendingPermissionList = await input.actions.execute(
      'session.permission.remote.pending.list',
      {
        ...input.source,
        ...(cursor === null ? {} : { cursor }),
      },
      { signal: input.signal },
    );
    for (const candidate of page.requests) {
      const request = normalizeConversationPendingPermissionRequest(candidate);
      if (request === null) {
        // An unknown page member cannot be safely treated as absent. Keep the
        // existing custody instead of suppressing an answerable request.
        truncated = true;
        continue;
      }
      requests.push(request);
    }
    truncated = truncated || page.truncated;
    const next = page.nextCursor;
    // The keyset advances strictly past the last projected request, so the end
    // of the projection is the only ordinary exit. A continuation that repeats
    // itself or arrives with no page to continue from is a broken owner
    // response: stop and keep custody rather than looping.
    if (next === null || next === undefined) return { requests, truncated };
    if (next === cursor || page.requests.length === 0) {
      return { requests, truncated: true };
    }
    cursor = next;
  }
}
