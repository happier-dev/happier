import { Platform } from 'react-native';

import type { ResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';

function selectValue<T>(values: { ios?: T; default: T }): T {
    if (typeof Platform.select === 'function') {
        return Platform.select(values) ?? values.default;
    }
    return Platform.OS === 'ios' && values.ios !== undefined ? values.ios : values.default;
}

export const ITEM_TITLE_TEXT_METRICS: Record<ResolvedItemDensity, Readonly<{
    fontSize: number;
    lineHeight: number;
    letterSpacing: number;
}>> = {
    comfortable: {
        fontSize: selectValue({ ios: 17, default: 16 }),
        lineHeight: selectValue({ ios: 22, default: 24 }),
        letterSpacing: selectValue({ ios: -0.41, default: 0.15 }),
    },
    cozy: {
        fontSize: selectValue({ ios: 14, default: 14 }),
        lineHeight: selectValue({ ios: 20, default: 20 }),
        letterSpacing: selectValue({ ios: -0.3, default: 0.12 }),
    },
    compact: {
        fontSize: selectValue({ ios: 14, default: 13 }),
        lineHeight: selectValue({ ios: 18, default: 18 }),
        letterSpacing: selectValue({ ios: -0.24, default: 0.1 }),
    },
    tight: {
        fontSize: selectValue({ ios: 12, default: 12 }),
        lineHeight: selectValue({ ios: 18, default: 16 }),
        letterSpacing: selectValue({ ios: -0.24, default: 0.1 }),
    },
};

export const ITEM_SUBTITLE_TEXT_METRICS: Record<ResolvedItemDensity, Readonly<{
    fontSize: number;
    lineHeight: number;
    letterSpacing: number;
}>> = {
    comfortable: {
        fontSize: selectValue({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: selectValue({ ios: -0.24, default: 0.1 }),
    },
    cozy: {
        fontSize: selectValue({ ios: 12, default: 12 }),
        lineHeight: 18,
        letterSpacing: selectValue({ ios: -0.24, default: 0.1 }),
    },
    compact: {
        fontSize: selectValue({ ios: 12, default: 12 }),
        lineHeight: 16,
        letterSpacing: selectValue({ ios: -0.24, default: 0.1 }),
    },
    tight: {
        fontSize: selectValue({ ios: 11, default: 11 }),
        lineHeight: 14,
        letterSpacing: selectValue({ ios: -0.24, default: 0.1 }),
    },
};

export const ITEM_ICON_BOX_SIZE: Record<ResolvedItemDensity, number> = {
    comfortable: selectValue({ ios: 29, default: 32 }),
    cozy: selectValue({ ios: 22, default: 24 }),
    compact: selectValue({ ios: 18, default: 20 }),
    tight: selectValue({ ios: 18, default: 18 }),
};

export const ITEM_ICON_MARGIN_RIGHT: Record<ResolvedItemDensity, number> = {
    comfortable: 12,
    cozy: 14,
    compact: 10,
    tight: 8,
};

export const ITEM_CHEVRON_SIZE: Record<ResolvedItemDensity, number> = {
    comfortable: 18,
    cozy: 17,
    compact: 15,
    tight: 14,
};
