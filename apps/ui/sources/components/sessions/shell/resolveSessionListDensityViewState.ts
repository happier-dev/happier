import {
    SESSION_LIST_ROW_HEIGHT_COMPACT,
    SESSION_LIST_ROW_HEIGHT_DEFAULT,
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
} from './sessionListRowHeights';

export type SessionListDensityViewState = Readonly<{
    compact: boolean;
    compactMinimal: boolean;
    rowHeight: number;
}>;

const SESSION_LIST_DENSITY_VIEW_STATE_DEFAULT: SessionListDensityViewState = Object.freeze({
    compact: false,
    compactMinimal: false,
    rowHeight: SESSION_LIST_ROW_HEIGHT_DEFAULT,
});

const SESSION_LIST_DENSITY_VIEW_STATE_COMPACT: SessionListDensityViewState = Object.freeze({
    compact: true,
    compactMinimal: false,
    rowHeight: SESSION_LIST_ROW_HEIGHT_COMPACT,
});

const SESSION_LIST_DENSITY_VIEW_STATE_MINIMAL: SessionListDensityViewState = Object.freeze({
    compact: true,
    compactMinimal: true,
    rowHeight: SESSION_LIST_ROW_HEIGHT_MINIMAL,
});

export function resolveSessionListDensityViewState(sessionListDensity: string | null | undefined): SessionListDensityViewState {
    if (sessionListDensity === 'narrow') {
        return SESSION_LIST_DENSITY_VIEW_STATE_MINIMAL;
    }

    if (sessionListDensity === 'cozy') {
        return SESSION_LIST_DENSITY_VIEW_STATE_COMPACT;
    }

    return SESSION_LIST_DENSITY_VIEW_STATE_DEFAULT;
}
