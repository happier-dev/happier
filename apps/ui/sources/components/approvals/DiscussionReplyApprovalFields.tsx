import * as React from 'react';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { DiscussionReplyInputV1Schema } from '@happier-dev/protocol/discussions';
import { CONVERSATION_CORE_PLUGIN_ID_V1, DISCUSSION_REPLY_DESTINATION_ACTION_ID_V1,
    DiscussionReplyDestinationResultV1Schema, type DiscussionReplyDestinationResultV1 } from '@happier-dev/channels-protocol/v1';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { describeApprovalActionFields, type ApprovalActionFieldsPresentation } from './approvalFieldValues';
import { t } from '@/text';

/** Every approval anatomy reads destination through Channels' Account-owned reply projection. */
export function DiscussionReplyApprovalFields(props: Readonly<{
    request: ApprovalRequest;
    serverId: string | null;
    children: (presentation: ApprovalActionFieldsPresentation) => React.ReactNode;
}>) {
    const parsed = React.useMemo(() => DiscussionReplyInputV1Schema.safeParse(props.request.actionArgs), [props.request.actionArgs]);
    const discussionId = parsed.success ? parsed.data.discussionId : null;
    const messageId = parsed.success && parsed.data.replyTarget.kind === 'message' ? parsed.data.replyTarget.messageId : null;
    const { binding } = useServerCredentialAccountScopeBinding(messageId ? props.serverId : null);
    const [reading, setReading] = React.useState<Readonly<{ binding: typeof binding; discussionId: string; messageId: string;
        destination: DiscussionReplyDestinationResultV1 | null }> | null>(null);
    React.useEffect(() => {
        if (!binding || !discussionId || !messageId) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => abort.abort());
        void (async () => {
            try {
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                const result = await createDefaultActionExecutor().execute('action.invoke', {
                    action: { pluginId: CONVERSATION_CORE_PLUGIN_ID_V1, localId: DISCUSSION_REPLY_DESTINATION_ACTION_ID_V1 },
                    input: { discussionId, messageId },
                }, { surface: 'ui', serverId: binding.scope.serverId, expectedAccountId: binding.scope.accountId, signal: abort.signal });
                const destination = result.ok ? DiscussionReplyDestinationResultV1Schema.safeParse(result.result) : null;
                if (!abort.signal.aborted && binding.isCurrent()) setReading({ binding, discussionId, messageId,
                    destination: destination?.success ? destination.data : null });
            } catch {
                // An unavailable display read neither changes executable operands nor borrows an opaque id as a name.
                if (!abort.signal.aborted && binding.isCurrent()) setReading({ binding, discussionId, messageId, destination: null });
            }
        })();
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, discussionId, messageId]);
    const current = reading?.binding === binding && reading.discussionId === discussionId && reading.messageId === messageId
        ? reading : null;
    const destination = current?.destination;
    const missingName = t('common.unavailable');
    const presentation = React.useMemo(() => describeApprovalActionFields({ ...props.request,
        context: destination?.kind !== 'none' && discussionId && messageId ? { discussionReplyDestination: {
            discussionId, messageId, connectionName: destination?.connectionName ?? missingName,
            conversationName: destination?.conversationName ?? missingName,
        } } : undefined }), [destination, discussionId, messageId, missingName, props.request]);
    return props.children(presentation);
}
