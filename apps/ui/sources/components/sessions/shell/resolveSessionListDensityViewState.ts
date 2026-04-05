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

export function resolveSessionListDensityViewState(sessionListDensity: string | null | undefined): SessionListDensityViewState {
    if (sessionListDensity === 'narrow') {
        return {
            compact: true,
            compactMinimal: true,
            rowHeight: SESSION_LIST_ROW_HEIGHT_MINIMAL,
        };
    }

    if (sessionListDensity === 'cozy') {
        return {
            compact: true,
            compactMinimal: false,
            rowHeight: SESSION_LIST_ROW_HEIGHT_COMPACT,
        };
    }

    return {
        compact: false,
        compactMinimal: false,
        rowHeight: SESSION_LIST_ROW_HEIGHT_DEFAULT,
    };
}
