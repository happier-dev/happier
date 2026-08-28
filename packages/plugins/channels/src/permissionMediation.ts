import type {
  ActionsService,
  PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';

type PendingPermissionList = PluginActionResultById['session.permission.remote.pending.list'];

type CurrentConversationPendingPermissionRequest = PendingPermissionList['requests'][number];

export type ConversationPendingPermissionRequest = CurrentConversationPendingPermissionRequest;

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
    requests.push(...page.requests);
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
