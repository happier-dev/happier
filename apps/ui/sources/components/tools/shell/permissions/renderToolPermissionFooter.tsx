import type { ComponentProps } from 'react';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { shouldShowGenericPermissionPromptForRequest } from '@/utils/sessions/permissions/permissionPromptPolicy';
import { PermissionFooter } from './PermissionFooter';

type ToolPermissionFooterInput = Pick<ComponentProps<typeof PermissionFooter>,
    'toolName' | 'serverId' | 'messageId' | 'metadata' | 'canApprovePermissions' | 'disabledReason'> & Readonly<{
    tool: ToolCall;
    sessionId?: string | null;
    showPrompt: boolean;
}>;

/** The pending prompt may live elsewhere. Its selected catalog follow-up belongs on the tool after approval. */
export function renderToolPermissionFooter({ tool, sessionId, showPrompt, ...props }: ToolPermissionFooterInput) {
    const permission = tool.permission;
    if (!permission || !sessionId) return null;

    const { nativeChoice, nativeChoices } = permission;
    const hasCatalogReceipt = permission.status === 'approved' && permission.mcpTool !== undefined && nativeChoice !== undefined
        && nativeChoices?.requirementId === nativeChoice.requirementId
        && nativeChoices.choices.some(choice => choice.id === nativeChoice.choiceId && choice.followUp !== undefined);
    if (!hasCatalogReceipt && !(showPrompt && shouldShowGenericPermissionPromptForRequest({
        toolName: tool.name, requestKind: permission.kind,
    }))) return null;

    return <PermissionFooter {...props} permission={permission} sessionId={sessionId} toolInput={tool.input} />;
}
