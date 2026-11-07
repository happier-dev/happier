import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { FriendsMutationInputSchema, FriendsMutationResponseSchema } from '../../social/friends.js';
import { homeDomainActionRow, homeDomainApprovalField, type HomeDomainActionRow } from './homeDomainRow.js';

type FriendsActionId = 'friends.add' | 'friends.remove';
type FriendsActionSpec = {
  [Id in FriendsActionId]: HomeDomainActionRow<Id, typeof FriendsMutationInputSchema, typeof FriendsMutationResponseSchema>
    & Readonly<{ bindings: { mcpToolName: Id extends 'friends.add' ? 'friends_add' : 'friends_remove' } }>;
}[FriendsActionId];

/** Relationship changes remain decided by the existing authenticated Home writers. */
export const FRIENDS_ACTION_SPECS: readonly FriendsActionSpec[] = lazyActionSpecArray(() => Object.freeze([
  {
    ...homeDomainActionRow({
      id: 'friends.add', approval: { result: 'required', flow: 'deferred' },
      title: 'Request or accept friendship',
      description: 'Send a friend request or accept an incoming request on this Home.',
      safety: 'danger', sideEffectClass: 'write', approvalPolicy: { uiConfirmation: 'direct' },
      cliPath: ['friends', 'add'], mcp: true, path: '/v1/friends/add',
      inputSchema: FriendsMutationInputSchema, outputSchema: FriendsMutationResponseSchema,
      inputHints: { fields: [homeDomainApprovalField('uid', 'Account id', { required: true })] },
    }),
    bindings: { mcpToolName: 'friends_add' },
  },
  {
    ...homeDomainActionRow({
      id: 'friends.remove', approval: { result: 'required', flow: 'deferred' },
      title: 'Remove or decline friendship',
      description: 'Remove a friend, decline an incoming request or cancel your outgoing request on this Home.',
      safety: 'danger', sideEffectClass: 'write', cliPath: ['friends', 'remove'], mcp: true,
      path: '/v1/friends/remove', inputSchema: FriendsMutationInputSchema,
      outputSchema: FriendsMutationResponseSchema,
      inputHints: { fields: [homeDomainApprovalField('uid', 'Account id', { required: true })] },
    }),
    bindings: { mcpToolName: 'friends_remove' },
  },
]));
