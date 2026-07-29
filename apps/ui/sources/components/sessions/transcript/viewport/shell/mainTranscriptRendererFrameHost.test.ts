import { describe, expect, it } from 'vitest';

import { resolveMainTranscriptRendererFrameHost } from './mainTranscriptRendererFrameHost';

const baseParams = {
    layoutHeight: 600,
    nativeID: 'main-transcript-native-id',
    pinThresholdPx: 72,
    platformOS: 'ios',
    sessionEntryShouldFollowBottom: true,
};

describe('main transcript renderer frame host', () => {
    it('resolves the web main frame with pin-threshold-derived Legend follow ratio', () => {
        const frame = resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            platformOS: 'web',
        });

        expect(frame).toMatchObject({
            dataOrder: 'oldest-first',
            platform: 'web',
            renderer: 'legendList',
            rendererOptions: {
                identity: {
                    nativeID: 'main-transcript-native-id',
                },
                initialPlacement: {
                    atEnd: true,
                },
                continuousFollow: { endThresholdRatio: 72 / 600 },
            },
        });
    });

    it('resolves the native main frame as newest-first Legend', () => {
        const frame = resolveMainTranscriptRendererFrameHost(baseParams);

        expect(frame).toMatchObject({
            dataOrder: 'newest-first',
            platform: 'native',
            renderer: 'legendList',
        });
    });

    it('falls back to the default follow ratio when layout geometry is unknown', () => {
        const frame = resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            layoutHeight: 0,
        });

        expect(frame.rendererOptions.continuousFollow.endThresholdRatio).toBe(0.1);
    });

    it('withholds Legend initial tail placement for a released entry so entry restore consumes the saved anchor first', () => {
        const frame = resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            platformOS: 'web',
            sessionEntryShouldFollowBottom: false,
        });

        expect(frame.rendererOptions.initialPlacement.atEnd).toBe(false);
    });
});
