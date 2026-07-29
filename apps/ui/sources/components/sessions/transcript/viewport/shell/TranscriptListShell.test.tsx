import { readFileSync } from 'node:fs';

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';

let capturedLegendListProps: any = null;
let assignedLegendRef: any = null;

const SIDECHAIN_JUMP_TO_MESSAGE = readFileSync(new URL('./sidechainJumpToMessage.ts', import.meta.url), 'utf8');

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: React.forwardRef((props: any, ref: any) => {
        capturedLegendListProps = props;
        const instance = {
            getState: () => ({
                contentLength: 0,
                isAtEnd: true,
                isNearEnd: true,
                isWithinMaintainScrollAtEndThreshold: true,
                scroll: 0,
                scrollLength: 0,
            }),
            scrollToEnd: vi.fn(() => Promise.resolve()),
            scrollToIndex: vi.fn(() => Promise.resolve()),
            scrollToOffset: vi.fn(() => Promise.resolve()),
        };
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;
        assignedLegendRef = instance;
        return React.createElement(
            'LegendList',
            props,
            props.ListHeaderComponent ?? null,
            props.ListFooterComponent ?? null,
        );
    }),
}));

describe('TranscriptListShell', () => {
    beforeEach(() => {
        capturedLegendListProps = null;
        assignedLegendRef = null;
    });

    it('renders the Legend renderer with frame facts, slots, and overlays', async () => {
        const { TranscriptListShell } = await import('./TranscriptListShell');
        const { resolveMainTranscriptListShellFrame } = await import('./transcriptListShellCapabilities');
        const listRef = { current: null as any };
        const keyExtractor = vi.fn((item: { id: string }) => item.id);
        const renderItem = vi.fn(({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id }));

        const screen = await renderScreen(
            <TranscriptListShell<{ id: string }>
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                webDomObservation={createWebDomScrollObservation()}
                extraData={5}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'ChatList.s1.r1',
                    platformOS: 'ios',
                })}
                header={React.createElement('HeaderSlot')}
                footer={React.createElement('FooterSlot')}
                olderLoadOverlay={React.createElement('OlderOverlay')}
                catchUpOverlay={React.createElement('CatchUpOverlay')}
            />,
        );

        expect(assignedLegendRef).toBeTruthy();
        expect(listRef.current).toBeTruthy();
        expect(capturedLegendListProps).toMatchObject({
            data: [{ id: 'row-1' }],
            extraData: 5,
            initialScrollAtEnd: true,
            keyboardDismissMode: 'none',
            keyboardShouldPersistTaps: 'handled',
            scrollEventThrottle: 16,
        });
        expect(screen.findByType('HeaderSlot' as any)).toBeTruthy();
        expect(screen.findByType('FooterSlot' as any)).toBeTruthy();
        expect(screen.findByType('OlderOverlay' as any)).toBeTruthy();
        expect(screen.findByType('CatchUpOverlay' as any)).toBeTruthy();
    });

    it('owns the layout commit observer wrapper while preserving the host callback', async () => {
        const { TranscriptListShell } = await import('./TranscriptListShell');
        const { resolveMainTranscriptListShellFrame } = await import('./transcriptListShellCapabilities');
        const onCommitLayoutEffect = vi.fn();

        await renderScreen(
            <TranscriptListShell<{ id: string }>
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                webDomObservation={createWebDomScrollObservation()}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({ platformOS: 'ios' })}
                onCommitLayoutEffect={onCommitLayoutEffect}
            />,
        );

        expect(onCommitLayoutEffect).toHaveBeenCalled();
    });

    it('keeps sidechain shell helpers out of raw list command execution', () => {
        expect(SIDECHAIN_JUMP_TO_MESSAGE).not.toMatch(/\.scrollTo(?:Index|Offset)\s*\(/);
        expect(SIDECHAIN_JUMP_TO_MESSAGE).not.toMatch(/scrollTo(?:Index|Offset)\?:/);
    });
});
