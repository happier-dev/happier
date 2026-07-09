import {
    SESSION_LIST_ROW_HEIGHT_COMPACT,
    SESSION_LIST_ROW_HEIGHT_DEFAULT,
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
    SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE,
} from './sessionListRowHeights';

export type SessionListRowPlatform = 'ios' | 'android' | 'web' | 'windows' | 'macos';

export type SessionListDensityViewState = Readonly<{
    compact: boolean;
    compactMinimal: boolean;
    rowHeight: number;
}>;

export type ResolveSessionListDensityViewStateOptions = Readonly<{
    isTablet: boolean;
    platform: SessionListRowPlatform | string;
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

const SESSION_LIST_DENSITY_VIEW_STATE_MINIMAL_NATIVE_PHONE: SessionListDensityViewState = Object.freeze({
    compact: true,
    compactMinimal: true,
    rowHeight: SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE,
});

function shouldUseReadableNativePhoneMinimalSessionRow(
    options: ResolveSessionListDensityViewStateOptions | null | undefined,
): boolean {
    return Boolean(
        options
        && !options.isTablet
        && (options.platform === 'ios' || options.platform === 'android'),
    );
}

export function resolveSessionListDensityViewState(
    sessionListDensity: string | null | undefined,
    options?: ResolveSessionListDensityViewStateOptions,
): SessionListDensityViewState {
    if (sessionListDensity === 'narrow') {
        if (shouldUseReadableNativePhoneMinimalSessionRow(options)) {
            return SESSION_LIST_DENSITY_VIEW_STATE_MINIMAL_NATIVE_PHONE;
        }
        return SESSION_LIST_DENSITY_VIEW_STATE_MINIMAL;
    }

    if (sessionListDensity === 'cozy') {
        return SESSION_LIST_DENSITY_VIEW_STATE_COMPACT;
    }

    return SESSION_LIST_DENSITY_VIEW_STATE_DEFAULT;
}
