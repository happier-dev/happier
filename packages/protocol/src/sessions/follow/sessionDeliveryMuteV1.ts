import { z } from 'zod/mini';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';

const id = z.string().check(z.minLength(1));
const sessionId = asProtocolZod(SessionIdSchema);

/** A receiver is bound to the current Home; an Account receiver is always the caller. */
export const FollowReceiverRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('account') }),
  z.strictObject({ kind: z.literal('session'), sessionId }),
]));
export type FollowReceiverRefV1 = z.infer<typeof FollowReceiverRefV1Schema>;

/** Source identity is exact. A selector or display name never becomes a mute scope. */
export const ExecutionRunFollowSourceV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('execution_run'), sessionId, runId: id }),
  z.strictObject({ kind: z.literal('execution_run'), machineId: id, runId: id }),
]));
export const FollowSourceRefV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('session'), sessionId }),
  z.strictObject({ kind: z.literal('discussion'), discussionId: id }),
  ExecutionRunFollowSourceV1Schema,
  z.strictObject({ kind: z.literal('workflow_run'), runId: id }),
  z.strictObject({ kind: z.literal('rule'), ruleId: id }),
]));
export type FollowSourceRefV1 = z.infer<typeof FollowSourceRefV1Schema>;

export const FollowDeliveryMuteScopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sender_session'), sessionId }),
  z.strictObject({ kind: z.literal('source'), source: FollowSourceRefV1Schema }),
]));
export type FollowDeliveryMuteScopeV1 = z.infer<typeof FollowDeliveryMuteScopeV1Schema>;

export const FollowDeliveryMuteScopesV1Schema = lazyZodSchema(() => z.array(FollowDeliveryMuteScopeV1Schema));

export const ChangeDeliveryMuteRequestV1Schema = lazyZodSchema(() => z.strictObject({ scope: FollowDeliveryMuteScopeV1Schema }));
export const ChangeDeliveryMuteResponseV1Schema = lazyZodSchema(() => z.strictObject({
  changed: z.boolean(), disposition: z.enum(['muted', 'unmuted']),
}));
export const ListDeliveryMutesResponseV1Schema = lazyZodSchema(() => z.strictObject({ scopes: FollowDeliveryMuteScopesV1Schema }));
export const DeliveryMuteErrorResponseV1Schema = lazyZodSchema(() => z.strictObject({ error: z.enum([
  'invalid_parameters', 'account_inactive', 'session_not_found', 'mute_state_unavailable',
]) }));

export const DELIVERY_MUTE_HTTP_PATHS_V1 = Object.freeze({
  account: '/v2/account/session-delivery-mutes',
  session: '/v2/sessions/:sessionId/delivery-mutes',
});

export function followDeliveryMuteScopeKeyV1(scope: FollowDeliveryMuteScopeV1): string {
  if (scope.kind === 'sender_session') return JSON.stringify(['sender_session', scope.sessionId]);
  const source = scope.source;
  switch (source.kind) {
    case 'session': return JSON.stringify(['source', 'session', source.sessionId]);
    case 'discussion': return JSON.stringify(['source', 'discussion', source.discussionId]);
    case 'execution_run': return JSON.stringify('sessionId' in source
      ? ['source', 'execution_run', source.sessionId, source.runId]
      : ['source', 'execution_run', 'machine', source.machineId, source.runId]);
    case 'workflow_run': return JSON.stringify(['source', 'workflow_run', source.runId]);
    case 'rule': return JSON.stringify(['source', 'rule', source.ruleId]);
  }
}

/** The single read used by direct, Follow and participant delivery admission. */
export function isFollowDeliveryMutedV1(
  scopes: readonly FollowDeliveryMuteScopeV1[],
  candidate: Readonly<{ senderSessionId?: string; source?: FollowSourceRefV1 }>,
): boolean {
  return scopes.some(scope => scope.kind === 'sender_session'
    ? scope.sessionId === candidate.senderSessionId
    : candidate.source !== undefined
      && followDeliveryMuteScopeKeyV1(scope) === followDeliveryMuteScopeKeyV1({ kind: 'source', source: candidate.source }));
}

/** A corrupt persisted preference is unavailable, never silently an empty preference. */
export function readPersistedFollowDeliveryMutesV1(value: string | null): FollowDeliveryMuteScopeV1[] | null {
  if (value === null) return [];
  try {
    const parsed = FollowDeliveryMuteScopesV1Schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
