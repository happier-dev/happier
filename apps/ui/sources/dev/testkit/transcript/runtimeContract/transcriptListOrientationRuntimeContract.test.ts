import { describe, expect, it } from 'vitest';

import {
    createTranscriptListOrientationRuntimeModel,
    type TranscriptListRuntimePlatform,
} from './transcriptListOrientationRuntimeModel';

describe('transcript list orientation runtime contract', () => {
    it('resolves native to inverted FlashList', () => {
        const model = createTranscriptListOrientationRuntimeModel({
            items: ['oldest', 'middle', 'newest'],
            platform: 'native',
        });

        expect(model.presentation).toEqual({
            orientation: 'inverted',
        });
    });

    it('resolves web to standard FlashList', () => {
        const model = createTranscriptListOrientationRuntimeModel({
            items: ['oldest', 'newest'],
            platform: 'web',
        });

        expect(model.presentation).toEqual({
            orientation: 'standard',
        });
    });

    it('keeps standard runtime item order by source-array reference', () => {
        const items = [{ id: 'oldest' }, { id: 'middle' }, { id: 'newest' }] as const;

        for (const platform of ['web'] satisfies readonly TranscriptListRuntimePlatform[]) {
            const model = createTranscriptListOrientationRuntimeModel({
                items,
                platform,
            });

            expect(model.renderedItems).toBe(items);
            expect(model.renderedItems).toEqual([
                { id: 'oldest' },
                { id: 'middle' },
                { id: 'newest' },
            ]);
        }
    });

    it('renders inverted runtime items newest-first without mutating the source array', () => {
        const items = [{ id: 'oldest' }, { id: 'middle' }, { id: 'newest' }];

        const model = createTranscriptListOrientationRuntimeModel({
            items,
            platform: 'native',
        });

        expect(model.renderedItems).not.toBe(items);
        expect(model.renderedItems).toEqual([
            { id: 'newest' },
            { id: 'middle' },
            { id: 'oldest' },
        ]);
        expect(items).toEqual([
            { id: 'oldest' },
            { id: 'middle' },
            { id: 'newest' },
        ]);
    });

    it('round-trips source and rendered indexes for every runtime orientation', () => {
        const cases: ReadonlyArray<{
            platform: TranscriptListRuntimePlatform;
        }> = [
            { platform: 'web' },
            { platform: 'native' },
        ];

        for (const runtimeCase of cases) {
            const model = createTranscriptListOrientationRuntimeModel({
                items: ['oldest', 'older', 'newer', 'newest'],
                platform: runtimeCase.platform,
            });

            for (let sourceIndex = 0; sourceIndex < model.sourceItemCount; sourceIndex += 1) {
                const renderedIndex = model.mapSourceIndexToRenderedIndex(sourceIndex);

                expect(renderedIndex).not.toBeNull();
                expect(model.mapRenderedIndexToSourceIndex(renderedIndex as number)).toBe(sourceIndex);
            }
        }
    });

    it('uses raw offset 0 for inverted runtime bottom scroll commands', () => {
        const model = createTranscriptListOrientationRuntimeModel({
            items: ['oldest', 'newest'],
            platform: 'native',
        });

        expect(model.resolveBottomRawScrollCommandOffset({
            contentHeight: 1000,
            layoutHeight: 300,
        })).toBe(0);
    });
});
