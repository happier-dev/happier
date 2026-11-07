import { MULTI_PANE_MAIN_COLUMN_TEST_ID } from '@/components/ui/panels/multiPaneTestIds';
import { APP_SHELL_CONTENT_SHEET_TEST_ID } from '@/components/navigation/shell/desktopChrome/desktopChromeMetrics';

function isShown(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
        && (element as HTMLElement).checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) !== false;
}

function widest(elements: readonly Element[]): Element | null {
    return elements.reduce<Element | null>((best, next) => (
        !best || next.getBoundingClientRect().width > best.getBoundingClientRect().width ? next : best
    ), null);
}

/** A page pane's own column: the main column, or a docked details or side pane beside it. */
const DOCK_PANE_COLUMN_SELECTOR = [MULTI_PANE_MAIN_COLUMN_TEST_ID, 'multi-pane-details-docked', 'multi-pane-right-docked']
    .map((testId) => `[data-testid="${testId}"]`).join(', ');

/**
 * The column the dock seats in: the shown pane column that holds the control that opened it (a Triage detail's
 * Ask seats it under that detail, not the list beside it); without such a control (the sidebar's New, the
 * shortcut, Home), the shown page's main column beside any side panel, else the content sheet.
 */
export function resolveNewSessionDockPaneElement(origin: unknown): Element | null {
    const holder = typeof Element !== 'undefined' && origin instanceof Element && origin.isConnected
        ? origin.closest(DOCK_PANE_COLUMN_SELECTOR) : null;
    if (holder && isShown(holder)) return holder;
    const columns = [...document.querySelectorAll(`[data-testid="${MULTI_PANE_MAIN_COLUMN_TEST_ID}"]`)].filter(isShown);
    const outermost = columns.filter((column) => !columns.some((other) => other !== column && other.contains(column)));
    return widest(outermost)
        ?? widest([...document.querySelectorAll(`[data-testid="${APP_SHELL_CONTENT_SHEET_TEST_ID}"]`)].filter(isShown));
}
