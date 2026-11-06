import * as React from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useSessionCockpitPageBottomClearance } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';

// A pinned footer reserves the overlay for its whole subtree, including a nested page bar.
export const FloatingChromeClearanceReservedContext = React.createContext(false);

/**
 * How far the phone's floating bottom chrome (the tab bar and the docked Voice Island above it) covers
 * the bottom of the current page, in px (0 when none overlays it, or when the page is inside a modal that covers the bar). The one reading of that
 * reservation: `PagePinnedBar` applies it to a pinned bar, a host that embeds a scrolling view applies
 * it to the view's body.
 */
export function useFloatingChromeClearance(): number {
    return useFloatingChromeClearanceReservation().clearance;
}

export function useFloatingChromeClearanceReservation(): Readonly<{ clearance: number; reserved: boolean }> {
    const chromeHeight = useSessionCockpitPageBottomClearance();
    const inModal = useIsInsideModalBoundary();
    const reserved = React.useContext(FloatingChromeClearanceReservedContext);
    return {
        clearance: inModal || reserved ? 0 : chromeHeight,
        reserved: !inModal && (reserved || chromeHeight > 0),
    };
}

/** A kept bar holds its seat; a stacked one (a selection's bar) floats above the kept bars and is kept by what floats above it. */
export type PageBottomBarPlacement = 'kept' | 'stacked';
type PageBottomBarSeat = Readonly<{
    top: number;
    keptTop: number;
    report: (id: string, top: number | null, placement: PageBottomBarPlacement) => void;
}>;
type PageBottomBarReport = Readonly<{ top: number; placement: PageBottomBarPlacement }>;
const PageBottomBarSeatContext = React.createContext<PageBottomBarSeat | null>(null);

/**
 * The bottom bars a page keeps while something floats over it (the phone working capsule after an Ask):
 * the Edit key row, the Changes review bar, a selection's bar. Each publishes how far its top edge sits
 * above the page's bottom, so a floating companion takes the seat above the highest one instead of
 * covering it. One order: the page's own kept bars, then a selection's bar, then the capsule. Mounted
 * by the host that holds both the page and the companion.
 */
export function PageBottomBarSeatProvider(props: Readonly<{ children: React.ReactNode }>) {
    const [reports, setReports] = React.useState<Readonly<Record<string, PageBottomBarReport>>>({});
    const report = React.useCallback((id: string, top: number | null, placement: PageBottomBarPlacement) => {
        setReports((current) => {
            if (top === null) {
                if (!(id in current)) return current;
                const next = { ...current };
                delete next[id];
                return next;
            }
            const rounded = Number.isFinite(top) ? Math.max(0, Math.round(top)) : 0;
            const previous = current[id];
            return previous?.top === rounded && previous.placement === placement
                ? current
                : { ...current, [id]: { top: rounded, placement } };
        });
    }, []);
    const value = React.useMemo(() => {
        const all = Object.values(reports);
        return {
            top: Math.max(0, ...all.map((entry) => entry.top)),
            keptTop: Math.max(0, ...all.filter((entry) => entry.placement === 'kept').map((entry) => entry.top)),
            report,
        };
    }, [report, reports]);
    return React.createElement(PageBottomBarSeatContext.Provider, { value }, props.children);
}

/**
 * Where a floating companion's bottom edge goes, in px up from the page's bottom: its own edge
 * (`edgeBottom`), or one `s8` above the highest bar beneath it in the seat order when that is higher.
 * `above: 'kept'` is for a stacked bar, which sits above the page's own kept bars only.
 */
export function usePageBottomSeat(edgeBottom: number, above: 'all' | 'kept' = 'all'): number {
    const { theme } = useUnistyles();
    const seat = React.useContext(PageBottomBarSeatContext);
    const top = (above === 'kept' ? seat?.keptTop : seat?.top) ?? 0;
    return top > 0 ? Math.max(edgeBottom, top + theme.space.s8) : edgeBottom;
}

/**
 * A kept bottom bar's report: pass the distance from the page's bottom to the bar's own bottom edge
 * (0 for a bar in flow at the bottom, the tab-bar clearance for one floating above it) and attach the
 * returned `onLayout` to the bar. Leaves the seat when the bar unmounts or `enabled` turns false.
 */
export function useReportPageBottomBar(
    enabled: boolean,
    bottomOffset: number,
    placement: PageBottomBarPlacement = 'kept',
): ((event: LayoutChangeEvent) => void) | undefined {
    const seat = React.useContext(PageBottomBarSeatContext);
    const id = React.useId();
    const report = seat?.report;
    const [height, setHeight] = React.useState<number | null>(null);
    React.useEffect(() => {
        if (!report) return;
        report(id, enabled && height !== null ? bottomOffset + height : null, placement);
    }, [bottomOffset, enabled, height, id, placement, report]);
    React.useEffect(() => () => report?.(id, null, placement), [id, placement, report]);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height), []);
    return report ? onLayout : undefined;
}
