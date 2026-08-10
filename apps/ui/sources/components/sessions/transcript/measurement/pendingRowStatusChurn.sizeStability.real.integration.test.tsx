// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';

import { buildTranscriptItemHeightSignatureKey } from './transcriptItemHeightCache';
import {
    buildTranscriptRowShellSignature,
    resolveTranscriptRowItemType,
    type TranscriptRowShellItem,
} from './transcriptRowShellSignature';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * F-P2 (2026-08-10) — the pending-queue row's measured size must survive a delivery-status change
 * that paints an identical box, and must NOT survive one that adds an in-flow notice.
 *
 * The list is driven by the REAL installed `@legendapp/list` with the REAL transcript wiring:
 *   keyExtractor      = item.id                                (`useTranscriptItemsPipeline`)
 *   getItemType       = resolveTranscriptRowItemType(...)      (same module under test)
 *   getItemSizeVersion= buildTranscriptItemHeightSignatureKey(buildTranscriptRowShellSignature(...))
 *                                                              (`ChatListInternal`)
 * A mounted row hides the defect — the vendored `validateItemSizeVersion` ends with
 * `scheduleContainerLayout` and the live container writes the size straight back — so the decisive
 * assertion is on an OFFSCREEN row, whose size is genuinely gone and is re-placed from the synthetic
 * `estimatePendingQueueRowPx`. The row component also counts its own mounts through an effect with a
 * cleanup, so a remount stays observable rather than inferred (it never happens: the item key is the
 * literal `'pending-queue'`).
 */

type ResizeObserverRecord = Readonly<{ callback: ResizeObserverCallback; elements: Set<Element> }>;
const resizeObservers = new Set<ResizeObserverRecord>();
const PENDING_ROW_HEIGHT_PX = 88;
const OTHER_ROW_HEIGHT_PX = 100;

type HarnessRow =
    | Readonly<{ id: string; kind: 'filler' }>
    | Readonly<{ id: string; kind: 'pending'; item: TranscriptRowShellItem }>;

function rect(width: number, height: number): DOMRectReadOnly {
    return {
        bottom: height, height, left: 0, right: width, top: 0, width, x: 0, y: 0,
        toJSON: () => ({}),
    } as DOMRectReadOnly;
}

function measuredRect(element: Element): DOMRectReadOnly {
    const htmlElement = element as HTMLElement;
    if (htmlElement.id === 'pending-churn-host') return rect(800, 600);
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') return rect(800, 600);
    const row = htmlElement.querySelector<HTMLElement>('[data-height]');
    if (row) return rect(800, Number(row.dataset.height ?? OTHER_ROW_HEIGHT_PX));
    return rect(800, Number.parseFloat(htmlElement.style.height || '0') || OTHER_ROW_HEIGHT_PX);
}

function flushResizeObservers(): void {
    for (const observer of resizeObservers) {
        const entries = [...observer.elements].map((element) => ({
            borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
            contentRect: measuredRect(element), target: element,
        })) as ResizeObserverEntry[];
        if (entries.length > 0) observer.callback(entries, {} as ResizeObserver);
    }
}

async function flushLegendWork(): Promise<void> {
    for (let pass = 0; pass < 8; pass += 1) {
        await act(async () => {
            flushResizeObservers();
            await vi.runOnlyPendingTimersAsync();
        });
    }
}

function pendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
    return {
        id: 'p1',
        localId: 'l1',
        createdAt: 1_000,
        updatedAt: 1_000,
        source: 'local_outbound',
        text: 'hello',
        rawRecord: { v: 1 },
        ...overrides,
    } as PendingMessage;
}

function pendingItem(message: PendingMessage): TranscriptRowShellItem {
    return { kind: 'pending-queue', id: 'pending-queue', pendingMessages: [message], discardedMessages: [] };
}

function signatureFor(item: TranscriptRowShellItem) {
    return buildTranscriptRowShellSignature({
        activeThinkingMessageId: null,
        expandedToolCallsAnchorMessageIds: new Set<string>(),
        forkMessageMetadataById: null,
        getMessageById: () => null,
        getMessageRevisionById: () => null,
        groupingMode: 'linear',
        item,
        latestCommittedActivityKey: null,
        resolveThinkingExpanded: () => false,
        sessionActive: true,
        widthBucket: 'w:400',
        fontScaleKey: 'fs:1',
    });
}

/** The shapes ONE send walks through, verified against the store writers' published projections. */
const SEND_STATUS_WALK: readonly Readonly<{ name: string; message: PendingMessage }>[] = [
    { name: 'saving', message: pendingMessage() },
    { name: 'send_unconfirmed', message: pendingMessage({ deliveryStatus: 'queued', sendState: 'unconfirmed' }) },
    { name: 'queued (accepted)', message: pendingMessage({ deliveryStatus: 'accepted' }) },
    {
        name: 'delivering',
        message: pendingMessage({ source: 'server_pending', deliveryStatus: 'queued', pendingDeliveryStatus: 'server_delivering' }),
    },
];

/** The row grows a real in-flow `blockedDeliveryNotice` here, so the stale size MUST be dropped. */
const GAINS_IN_FLOW_NOTICE = pendingMessage({
    source: 'server_pending',
    deliveryStatus: 'queued',
    pendingDeliveryStatus: 'blocked',
    pendingDeliveryBlockedReason: 'terminal_composer_draft',
});

const mountCounts = new Map<string, number>();
const unmountCounts = new Map<string, number>();

function HarnessRowView({ row }: Readonly<{ row: HarnessRow }>): React.ReactElement {
    React.useEffect(() => {
        mountCounts.set(row.id, (mountCounts.get(row.id) ?? 0) + 1);
        return () => {
            unmountCounts.set(row.id, (unmountCounts.get(row.id) ?? 0) + 1);
        };
        // Mount identity only: the effect must NOT re-run on prop churn.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const height = row.kind === 'pending' ? PENDING_ROW_HEIGHT_PX : OTHER_ROW_HEIGHT_PX;
    return <div data-height={height} data-testid={`row-${row.id}`} style={{ height }}>{row.id}</div>;
}

describe('pending-queue row size stability under delivery-status churn (real Legend)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        mountCounts.clear();
        unmountCounts.clear();
        // jsdom does not implement `Element.scrollBy`, which Legend's maintain-visible-content-
        // position leg calls. Stubbed so the list can run; the ADJUSTMENT VALUES under jsdom are not
        // a faithful proxy for the native scroll charge and are deliberately not asserted here (that
        // question is device-measured, see the lane report).
        Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
            configurable: true,
            writable: true,
            value: () => {},
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        container = document.createElement('div');
        container.style.height = '600px';
        document.body.appendChild(container);
        root = createRoot(container);

        class TestResizeObserver implements ResizeObserver {
            private readonly record: ResizeObserverRecord;
            constructor(callback: ResizeObserverCallback) {
                this.record = { callback, elements: new Set() };
                resizeObservers.add(this.record);
            }
            disconnect(): void { this.record.elements.clear(); resizeObservers.delete(this.record); }
            observe(target: Element): void { resizeObservers.add(this.record); this.record.elements.add(target); }
            unobserve(target: Element): void { this.record.elements.delete(target); }
        }
        vi.stubGlobal('ResizeObserver', TestResizeObserver);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: HTMLElement) {
            return measuredRect(this);
        });
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
            configurable: true,
            get(this: HTMLElement) { return measuredRect(this).height; },
        });
    });

    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('keeps the row MOUNTED and its size version STABLE across the whole status walk', async () => {
        const listRef = React.createRef<LegendListRef>();
        const filler: HarnessRow[] = Array.from({ length: 4 }, (_v, index) => ({ id: `filler-${index}`, kind: 'filler' as const }));

        const render = (message: PendingMessage) => {
            const data: HarnessRow[] = [
                { id: 'pending-queue', kind: 'pending', item: pendingItem(message) },
                ...filler,
            ];
            return (
                <div id="pending-churn-host" style={{ height: 600 }}>
                    <LegendList
                        data={data}
                        drawDistance={0}
                        estimatedItemSize={OTHER_ROW_HEIGHT_PX}
                        getItemType={(row: HarnessRow) => (
                            row.kind === 'pending'
                                ? resolveTranscriptRowItemType({
                                    activeThinkingMessageId: null,
                                    getMessageById: () => null,
                                    item: row.item,
                                })
                                : 'message:agent'
                        )}
                        getItemSizeVersion={(row: HarnessRow) => (
                            row.kind === 'pending'
                                ? buildTranscriptItemHeightSignatureKey(signatureFor(row.item))
                                : row.id
                        )}
                        keyExtractor={(row: HarnessRow) => row.id}
                        recycleItems={false}
                        ref={listRef}
                        renderItem={({ item }: { item: HarnessRow }) => <HarnessRowView row={item} />}
                    />
                </div>
            );
        };

        await act(async () => { root.render(render(SEND_STATUS_WALK[0]!.message)); });
        await flushLegendWork();

        expect(mountCounts.get('pending-queue')).toBe(1);
        expect(listRef.current?.getState().sizes.get('pending-queue')).toBe(PENDING_ROW_HEIGHT_PX);

        const observedSizeAfterVersionMove: Array<number | undefined> = [];
        const observedVersions: string[] = [
            buildTranscriptItemHeightSignatureKey(signatureFor(pendingItem(SEND_STATUS_WALK[0]!.message))),
        ];

        for (let step = 1; step < SEND_STATUS_WALK.length; step += 1) {
            const message = SEND_STATUS_WALK[step]!.message;
            observedVersions.push(buildTranscriptItemHeightSignatureKey(signatureFor(pendingItem(message))));
            await act(async () => { root.render(render(message)); });
            // Read BEFORE the row's own onLayout re-measures it: the discard is what the virtualizer
            // sees for the frame(s) between the version move and the next layout.
            observedSizeAfterVersionMove.push(listRef.current?.getState().sizes.get('pending-queue'));
            await flushLegendWork();
        }

        // The row is never unmounted and never remounted: the item key is a literal.
        expect(mountCounts.get('pending-queue')).toBe(1);
        expect(unmountCounts.get('pending-queue') ?? 0).toBe(0);
        // and the element is continuously present.
        expect(document.querySelector('[data-testid="row-pending-queue"]')).not.toBeNull();

        // The version holds, so `validateItemSizeVersion` never runs for this row.
        expect(new Set(observedVersions).size).toBe(1);
        // …and the measured size is intact at every step, including the frame right after each
        // re-render, before any re-measure could have repaired it.
        expect(observedSizeAfterVersionMove.every((size) => size === PENDING_ROW_HEIGHT_PX)).toBe(true);
    });

    /**
     * Scrolls the pending row out of the viewport (its container is released, so nothing re-measures
     * it), applies `next`, and reports whether Legend still holds a measured size for it.
     */
    async function sizeAfterOffscreenStep(next: PendingMessage): Promise<Readonly<{
        hasSize: boolean;
        unmountsBefore: number;
        unmountsAfter: number;
    }>> {
        const listRef = React.createRef<LegendListRef>();
        const filler: HarnessRow[] = Array.from({ length: 40 }, (_v, index) => ({ id: `filler-${index}`, kind: 'filler' as const }));

        const render = (message: PendingMessage) => {
            const data: HarnessRow[] = [
                { id: 'pending-queue', kind: 'pending', item: pendingItem(message) },
                ...filler,
            ];
            return (
                <div id="pending-churn-host" style={{ height: 600 }}>
                    <LegendList
                        data={data}
                        drawDistance={0}
                        estimatedItemSize={OTHER_ROW_HEIGHT_PX}
                        getItemSizeVersion={(row: HarnessRow) => (
                            row.kind === 'pending'
                                ? buildTranscriptItemHeightSignatureKey(signatureFor(row.item))
                                : row.id
                        )}
                        keyExtractor={(row: HarnessRow) => row.id}
                        recycleItems={false}
                        ref={listRef}
                        renderItem={({ item }: { item: HarnessRow }) => <HarnessRowView row={item} />}
                    />
                </div>
            );
        };

        await act(async () => { root.render(render(SEND_STATUS_WALK[0]!.message)); });
        await flushLegendWork();
        expect(listRef.current?.getState().sizes.get('pending-queue')).toBe(PENDING_ROW_HEIGHT_PX);

        act(() => { listRef.current?.scrollToIndex({ animated: false, index: 25, viewPosition: 0 }); });
        await flushLegendWork();
        expect(document.querySelector('[data-testid="row-pending-queue"]')).toBeNull();
        const unmountsBefore = unmountCounts.get('pending-queue') ?? 0;

        await act(async () => { root.render(render(next)); });
        await flushLegendWork();

        return {
            hasSize: listRef.current!.getState().sizes.has('pending-queue'),
            unmountsBefore,
            unmountsAfter: unmountCounts.get('pending-queue') ?? 0,
        };
    }

    it('keeps the measured size of an OFFSCREEN pending row across a same-height status step', async () => {
        // `queued (accepted)`: the row paints the same box it painted while `saving`.
        const observed = await sizeAfterOffscreenStep(SEND_STATUS_WALK[2]!.message);

        expect(observed.hasSize).toBe(true);
        // Any unmount here is virtualization (scrolling away), never the status change.
        expect(observed.unmountsAfter).toBe(observed.unmountsBefore);
    });

    it('still drops the measured size of an OFFSCREEN row that gains an in-flow notice', async () => {
        const observed = await sizeAfterOffscreenStep(GAINS_IN_FLOW_NOTICE);

        expect(observed.hasSize).toBe(false);
    });
});
