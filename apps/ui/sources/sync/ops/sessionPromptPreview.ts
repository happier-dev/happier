import {
    SessionPromptPreviewV1ResponseSchema,
    type SessionPromptPreviewV1Request,
    type SessionPromptPreviewV1Response,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';

export async function sessionPromptPreview(params: Readonly<{
    sessionId: string;
    serverId: string | null;
}>): Promise<SessionPromptPreviewV1Response> {
    const response = await sessionRpcWithServerScope<unknown, SessionPromptPreviewV1Request>({
        sessionId: params.sessionId,
        serverId: params.serverId,
        method: SESSION_RPC_METHODS.SESSION_PROMPT_PREVIEW_GET_V1,
        payload: {},
    });
    const parsed = SessionPromptPreviewV1ResponseSchema.safeParse(response);
    if (!parsed.success) throw new Error('invalid-session-prompt-preview-response');
    return parsed.data;
}
