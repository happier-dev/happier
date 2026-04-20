import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { CodexAppServerStreamUpdate } from '@/backends/codex/appServer/streamEventBridge';

import { projectCodexRolloutActions } from '../../rollout/projectCodexRolloutActions';
import { sendCodexProjectedToolEvent } from '../../runtime/sendCodexProjectedToolEvent';

type CodexAppServerToolProjectionContext = Readonly<{
    sidechainId: string | null;
}>;

type ToolProjectionSession = Pick<ApiSessionClient, 'sendAgentMessage' | 'sendCodexMessage'>;

export function createCodexAppServerToolProjector(params: Readonly<{
    session: ToolProjectionSession;
    flushBeforeToolCall: () => Promise<void>;
    observeFileChangeToolCall: (input: unknown) => void;
}>) {
    return {
        async observeStreamUpdate(
            update: CodexAppServerStreamUpdate,
            context: CodexAppServerToolProjectionContext,
        ): Promise<boolean> {
            if (update.type === 'tool-call') {
                if (update.toolKind === 'file-change') {
                    params.observeFileChangeToolCall(update.input);
                }
                for (const projected of projectCodexRolloutActions([{
                    type: 'tool-call',
                    callId: update.callId,
                    name: update.name,
                    input: update.input,
                }], { sidechainId: context.sidechainId })) {
                    if (projected.type !== 'tool-call') continue;
                    await sendCodexProjectedToolEvent({
                        session: params.session,
                        event: projected,
                        flushBeforeToolCall: params.flushBeforeToolCall,
                    });
                }
                return true;
            }

            if (update.type === 'tool-result') {
                for (const projected of projectCodexRolloutActions([{
                    type: 'tool-result',
                    callId: update.callId,
                    output: update.output,
                }], { sidechainId: context.sidechainId })) {
                    if (projected.type !== 'tool-result') continue;
                    await sendCodexProjectedToolEvent({
                        session: params.session,
                        event: projected,
                    });
                }
                return true;
            }

            return false;
        },
    };
}
