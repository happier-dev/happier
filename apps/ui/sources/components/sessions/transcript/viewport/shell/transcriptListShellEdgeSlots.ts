import type { TranscriptListShellFrame } from './transcriptListShellCapabilities';

export function resolveTranscriptListShellEdgeSlots<T>(params: Readonly<{
    frame: TranscriptListShellFrame;
    visualTopNode: T;
    visualBottomNode: T;
}>): Readonly<{ listHeaderNode: T; listFooterNode: T }> {
    if (params.frame.dataOrder === 'newest-first') {
        return {
            listHeaderNode: params.visualBottomNode,
            listFooterNode: params.visualTopNode,
        };
    }
    return {
        listHeaderNode: params.visualTopNode,
        listFooterNode: params.visualBottomNode,
    };
}
