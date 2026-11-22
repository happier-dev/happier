/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

installPopoverCommonModuleMocks({
    reactNative: async () => ({
        ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    }),
});

const { UsageFilterBar } = await import('./UsageFilterBar');
const { Popover } = await import('@/components/ui/popover');
const { SelectionListFilterChip } = await import('@/components/ui/selectionList/SelectionListFilterChips');

const pressKey = (target: HTMLElement, key: string, shiftKey = false) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
};

async function mount(element: React.ReactElement, exercise: () => Promise<void>) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(element));
        await exercise();
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
}

function control(id: string) {
    const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    expect(element).not.toBeNull();
    return element!;
}

async function withOpenFilters(exercise: (trigger: HTMLElement) => Promise<void>) {
    let bar!: ReactTestRenderer;
    await act(async () => { bar = create(<UsageFilterBar
        period="7days"
        costBasis="auto"
        coverageIncomplete={false}
        scopeFilters={[
            { field: 'sources', title: 'Sources', selected: [], options: [{ id: 'runtime', label: 'Happier sessions' }], select: () => true },
            { field: 'agents', title: 'Agents', selected: [], options: [{ id: 'claude', label: 'Claude' }], select: () => true },
        ]}
        costBasisOptions={['auto']}
        costBasisPending={false}
        onPeriodChange={async () => true}
        onCostBasisChange={async () => true}
        metricOptions={[]}
        metric="tokens"
        onMetricChange={null}
        testID="filters"
    />); });
    const filter: React.ComponentProps<typeof SelectionListFilterChip>['filter'] =
        bar.root.findAll(node => node.props.filter?.id === 'scope')[0]?.props.filter;
    await act(async () => bar.unmount());

    function Harness() {
        const [open, setOpen] = React.useState(false);
        const triggerRef = React.useRef<HTMLButtonElement>(null);
        return <>
            <button ref={triggerRef} data-testid="filters.scope" onClick={() => setOpen(true)}>Filters</button>
            <Popover open={open} phonePresentation="sheet" accessibilityLabel={filter.label} focusReturnRef={triggerRef} onRequestClose={() => setOpen(false)}>
                {({ maxHeight, requestClose }) => filter.renderPopoverContent?.({
                    maxHeight,
                    close: () => requestClose('dismiss'),
                })}
            </Popover>
        </>;
    }
    await mount(<Harness />, async () => {
        const trigger = control('filters.scope');
        await act(async () => { trigger.focus(); trigger.click(); });
        await exercise(trigger);
    });
}

describe('phone Usage Filters keyboard focus', () => {
    beforeEach(() => {
        vi.stubGlobal('matchMedia', (media: string) => ({
            media,
            matches: media === '(pointer: fine)' || media === '(prefers-reduced-motion: reduce)',
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        }));
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it('wraps forward from Search to Close on the root and pushed steps', async () => {
        await withOpenFilters(async () => {
            const wrapFromSearch = async () => {
                const search = control('filters.scope.list:header:input');
                search.focus();
                await act(async () => { pressKey(search, 'Tab'); });
                expect(document.activeElement).toBe(control('popover-sheet.close'));
            };
            await wrapFromSearch();
            await act(async () => { control('filters.scope:open:agents').click(); });
            await wrapFromSearch();
        });
    });

    it('shows the Back hint on a fine pointer and restores the opening row with Shift+Tab', async () => {
        await withOpenFilters(async () => {
            const openingRow = () => control('filters.scope:open:agents');
            await act(async () => { openingRow().click(); });
            const backHint = document.querySelector('[data-testid="filters.scope.list:footer:hint:back"]');
            expect.soft(backHint?.textContent ?? '').toContain('⇧⇥');
            const search = control('filters.scope.list:header:input');
            search.focus();
            await act(async () => { pressKey(search, 'Tab', true); });
            expect(document.activeElement).toBe(document.querySelector('[data-testid="filters.scope:open:agents"]'));
        });
    });

    it('returns to the scope row after Back and to Filters after Escape or Close', async () => {
        await withOpenFilters(async trigger => {
            const openingRow = () => control('filters.scope:open:agents');
            await act(async () => {
                const row = openingRow();
                row.focus();
                pressKey(row, 'Enter');
                row.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
            });
            const back = control('filters.scope.list:header:leading:back-chip');
            await act(async () => { back.focus(); back.click(); });
            expect(document.activeElement).toBe(openingRow());
            await act(async () => { pressKey(openingRow(), 'Escape'); });
            expect(document.activeElement).toBe(trigger);
            await act(async () => { trigger.click(); });
            await act(async () => { control('popover-sheet.close').click(); });
            expect(document.activeElement).toBe(trigger);
        });
    });
});
