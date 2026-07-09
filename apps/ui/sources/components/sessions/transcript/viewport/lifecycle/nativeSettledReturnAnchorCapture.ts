export type NativeSettledReturnAnchorCaptureViewportState = Readonly<{
    isPinned: true;
    offsetY: 0;
    shouldRestoreViewport: false;
}>;

export type NativeSettledReturnAnchorCaptureEffect = Readonly<{
    sessionId: string;
    type: 'capture-native-settled-return-anchor';
    viewportState: NativeSettledReturnAnchorCaptureViewportState;
}>;

export function resolveNativeSettledReturnAnchorCaptureEffects(params: Readonly<{
    sessionId: string;
}>): readonly NativeSettledReturnAnchorCaptureEffect[] {
    return [{
        sessionId: params.sessionId,
        type: 'capture-native-settled-return-anchor',
        viewportState: {
            isPinned: true,
            offsetY: 0,
            shouldRestoreViewport: false,
        },
    }];
}
