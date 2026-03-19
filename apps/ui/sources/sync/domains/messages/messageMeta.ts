import type { MessageMeta } from './messageMetaTypes';
import { parsePermissionIntentAlias } from '@happier-dev/agents';

export function buildOutgoingMessageMeta(params: {
    sentFrom: string;
    permissionMode: NonNullable<MessageMeta['permissionMode']>;
    model?: MessageMeta['model'];
    fallbackModel?: MessageMeta['fallbackModel'];
    appendSystemPrompt?: string;
    displayText?: string;
}): MessageMeta {
    const permissionModeToken = typeof params.permissionMode === 'string' ? params.permissionMode : '';
    const canonicalPermissionMode = parsePermissionIntentAlias(permissionModeToken) ?? 'default';
    const appendSystemPrompt =
        typeof params.appendSystemPrompt === 'string' && params.appendSystemPrompt.trim().length > 0
            ? params.appendSystemPrompt
            : undefined;
    return {
        source: 'ui',
        sentFrom: params.sentFrom,
        permissionMode: canonicalPermissionMode,
        ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
        ...(params.displayText !== undefined ? { displayText: params.displayText } : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.fallbackModel !== undefined ? { fallbackModel: params.fallbackModel } : {}),
    };
}
