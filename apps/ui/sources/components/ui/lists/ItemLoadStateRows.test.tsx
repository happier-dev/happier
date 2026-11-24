import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

// Exercise the canonical health classifier and store. Only native rendering is substituted.
const { storage } = await import('@/sync/domains/state/storage');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();
beforeEach(() => {
    previous = storage.getState();
    applied = getAppliedActiveServerSnapshot();
    available = isAppliedActiveServerRuntimeAvailable();
    publishAppliedActiveServerSnapshot({ serverId: 'srv_studio', serverUrl: 'https://studio.example.test', generation: 1 });
    storage.setState({ endpointStatus: 'online', socketStatus: 'connected' });
});
afterEach(async () => {
    await act(async () => {
        standardCleanup();
        storage.setState(previous, true);
        publishAppliedActiveServerSnapshot(applied, available);
    });
});

const { ItemLoadStateRows } = await import('./ItemLoadStateRows');

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** What the section says, as a reader sees it (the shared notice composes its sentence in nested text). */
function hostTexts(screen: Screen): string {
    return screen.getTextContent();
}

describe('ItemLoadStateRows: a read from the Home this device uses', () => {
    const failedOnStudio = (onRetry: () => void, homeServerIds: readonly string[] = ['srv_studio']) => (
        <ItemLoadStateRows
            testID="retention"
            state={{ kind: 'failed', reason: "Couldn't read this Home's retention policy", onRetry, homeServerIds }}
        />
    );

    it('defers to the page\'s "can\'t reach" banner while that Home is unreachable: no second failure, no second Retry', async () => {
        storage.setState({ endpointStatus: 'offline' });
        const onRetry = vi.fn();
        const screen = await renderScreen(failedOnStudio(onRetry));

        expect(hostTexts(screen)).not.toContain("Couldn't read this Home's retention policy");
        expect(hostTexts(screen)).toContain('sidebarFooter.availableWhenHomeAnswers');
        expect(screen.findHostByTestId('retention-retry')).toBeNull();
    });

    it('reads again by itself once the Home answers, so the banner\'s Retry re-reads every deferred section', async () => {
        storage.setState({ endpointStatus: 'offline' });
        const onRetry = vi.fn();
        const screen = await renderScreen(failedOnStudio(onRetry));
        expect(onRetry).not.toHaveBeenCalled();

        await act(async () => { storage.setState({ endpointStatus: 'online' }); });
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('keeps its own failure and Retry when the Home answers but this read failed, or the read needs another Home', async () => {
        const answered = await renderScreen(failedOnStudio(vi.fn()));
        expect(hostTexts(answered)).toContain("Couldn't read this Home's retention policy");
        expect(answered.findHostByTestId('retention-retry')).not.toBeNull();
        await answered.unmount();

        storage.setState({ endpointStatus: 'offline' });
        const elsewhere = await renderScreen(failedOnStudio(vi.fn(), ['srv_studio', 'srv_lab']));
        expect(hostTexts(elsewhere)).toContain("Couldn't read this Home's retention policy");
        expect(elsewhere.findHostByTestId('retention-retry')).not.toBeNull();
    });
});

describe('ItemLoadStateRows', () => {
    it('reserves the section rows as a busy placeholder while loading, with no "Loading…" text row', async () => {
        const screen = await renderScreen(
            <ItemLoadStateRows testID="pools" state={{ kind: 'loading' }} rows={3} accessibilityLabel="Loading machine pools" />,
        );
        const region = screen.findHostByTestId('pools');
        expect(region?.props.accessibilityState).toEqual({ busy: true });
        expect(region?.props.accessibilityLabel).toBe('Loading machine pools');
        expect(screen.root.findAll((node) => typeof node.type === 'string' && /^pools-skeleton:\d$/.test(String(node.props.testID)))).toHaveLength(3);
        expect(/loading/i.test(hostTexts(screen))).toBe(false);
    });

    it('turns into one row that says what failed, with Retry, when the source fails', async () => {
        const onRetry = vi.fn();
        const screen = await renderScreen(
            <ItemLoadStateRows
                testID="pools"
                state={{ kind: 'failed', reason: "Couldn't read machine pools on Studio", onRetry }}
                rows={3}
                accessibilityLabel="Loading machine pools"
            />,
        );
        expect(hostTexts(screen)).toContain("Couldn't read machine pools on Studio");
        expect(screen.root.findAll((node) => typeof node.type === 'string' && /^pools-skeleton:/.test(String(node.props.testID)))).toHaveLength(0);
        expect(screen.findHostByTestId('pools')?.props.accessibilityState?.busy).not.toBe(true);
        await screen.pressByTestIdAsync('pools-retry');
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    // OWNER-UI-1115B A2: a small failure is drawn one way everywhere, the shared inline notice, never a row of its own
    // with a button (about 77 sections render their failed read through this owner).
    it('says a failed read with the one shared inline notice', async () => {
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const screen = await renderScreen(
            <ItemLoadStateRows testID="pools" state={{ kind: 'failed', reason: "Couldn't read machine pools on Studio", onRetry: () => {} }} />,
        );
        const notices = screen.findAllByType(SurfaceStateCard);
        expect(notices.map((node) => [node.props.size, node.props.kind])).toEqual([['line', 'error']]);
    });

    // TH-VISUAL-FIX-23 D2: a reserved line takes the box of the row that arrives, by the row's own metrics: a
    // two-line row's padding plus its title line, the gap and its description line, so nothing below it moves.
    // In a section that reserves a leading column the bars start on the titles' edge.
    it('reserves each line in the arriving row\'s box, from the shared page-row metrics', async () => {
        const { usePageRowMetrics } = await import('./useResolvedItemDensity');
        const { SectionLeadingColumnProvider, useSectionLeadingColumn } = await import('./sectionLeadingColumn');
        const { PAGE_LIST_METRICS } = await import('./pageListMetrics');
        const { StyleSheet } = await import('react-native');
        let metrics: ReturnType<typeof usePageRowMetrics> | null = null;
        function Probe(props: Readonly<{ leading?: boolean }>) {
            metrics = usePageRowMetrics();
            useSectionLeadingColumn(props.leading === true);
            return null;
        }
        const rowBox = (screen: Screen, id: string) => {
            const row = screen.findHostByTestId(id);
            const style = StyleSheet.flatten(row?.props.style) as Record<string, number>;
            // The row's text column: the line boxes that stand where the title and description will.
            const textColumn = row!.children.filter((child) => typeof child !== 'string').at(-1) as typeof row & object;
            const lines = textColumn.children
                .filter((child) => typeof child !== 'string')
                .map((child) => (StyleSheet.flatten((child as typeof row & object).props.style) as Record<string, number> | undefined)?.height)
                .filter((height): height is number => typeof height === 'number');
            return {
                height: Math.max(style.minHeight ?? 0, (style.paddingTop ?? 0) + (style.paddingBottom ?? 0) + lines.reduce((sum, line) => sum + line, 0)),
                textStart: style.paddingLeft,
            };
        };

        const plain = await renderScreen(<><Probe /><ItemLoadStateRows testID="ids" state={{ kind: 'loading' }} rows={1} lines={2} /></>);
        const m = metrics!;
        const twoLineRow = 2 * m.paddingVerticalPx + m.title.lineHeight + m.subtitle.marginTop + m.subtitle.lineHeight;
        expect(rowBox(plain, 'ids-skeleton:0')).toEqual({ height: Math.max(m.minHeightPx, twoLineRow), textStart: PAGE_LIST_METRICS.rowPaddingHorizontalPx });
        // The arriving row draws its hairline in its flow, under it: the reserved line keeps that room too.
        const { happierPageRowDividerWidth } = await import('@happier-dev/plugin-ui/presentation');
        const trailingRoom = (screen: Screen) => (StyleSheet.flatten(screen.findHostByTestId('ids')?.props.style) as Record<string, number>).paddingBottom ?? 0;
        expect(trailingRoom(plain)).toBe(happierPageRowDividerWidth());
        await plain.unmount();
        const sectionEnd = await renderScreen(<ItemLoadStateRows testID="ids" state={{ kind: 'loading' }} rows={1} showDivider={false} />);
        expect(trailingRoom(sectionEnd)).toBe(0);
        await sectionEnd.unmount();

        const oneLine = await renderScreen(<><Probe /><ItemLoadStateRows testID="ids" state={{ kind: 'loading' }} rows={1} lines={1} /></>);
        expect(rowBox(oneLine, 'ids-skeleton:0').height).toBe(Math.max(m.minHeightPx, 2 * m.paddingVerticalPx + m.title.lineHeight));
        await oneLine.unmount();

        const marked = await renderScreen(
            <SectionLeadingColumnProvider>
                <Probe leading />
                <ItemLoadStateRows testID="ids" state={{ kind: 'loading' }} rows={1} lines={2} />
            </SectionLeadingColumnProvider>,
        );
        expect(rowBox(marked, 'ids-skeleton:0').textStart).toBe(
            PAGE_LIST_METRICS.rowPaddingHorizontalPx + PAGE_LIST_METRICS.rowLeadingColumnPx + PAGE_LIST_METRICS.rowLeadingGapPx,
        );
        await marked.unmount();

        // A section can be completely empty until its read finishes. Its bars still start at
        // the titles' edge when the arriving items carry marks.
        const pending = await renderScreen(
            <SectionLeadingColumnProvider>
                <ItemLoadStateRows hasLeadingMark testID="ids" state={{ kind: 'loading' }} rows={1} lines={1} showDivider={false} />
            </SectionLeadingColumnProvider>,
        );
        expect(rowBox(pending, 'ids-skeleton:0')).toEqual({
            height: Math.max(m.minHeightPx, 2 * m.paddingVerticalPx + m.title.lineHeight),
            textStart: PAGE_LIST_METRICS.rowPaddingHorizontalPx + PAGE_LIST_METRICS.rowLeadingColumnPx + PAGE_LIST_METRICS.rowLeadingGapPx,
        });
        expect(trailingRoom(pending)).toBe(0);
    });

    it.each([
        { lines: 1, marked: false, last: true },
        { lines: 1, marked: true, last: false },
        { lines: 2, marked: true, last: true },
        { lines: 2, marked: false, last: false },
    ] as const)('matches an Item with $lines line(s), marked=$marked, last=$last', async ({ lines, marked, last }) => {
        const { HappierDivider } = await import('@happier-dev/plugin-ui/presentation');
        const { StyleSheet, View } = await import('react-native');
        const { Item } = await import('./Item');
        const { ItemGroup } = await import('./ItemGroup');
        const { ListPresentationProvider } = await import('./listPresentation');
        function WrappedRow({ children }: Readonly<{ children: React.ReactNode }>) {
            return children;
        }
        const present = (row: React.ReactNode) => (
            <ListPresentationProvider value="page">
                <ItemGroup virtualizedSegment={{ first: true, last }}>{row}</ItemGroup>
            </ListPresentationProvider>
        );
        const ready = await renderScreen(present(['first', 'second'].map(id => (
            <WrappedRow key={id}>
                <Item testID={id} title="Title" subtitle={lines === 2 ? 'Description' : undefined}
                    subtitleTestID={`${id}-description`} icon={marked ? <View testID={`${id}-mark`} /> : undefined} />
            </WrappedRow>
        ))));
        const title = ready.findAll(node => typeof node.type === 'string' && node.children.includes('Title'))[0]!;
        let row = title.parent;
        while (row && StyleSheet.flatten(row.props.style)?.minHeight == null) row = row.parent;
        const style = StyleSheet.flatten(row!.props.style);
        const titleStyle = StyleSheet.flatten(title.props.style);
        const description = StyleSheet.flatten(ready.findHostByTestId('first-description')?.props.style);
        const mark = ready.findHostByTestId('first-mark');
        let leading = mark?.parent;
        while (leading && StyleSheet.flatten(leading.props.style)?.marginRight == null) leading = leading.parent;
        const leadingStyle = StyleSheet.flatten(leading?.props.style);
        const dividerHeight = (id: string) => {
            const row = ready.findHostByTestId(id)!;
            return StyleSheet.flatten(row.findAllByType(HappierDivider)[0]?.props.style)?.height ?? 0;
        };
        const expected = {
            height: Math.max(style.minHeight, 2 * style.paddingVertical + titleStyle.lineHeight
                + (description?.marginTop ?? 0) + (description?.lineHeight ?? 0)),
            textStart: (style.paddingLeft ?? style.paddingHorizontal) + (leadingStyle?.width ?? leadingStyle?.minWidth ?? 0)
                + (leadingStyle?.marginLeft ?? 0) + (leadingStyle?.marginRight ?? 0),
            betweenRows: dividerHeight('first'),
            afterLast: dividerHeight('second'),
        };
        await ready.unmount();

        const waiting = await renderScreen(present(
            <WrappedRow>
                <ItemLoadStateRows testID="waiting" state={{ kind: 'loading' }} rows={2} lines={lines} hasLeadingMark={marked} />
            </WrappedRow>,
        ));
        const rowHost = waiting.findHostByTestId('waiting-skeleton:0')!;
        const placeholder = StyleSheet.flatten(rowHost.props.style);
        const column = rowHost.children.at(-1);
        if (!column || typeof column === 'string') throw new Error('Missing placeholder text column');
        const textHeight = column.children.reduce((height, line) => typeof line === 'string'
            ? height : height + (StyleSheet.flatten(line.props.style)?.height ?? 0), 0);
        const block = StyleSheet.flatten(waiting.findHostByTestId('waiting')?.props.style);
        expect({
            height: Math.max(placeholder.minHeight, placeholder.paddingTop + placeholder.paddingBottom + textHeight),
            textStart: placeholder.paddingLeft,
            betweenRows: block?.rowGap ?? 0,
            afterLast: block?.paddingBottom ?? 0,
        }).toEqual(expected);
    });

    it('reserves the one-line count rows that arrive in the Team shared-resources section', async () => {
        const { TeamSharedResourcesView } = await import('@/components/settings/teams/TeamSharedResourcesSection');
        const { ListPresentationProvider } = await import('./listPresentation');
        const { resolvePageRowMetrics } = await import('./pageRowMetrics');
        const { StyleSheet } = await import('react-native');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <TeamSharedResourcesView teamName="Design" serverId="srv_studio"
                    summary={{ status: 'loading', kinds: [], error: null, reload: async () => {} }}
                    destinationOf={() => null} onOpen={() => {}} />
            </ListPresentationProvider>,
        );
        const row = screen.findHostByTestId('team-overview-shared-loading-skeleton:0')!;
        const style = StyleSheet.flatten(row.props.style);
        const textColumn = row.children.at(-1);
        if (!textColumn || typeof textColumn === 'string') throw new Error('Missing placeholder text column');
        const lineHeight = textColumn.children.reduce((height, line) => typeof line === 'string'
            ? height : height + (StyleSheet.flatten(line.props.style)?.height ?? 0), 0);
        const metrics = resolvePageRowMetrics({ density: storage.getState().localSettings.uiItemDensity, shape: 'standard' });
        expect(Math.max(style.minHeight, style.paddingTop + style.paddingBottom + lineHeight)).toBe(
            Math.max(metrics.minHeightPx, 2 * metrics.paddingVerticalPx + metrics.title.lineHeight),
        );
    });

    it('offers no Retry when the failure cannot be retried from here', async () => {
        const screen = await renderScreen(
            <ItemLoadStateRows testID="pools" state={{ kind: 'failed', reason: 'This Home needs an update' }} rows={2} />,
        );
        expect(hostTexts(screen)).toContain('This Home needs an update');
        expect(screen.findHostByTestId('pools-retry')).toBeNull();
    });
});
