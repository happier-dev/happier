// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createWebListDomHarness } from '@/dev/testkit/legend/webListDomHarness';

import { VirtualizedList } from '../VirtualizedList';
import type { VirtualizedListRef } from '../virtualizedListTypes';

// Exercise the real Legend DOM runtime; only React Native's platform boundary changes.
vi.mock('react-native', async () => vi.importActual('react-native-web'));

type Row = Readonly<{ id: string }>;

describe('VirtualizedList web content-size lifecycle', () => {
    const harness = createWebListDomHarness({ rowSelector: '[data-row]', rowHeight: 56 });

    it('resumes content-size publication after Suspense disconnects and reconnects the list ref', async () => {
        const ref = React.createRef<VirtualizedListRef>();
        const sizes: number[] = [];
        const onContentSizeChange = (_width: number, height: number) => { sizes.push(height); };
        const pending = new Promise<void>(() => {});

        function Gate({ suspended }: Readonly<{ suspended: boolean }>) {
            if (suspended) throw pending;
            return null;
        }

        const frame = (suspended: boolean, rows: readonly Row[], paddingTop = 0) => (
            <React.Suspense fallback={<div>Loading</div>}>
                <div id="virtualized-list-host">
                    <VirtualizedList
                        ref={ref}
                        data={rows}
                        keyExtractor={row => row.id}
                        estimatedItemSize={56}
                        contentContainerStyle={{ paddingTop }}
                        recycleItems={false}
                        onContentSizeChange={onContentSizeChange}
                        renderItem={({ item }) => <div data-row>{item.id}</div>}
                    />
                    <Gate suspended={suspended} />
                </div>
            </React.Suspense>
        );
        const before = [{ id: 'before' }];

        await act(async () => harness.root.render(frame(false, before, 16)));
        await harness.flush();
        expect(ref.current?.getScrollableNode?.()).toBeInstanceOf(HTMLElement);
        const initialSize = sizes.at(-1);
        expect(initialSize).toBeGreaterThan(0);

        // Legend defers the final extent adjustment after top padding shrinks.
        // Let Suspense detach the scroller before that real publication settles.
        await act(async () => harness.root.render(frame(false, before)));
        await act(async () => harness.root.render(frame(true, before)));
        expect(ref.current).toBeNull();
        const publicationsBeforeHiddenMeasurement = sizes.length;
        await harness.flush();
        expect(sizes).toHaveLength(publicationsBeforeHiddenMeasurement);

        await act(async () => harness.root.render(frame(false, [...before, { id: 'after' }])));
        await harness.flush();

        expect(harness.container.textContent).toContain('after');
        expect(ref.current?.getScrollableNode?.()).toBeInstanceOf(HTMLElement);
        expect(sizes.at(-1)).toBeGreaterThan(initialSize!);
    });
});
