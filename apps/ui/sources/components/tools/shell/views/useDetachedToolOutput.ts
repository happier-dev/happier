import * as React from 'react';
import type { ToolCall } from '@happier-dev/session-core/messages';

import type { SessionTranscriptSource } from '@/components/sessions/transcript/source/types';
import type { SessionToolOutputRead } from '@/sync/api/session/sessionToolOutput';

const LOADING = { status: 'loading' } as const;
const UNAVAILABLE = { status: 'unavailable' } as const;

export function useDetachedToolOutput(source: SessionTranscriptSource, tool: ToolCall) {
    const { viewerScope } = source.useAuthorship();
    const connection = source.useConnectionState();
    const { loadToolOutput } = source;
    const available = tool.toolOutputAvailability?.status === 'available';
    const messageId = available ? tool.toolOutputMessageId : undefined;
    const toolUseId = tool.sourceToolId ?? tool.id;
    // Retire displayed bytes immediately on disconnect, expiry, or shell replacement.
    const updatedAt = tool.toolOutputUpdatedAt;
    const target = React.useMemo(() => viewerScope && messageId && toolUseId && connection === 'live' && loadToolOutput
        ? { scope: viewerScope, messageId, toolUseId, updatedAt, loadToolOutput }
        : null, [viewerScope, messageId, toolUseId, updatedAt, connection, loadToolOutput]);
    const [settled, setSettled] = React.useState<Readonly<{
        target: NonNullable<typeof target>;
        output: SessionToolOutputRead;
    }> | null>(null);

    React.useEffect(() => {
        setSettled(null);
        if (!target) return;
        const controller = new AbortController();
        const { scope, messageId, toolUseId, loadToolOutput } = target;
        void loadToolOutput({ scope, messageId, toolUseId, signal: controller.signal }).then(output => {
            if (!controller.signal.aborted) setSettled({ target, output });
        }, () => {
            if (!controller.signal.aborted) setSettled({ target, output: UNAVAILABLE });
        });
        return () => controller.abort();
    }, [target]);

    if (!available) return null;
    if (!target) return UNAVAILABLE;
    return settled?.target === target ? settled.output : LOADING;
}
