import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import {
    resolveMainTranscriptListShellFrame,
    resolveReadOnlyTranscriptListShellFrame,
    resolveSidechainTranscriptListShellFrame,
} from './transcriptListShellCapabilities';
import type { TranscriptListShellRef } from './renderer/types';

type TestRow = Readonly<{ id: string }>;

let capturedLegendListProps: Record<string, unknown> | null = null;
let assignedLegendListRef: unknown = null;

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: React.forwardRef((props: Record<string, unknown>, ref) => {
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
        assignedLegendListRef = instance;
        return React.createElement('LegendList', props);
    }),
}));

describe('transcript list shell frame contracts', () => {
    it('resolves main web and native frame facts explicitly', () => {
        const web = resolveMainTranscriptListShellFrame({
            nativeID: 'transcript-web',
            platformOS: 'web',
        });
        const native = resolveMainTranscriptListShellFrame({
            nativeID: 'transcript-native',
            platformOS: 'ios',
        });

        expect(web).toMatchObject({
            capability: { kind: 'main', streamingFollow: { kind: 'main' } },
            dataOrder: 'oldest-first',
            platform: 'web',
            renderer: 'legendList',
            rendererOptions: {
                continuousFollow: { endThresholdRatio: 0.1 },
                identity: { nativeID: 'transcript-web', testID: 'transcript-chat-list' },
                initialPlacement: { atEnd: true },
                interaction: { scrollEventThrottle: 32 },
            },
        });
        expect(native).toMatchObject({
            capability: { kind: 'main', streamingFollow: { kind: 'main' } },
            dataOrder: 'newest-first',
            platform: 'native',
            renderer: 'legendList',
            rendererOptions: {
                continuousFollow: { endThresholdRatio: 0.1 },
                identity: { nativeID: 'transcript-native', testID: 'transcript-chat-list' },
                initialPlacement: { atEnd: true },
                interaction: { scrollEventThrottle: 16 },
            },
        });
    });

    it('resolves read-only and sidechain capability contracts without main-only identity', () => {
        const readOnly = resolveReadOnlyTranscriptListShellFrame({
            accessKind: 'public',
            bottomNoticeVisible: true,
            platformOS: 'web',
        });
        const sidechain = resolveSidechainTranscriptListShellFrame({ platformOS: 'ios' });

        expect(readOnly.capability).toMatchObject({
            boundedHydration: { kind: 'readOnly' },
            canApprovePermissions: false,
            canSendMessages: false,
            kind: 'readOnly',
        });
        expect(readOnly.rendererOptions.identity.nativeID).toBeUndefined();
        expect(sidechain.capability).toMatchObject({
            boundedHydration: { kind: 'sidechain' },
            initialBottomPin: true,
            kind: 'sidechain',
            olderPagination: true,
        });
        expect(sidechain.rendererOptions.identity.nativeID).toBeUndefined();
    });

    it('resolves Legend as the only transcript renderer', async () => {
        const { resolveTranscriptListRenderer } = await import('./renderer/resolveTranscriptListRenderer');
        expect(resolveTranscriptListRenderer().kind).toBe('legendList');
    });
});

describe('TranscriptListShell executable renderer contracts', () => {
    beforeEach(() => {
        capturedLegendListProps = null;
        assignedLegendListRef = null;
    });

    it('adapts native newest-first shell data into chronological Legend data and standard commands', async () => {
        const { TranscriptListShell } = await import('./TranscriptListShell');
        const listRef = React.createRef<TranscriptListShellRef<TestRow>>();

        await renderScreen(
            <TranscriptListShell<TestRow>
                ref={listRef}
                data={[{ id: 'newest' }, { id: 'oldest' }]}
                dataKey="session-test"
                webDomObservation={createWebDomScrollObservation()}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'transcript-native',
                    platformOS: 'ios',
                })}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => React.createElement('Row', item)}
            />,
        );

        expect(capturedLegendListProps).toMatchObject({
            data: [{ id: 'oldest' }, { id: 'newest' }],
            initialScrollAtEnd: true,
            scrollEventThrottle: 16,
        });
        expect(assignedLegendListRef).toBeTruthy();
    });
});
