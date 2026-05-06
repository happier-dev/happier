import * as React from 'react';
import { Platform } from 'react-native';

type DesktopSidebarHistoryPosition = Readonly<{
    index: number;
    total: number;
}>;

export type DesktopSidebarHistoryNavigationAvailability = Readonly<{
    canNavigateBack: boolean;
    canNavigateForward: boolean;
}>;

const HISTORY_POSITION_STATE_KEY = '__happierDesktopSidebarHistoryPosition';
const DEFAULT_POSITION: DesktopSidebarHistoryPosition = { index: 0, total: 1 };
const UNAVAILABLE_NAVIGATION: DesktopSidebarHistoryNavigationAvailability = {
    canNavigateBack: false,
    canNavigateForward: false,
};

type HistoryStateWithPosition = Record<string, unknown> & {
    [HISTORY_POSITION_STATE_KEY]?: DesktopSidebarHistoryPosition;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isValidPosition(value: unknown): value is DesktopSidebarHistoryPosition {
    if (!isRecord(value)) {
        return false;
    }
    const index = value.index;
    const total = value.total;
    return typeof index === 'number'
        && typeof total === 'number'
        && Number.isInteger(index)
        && Number.isInteger(total)
        && index >= 0
        && total >= 1
        && index < total;
}

function normalizePosition(position: DesktopSidebarHistoryPosition): DesktopSidebarHistoryPosition {
    const total = Math.max(1, Math.floor(position.total));
    const index = Math.min(Math.max(0, Math.floor(position.index)), total - 1);
    return { index, total };
}

function readHistoryPosition(history: History): DesktopSidebarHistoryPosition {
    const state = history.state as unknown;
    if (isRecord(state)) {
        const position = (state as HistoryStateWithPosition)[HISTORY_POSITION_STATE_KEY];
        if (isValidPosition(position)) {
            return normalizePosition(position);
        }
    }
    return DEFAULT_POSITION;
}

function attachHistoryPosition(state: unknown, position: DesktopSidebarHistoryPosition): HistoryStateWithPosition {
    const base = isRecord(state) ? state : { value: state };
    return {
        ...base,
        [HISTORY_POSITION_STATE_KEY]: normalizePosition(position),
    };
}

function readNavigationAvailability(history: History): DesktopSidebarHistoryNavigationAvailability {
    const position = readHistoryPosition(history);
    return {
        canNavigateBack: position.index > 0,
        canNavigateForward: position.index < position.total - 1,
    };
}

function resolveBrowserHistory(): History | null {
    if (Platform.OS !== 'web') {
        return null;
    }
    const history = (globalThis as typeof globalThis & { history?: History }).history;
    if (
        !history
        || typeof history.pushState !== 'function'
        || typeof history.replaceState !== 'function'
    ) {
        return null;
    }
    return history;
}

function resolveBrowserHistoryEventTarget(): Pick<typeof globalThis, 'addEventListener' | 'removeEventListener'> | null {
    if (
        typeof globalThis.addEventListener !== 'function'
        || typeof globalThis.removeEventListener !== 'function'
    ) {
        return null;
    }
    return globalThis;
}

export function useDesktopSidebarHistoryNavigationAvailability(): DesktopSidebarHistoryNavigationAvailability {
    const [availability, setAvailability] = React.useState<DesktopSidebarHistoryNavigationAvailability>(() => {
        const history = resolveBrowserHistory();
        return history ? readNavigationAvailability(history) : UNAVAILABLE_NAVIGATION;
    });

    React.useEffect(() => {
        const history = resolveBrowserHistory();
        if (!history) {
            setAvailability(UNAVAILABLE_NAVIGATION);
            return undefined;
        }

        const originalPushState = history.pushState.bind(history);
        const originalReplaceState = history.replaceState.bind(history);

        const updateAvailability = () => {
            setAvailability(readNavigationAvailability(history));
        };

        const currentPosition = readHistoryPosition(history);
        originalReplaceState(
            attachHistoryPosition(history.state, currentPosition),
            '',
        );
        updateAvailability();

        history.pushState = ((state: unknown, unused: string, url?: string | URL | null) => {
            const previousPosition = readHistoryPosition(history);
            const nextIndex = previousPosition.index + 1;
            originalReplaceState(
                attachHistoryPosition(history.state, { index: previousPosition.index, total: nextIndex + 1 }),
                '',
            );
            originalPushState(
                attachHistoryPosition(state, { index: nextIndex, total: nextIndex + 1 }),
                unused,
                url ?? undefined,
            );
            updateAvailability();
        }) as History['pushState'];

        history.replaceState = ((state: unknown, unused: string, url?: string | URL | null) => {
            originalReplaceState(
                attachHistoryPosition(state, readHistoryPosition(history)),
                unused,
                url ?? undefined,
            );
            updateAvailability();
        }) as History['replaceState'];

        const eventTarget = resolveBrowserHistoryEventTarget();
        eventTarget?.addEventListener('popstate', updateAvailability);

        return () => {
            history.pushState = originalPushState;
            history.replaceState = originalReplaceState;
            eventTarget?.removeEventListener('popstate', updateAvailability);
        };
    }, []);

    return availability;
}
