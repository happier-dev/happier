import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

import { resolveToolHeaderTextPresentation } from '@/components/tools/shell/presentation/resolveToolHeaderTextPresentation';

export type PermissionPromptModel = Readonly<{
    request: PendingPermissionRequest;
    tool: ToolCall;
    headerText: ReturnType<typeof resolveToolHeaderTextPresentation>;
}>;

export function buildPermissionPromptModel(input: {
    request: PendingPermissionRequest;
    metadata: Metadata | null;
    nowMs: number;
}): PermissionPromptModel {
    const createdAt =
        typeof input.request.createdAt === 'number' && Number.isFinite(input.request.createdAt)
            ? input.request.createdAt
            : input.nowMs;

    const tool: ToolCall = {
        id: `perm:${input.request.id}`,
        name: input.request.tool,
        state: 'running',
        input: input.request.arguments,
        createdAt,
        startedAt: createdAt,
        completedAt: null,
        description: null,
        result: null,
        permission: { id: input.request.id, status: 'pending' },
    };

    const headerText = resolveToolHeaderTextPresentation({ tool, metadata: input.metadata });

    return { request: input.request, tool, headerText };
}
