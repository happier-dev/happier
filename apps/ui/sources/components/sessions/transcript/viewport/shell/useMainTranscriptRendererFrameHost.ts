import * as React from 'react';
import {
    resolveMainTranscriptRendererFrameHost,
} from '@/components/sessions/transcript/viewport/shell/mainTranscriptRendererFrameHost';

export function useMainTranscriptRendererFrameHost(params: Readonly<{
    chatListNativeId: string;
    layoutHeight: number;
    pinThresholdPx: number;
    platformOS: string;
    sessionEntryShouldFollowBottom: boolean;
}>) {
    const {
        chatListNativeId,
        layoutHeight,
        pinThresholdPx,
        platformOS,
        sessionEntryShouldFollowBottom,
    } = params;
    return React.useMemo(() => resolveMainTranscriptRendererFrameHost({
        layoutHeight,
        nativeID: chatListNativeId,
        pinThresholdPx,
        platformOS,
        sessionEntryShouldFollowBottom,
    }), [
        chatListNativeId,
        layoutHeight,
        pinThresholdPx,
        platformOS,
        sessionEntryShouldFollowBottom,
    ]);
}
