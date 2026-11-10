import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { TranscriptListShell } from './TranscriptListShell';
import { resolveConversationTranscriptListShellFrame, resolveMainTranscriptListShellFrame } from './transcriptListShellCapabilities';

let capturedLegendListProps: any = null;
let assignedLegendRef: any = null;
// The mounted list's at-end facts and their listeners (Legend's own state store is the platform boundary).
const legendEndState = { isAtEnd: true, isNearEnd: true, isWithinMaintainScrollAtEndThreshold: true };
const legendEndListeners = new Set<() => void>();

vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@legendapp/list/react-native')>()),
    LegendList: React.forwardRef((props: any, ref: any) => {
        capturedLegendListProps = props;
        const instance = {
            getState: () => ({
                contentLength: 0,
                ...legendEndState,
                scroll: 0,
                scrollLength: 0,
                listen: (_key: string, listener: () => void) => {
                    legendEndListeners.add(listener);
                    return () => legendEndListeners.delete(listener);
                },
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
        Object.assign(legendEndState, { isAtEnd: true, isNearEnd: true, isWithinMaintainScrollAtEndThreshold: true });
        legendEndListeners.clear();
    });

    it('gives a conversation frame the transcript jump-to-bottom once the reader leaves the end', async () => {
        const screen = await renderScreen(
            <TranscriptListShell<{ id: string }>
                data={[{ id: 'row-1' }]}
                dataKey="discussion-test"
                webDomObservation={createWebDomScrollObservation()}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveConversationTranscriptListShellFrame({ platformOS: 'ios' })}
            />,
        );
        expect(screen.findByTestId('transcript-jump-to-bottom')).toBeNull();
        Object.assign(legendEndState, { isAtEnd: false, isNearEnd: false, isWithinMaintainScrollAtEndThreshold: false });
        await act(async () => { for (const listener of [...legendEndListeners]) listener(); });
        expect(screen.findByTestId('transcript-jump-to-bottom')).not.toBeNull();
        await screen.pressByTestIdAsync('transcript-jump-to-bottom');
        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalled();
    });

    it('renders the Legend renderer with frame facts, slots, and overlays', async () => {
        const listRef = { current: null as any };
        const keyExtractor = vi.fn((item: { id: string }) => item.id);
        const renderItem = vi.fn(({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id }));

        const screen = await renderScreen(
            <TranscriptListShell<{ id: string }>
                ref={listRef}
                data={[{ id: 'newest' }, { id: 'oldest' }]}
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
            // Native shell data is newest-first; Legend receives it chronologically.
            data: [{ id: 'oldest' }, { id: 'newest' }],
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

    it('owns the layout commit observer wrapper while preserving the host callback once per commit', async () => {
        const onCommitLayoutEffect = vi.fn();
        let commits = 0;
        const render = (revision: number) => (
            <React.Profiler id="shell" onRender={() => { commits += 1; }}>
                <TranscriptListShell<{ id: string }>
                    data={[{ id: 'row-1' }]}
                    dataKey="session-test"
                    webDomObservation={createWebDomScrollObservation()}
                    extraData={revision}
                    keyExtractor={(item: { id: string }) => item.id}
                    renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                    frame={resolveMainTranscriptListShellFrame({ platformOS: 'ios' })}
                    onCommitLayoutEffect={onCommitLayoutEffect}
                />
            </React.Profiler>
        );

        const screen = await renderScreen(render(1));
        expect(commits).toBeGreaterThan(0);
        expect(onCommitLayoutEffect).toHaveBeenCalledTimes(commits);
        const mountCommits = commits;

        await screen.update(render(2));
        expect(commits).toBeGreaterThan(mountCommits);
        expect(onCommitLayoutEffect).toHaveBeenCalledTimes(commits);
    });
});
