/**
 * Identity-stability contract for the extracted prepend host.
 *
 * ChatList currently memoizes the deps object, but the hook owns the callback
 * stability invariant. Fresh deps object identities with unchanged fields must
 * not churn returned host methods.
 */
import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { createTranscriptViewportCommandController } from '@/components/sessions/transcript/viewport/createTranscriptViewportCommandController';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import { useTranscriptPrependHost } from './useTranscriptPrependHost';

type PrependHostDeps = Parameters<typeof useTranscriptPrependHost>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createStableMembers() {
    return {
        commandHostRef: createRef(null),
        lastUserScrollIntentAtMsRef: createRef(Number.NEGATIVE_INFINITY),
        listContentHeightRef: createRef(0),
        listDataRef: createRef<readonly ChatTranscriptListItem[]>([]),
        listLayoutHeightRef: createRef(0),
        listRef: createRef<ScrollableChatListRef | null>(null),
        itemsRef: createRef<readonly ChatTranscriptListItem[]>([]),
        preemptEntryRestoreTransaction: vi.fn(),
        recordRestoreDecisionTelemetry: vi.fn(),
        recordViewportTelemetryEvent: vi.fn(),
        resolveWebScrollMetrics: vi.fn(() => null),
        viewportCommandController: createTranscriptViewportCommandController(),
        wantsPinnedRef: createRef(false),
    };
}

function buildDeps(members: ReturnType<typeof createStableMembers>): PrependHostDeps {
    return {
        ...members,
        currentSessionId: 's1',
        listContentHeight: members.listContentHeightRef.current,
        listDataLength: members.listDataRef.current.length,
        pinThresholdPx: 72,
    } as PrependHostDeps;
}

const neverSettles = new Promise<never>(() => {});

function messageItem(messageId: string): ChatTranscriptListItem {
    return {
        createdAt: 1,
        id: `msg:${messageId}`,
        kind: 'message' as const,
        messageId,
        seq: 1,
    };
}

function PrependCommitHarness(props: Readonly<{
    deps: PrependHostDeps;
    hostRef: { current: ReturnType<typeof useTranscriptPrependHost> | null };
    listContentHeight: number;
    listData: readonly ChatTranscriptListItem[];
    shouldSuspend?: boolean;
}>) {
    const host = useTranscriptPrependHost({
        ...props.deps,
        listContentHeight: props.listContentHeight,
        listDataLength: props.listData.length,
    } as PrependHostDeps);
    useCommittedTranscriptRef(props.deps.listContentHeightRef, props.listContentHeight);
    useCommittedTranscriptRef(props.deps.listDataRef, props.listData);
    React.useLayoutEffect(() => {
        props.hostRef.current = host;
    }, [host, props.hostRef]);
    if (props.shouldSuspend === true) throw neverSettles;
    return null;
}

describe('useTranscriptPrependHost identity stability', () => {
    it('keeps host callbacks referentially stable across fresh deps object identities', async () => {
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: PrependHostDeps) => useTranscriptPrependHost(deps),
            { initialProps: buildDeps(members) },
        );

        const first = hook.getCurrent();

        await hook.rerender(buildDeps(members));
        await hook.rerender(buildDeps(members));

        const second = hook.getCurrent();
        expect(second.applyNativeEffects).toBe(first.applyNativeEffects);
        expect(second).not.toHaveProperty('applyWebEffects');
        expect(second).not.toHaveProperty('runWebIndexRecovery');
        expect(second).not.toHaveProperty('slots');

        await hook.unmount();
    });

    it('observes a committed same-height list-length change after ignoring an abandoned render', async () => {
        const members = createStableMembers();
        const listA = [messageItem('m3'), messageItem('m4'), messageItem('m5')];
        const listB = [messageItem('m1'), messageItem('m2'), ...listA];
        members.listContentHeightRef.current = 1_500;
        members.listDataRef.current = listA;
        members.listLayoutHeightRef.current = 300;
        members.listRef.current = {
            computeVisibleIndices: () => ({
                startIndex: 0,
                endIndex: members.listDataRef.current.length - 1,
            }),
            getAbsoluteLastScrollOffset: () => (
                members.listDataRef.current.length === listA.length ? 0 : 820
            ),
            getLayout: (index: number) => {
                const item = members.listDataRef.current[index];
                const y = item?.id === 'msg:m3'
                    ? (members.listDataRef.current.length === listA.length ? 80 : 900)
                    : index * 450;
                return { x: 0, y, width: 600, height: 100 };
            },
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        const deps = buildDeps(members);
        const hostRef = { current: null as ReturnType<typeof useTranscriptPrependHost> | null };
        const renderHarness = (listData: readonly ChatTranscriptListItem[], shouldSuspend = false) => (
            <React.Suspense fallback={null}>
                <PrependCommitHarness
                    deps={deps}
                    hostRef={hostRef}
                    listContentHeight={1_500}
                    listData={listData}
                    shouldSuspend={shouldSuspend}
                />
            </React.Suspense>
        );

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                renderHarness(listA),
                { unstable_isConcurrent: true } as unknown as renderer.TestRendererOptions,
            );
        });
        await act(async () => {
            expect(hostRef.current?.beginNativeTransaction()).toBe(true);
            hostRef.current?.armNativeCommit(750);
        });
        members.recordViewportTelemetryEvent.mockClear();

        await act(async () => {
            React.startTransition(() => {
                tree.update(renderHarness(listB, true));
            });
            await Promise.resolve();
        });

        expect(members.listDataRef.current).toBe(listA);
        expect(members.recordViewportTelemetryEvent).not.toHaveBeenCalled();

        await act(async () => {
            tree.update(renderHarness(listB));
        });

        expect(members.listDataRef.current).toBe(listB);
        expect(members.recordViewportTelemetryEvent).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                reason: 'mvcp-preserved',
                type: 'restore-decision',
            }),
            { sessionId: 's1' },
        );
        await act(async () => {
            tree.unmount();
        });
    });
});
