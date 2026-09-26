/**
 * Row-local collapse contract: a collapsible INSIDE a row (tool-row inline details, thinking body)
 * changes the row's painted height without changing its height signature, so the row shell must
 * never keep reserving (`minHeight`) the taller open height once that body is closed.
 */
import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { TranscriptRowShell } from './ChatListRows';
import { createTestTranscriptItemHeightCache } from './measurement/transcriptItemHeightCache';
import { createTestTranscriptMeasurementReconciler } from './measurement/transcriptMeasurementReconciler';
import {
    useTranscriptRowLayoutMutation,
    type TranscriptRowLayoutMutationHandler,
} from './measurement/TranscriptRowLayoutMutationContext';

const SIGNATURE = {
    itemId: 'grp#tool:t1',
    kind: 'tool-group-tool',
    structuralKey: 'tool-t1-rev1',
    widthBucket: 'w800',
    fontScaleKey: 'f1',
    groupingMode: 'turns',
    forkContextKey: 'none',
    expansionKey: 'tools:none|thinking:none',
    rowState: 'stable',
} as const;

function setup() {
    const reconciler = createTestTranscriptMeasurementReconciler({ cache: createTestTranscriptItemHeightCache() });
    const notifyRef: { current: TranscriptRowLayoutMutationHandler | null } = { current: null };
    function RowLocalBody() {
        notifyRef.current = useTranscriptRowLayoutMutation();
        return null;
    }
    const row = (renderTick: number) => (
        <TranscriptRowShell reconciler={reconciler} itemId={SIGNATURE.itemId} signature={SIGNATURE}>
            <RowLocalBody key="body" />
            {renderTick}
        </TranscriptRowShell>
    );
    return {
        row,
        notify: (reason: 'expand' | 'collapse') => act(async () => notifyRef.current?.({ reason, sourceId: 'tool-body' })),
    };
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function shell(screen: Screen) {
    const node = screen.findByTestId(`transcript-item-${SIGNATURE.itemId}`);
    if (!node) throw new Error('row shell not rendered');
    return node;
}

const layout = (screen: Screen, height: number) => act(async () => {
    (shell(screen).props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { height } } });
});

const reservedMinHeight = (screen: Screen) => (shell(screen).props.style as { minHeight?: number } | undefined)?.minHeight;

describe('TranscriptRowShell row-local collapse', () => {
    it('stops reserving the open height once a body that mounted open collapses', async () => {
        const { row, notify } = setup();
        const screen = await renderScreen(row(0));
        await layout(screen, 400);
        // Any unrelated list re-render re-evaluates the reservation while the body is still open.
        await act(async () => screen.update(row(1)));
        expect(reservedMinHeight(screen)).toBe(400);

        await notify('collapse');

        expect(reservedMinHeight(screen)).toBeUndefined();
    });

    it('does not reserve an opened body height for the row after it remounts collapsed', async () => {
        const { row, notify } = setup();
        const screen = await renderScreen(row(0));
        await layout(screen, 40);
        await notify('expand');
        await layout(screen, 400);

        // Virtualization unmounts the row while open; its local expansion state is lost.
        await act(async () => screen.update(<></>));
        await act(async () => screen.update(row(2)));

        expect(reservedMinHeight(screen)).toBe(40);
    });
});
