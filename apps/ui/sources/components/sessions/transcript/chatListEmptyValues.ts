import type { Message } from '@/sync/domains/messages/messageTypes';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

export const EMPTY_MESSAGES_BY_ID: Readonly<Record<string, Message>> = Object.freeze({});
export const EMPTY_PENDING_USER_ACTION_REQUESTS: readonly PendingPermissionRequest[] = Object.freeze([]);
