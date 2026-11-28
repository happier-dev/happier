export * from '@happier-dev/protocol/sessions/actions/sessionActionIds';
import { SESSION_ACTION_MARK_READ_ID, SESSION_ACTION_MARK_UNREAD_ID, SESSION_ACTION_SET_ATTENTION_STANDING_ID, SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID } from '@happier-dev/protocol/sessions/actions/sessionActionIds';

export function resolveManualReadStateFromSessionActionId(actionId: string): 'read' | 'unread' | null {
    if (actionId === SESSION_ACTION_MARK_READ_ID) return 'read';
    if (actionId === SESSION_ACTION_MARK_UNREAD_ID) return 'unread';
    return null;
}

export function resolveAttentionStandingFromSessionActionId(actionId: string): boolean | null {
    if (actionId === SESSION_ACTION_SET_ATTENTION_STANDING_ID) return true;
    if (actionId === SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID) return false;
    return null;
}
