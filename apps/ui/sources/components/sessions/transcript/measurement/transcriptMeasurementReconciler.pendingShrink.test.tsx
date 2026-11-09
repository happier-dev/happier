import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';

import { renderScreen } from '@/dev/testkit';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { TranscriptRowShell } from '../ChatListRows';
import { estimateTranscriptRowHeightFromCache } from './estimateTranscriptRowHeightFromCache';
import { createTestTranscriptMeasurementReconciler } from './transcriptMeasurementReconciler';
import { buildTranscriptRowShellSignature } from './transcriptRowShellSignature';

const follow = SessionFollowInputV1Schema.parse({
    v: 1, delivery: 'next_turn',
    original: { sourceSessionId: 'worker', sourceTurn: { id: 'turn', status: 'completed' } },
    event: { kind: 'finished' },
});
const notice: PendingMessage = {
    id: 'notice', localId: 'notice-local', createdAt: 1, updatedAt: 1,
    source: 'server_pending', text: 'update', rawRecord: null,
    pendingDeliveryStatus: 'server_queued', pendingHostFollowInput: follow,
};
const ordinary: PendingMessage = {
    id: 'ordinary', localId: 'ordinary-local', createdAt: 2, updatedAt: 2,
    source: 'server_pending', text: 'ordinary input', rawRecord: null,
    pendingDeliveryStatus: 'server_queued',
};

function signatureFor(pendingMessages: PendingMessage[]) {
    return buildTranscriptRowShellSignature({
        item: { kind: 'pending-queue', id: 'pending-queue', pendingMessages, discardedMessages: [] },
        activeThinkingMessageId: null, expandedToolCallsAnchorMessageIds: new Set<string>(),
        forkMessageMetadataById: null, getMessageById: () => null, getMessageRevisionById: () => null,
        groupingMode: 'linear', latestCommittedActivityKey: null, 
        resolveThinkingExpanded: () => false, sessionActive: true,
        widthBucket: 'w:400', fontScaleKey: 'fs:1',
    });
}

describe('pending queue natural shrink measurement', () => {
    it('follows the painted height when a shown row leaves, including the intermediate old viewport layout', async () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const queued = signatureFor([notice, ordinary]);
        const delivering = signatureFor([notice, { ...ordinary, pendingDeliveryStatus: 'server_delivering' }]);
        const drained = signatureFor([notice]);
        expect(delivering).toEqual(queued);
        expect(drained.structuralKey).not.toBe(queued.structuralKey);
        const row = (signature: typeof queued) => (
            <TranscriptRowShell reconciler={reconciler} itemId="pending-queue" signature={signature}>
                {null}
            </TranscriptRowShell>
        );
        const screen = await renderScreen(row(queued));
        const layout = (height: number) => act(async () => {
            screen.findByTestId('transcript-row-content-pending-queue')!.props.onLayout({
                nativeEvent: { layout: { height } },
            });
        });
        const reservedHeight = () => {
            const style = screen.findByTestId('transcript-item-pending-queue')!.props.style as { minHeight?: number } | undefined;
            return style?.minHeight;
        };

        await layout(132);
        await screen.update(row(delivering));
        expect(reservedHeight()).toBe(132);
        await screen.update(row(drained));
        expect(reservedHeight()).toBeUndefined();
        // ScrollView retains its previous measured viewport until onContentSizeChange settles.
        // Both layouts therefore belong to the NEW structural signature.
        await layout(132);
        await layout(64);

        expect.soft(reservedHeight() ?? 64).toBeLessThanOrEqual(64);
        expect.soft(reconciler.resolveReservation(drained)).toEqual({ kind: 'floor', minHeight: 64 });
        expect.soft(estimateTranscriptRowHeightFromCache({ reconciler, signature: drained })).toBe(64);
        await screen.update(<></>);
        await screen.update(row(drained));
        expect(reservedHeight()).toBe(64);
        await layout(64);
        expect(reservedHeight()).toBe(64);
    });
});
