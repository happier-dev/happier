export type SessionTagPlacement = 'below' | 'inline';
export type SessionTagPlacementDensity = 'default' | 'compact' | 'minimal';

export type SessionTagPlacementChip = Readonly<{
    label: string;
}>;

export type ResolveSessionTagPlacementInput = Readonly<{
    density: SessionTagPlacementDensity;
    tags: readonly SessionTagPlacementChip[];
    rowWidth: number | null;
    hasTrailingMeta: boolean;
    hasRowActions: boolean;
}>;

const COMPACT_INLINE_MAX_CHIPS = 2;
const MINIMAL_INLINE_MAX_CHIPS = 1;
const COMPACT_INLINE_MAX_LABEL_LENGTH = 4;
const MINIMAL_INLINE_MAX_LABEL_LENGTH = 3;
const COMPACT_INLINE_MAX_TAG_WIDTH = 74;
const MINIMAL_INLINE_MAX_TAG_WIDTH = 42;
const ESTIMATED_TAG_CHARACTER_WIDTH = 5.5;
const ESTIMATED_TAG_HORIZONTAL_CHROME = 16;
const COMPACT_ROW_NON_TITLE_CHROME = 102;
const MINIMAL_ROW_NON_TITLE_CHROME = 80;
const TRAILING_META_WIDTH = 28;
const COMPACT_TITLE_MIN_WIDTH = 132;
const MINIMAL_TITLE_MIN_WIDTH = 100;

export function resolveSessionTagPlacement(input: ResolveSessionTagPlacementInput): SessionTagPlacement {
    if (input.density === 'default' || input.tags.length === 0 || input.hasRowActions) {
        return 'below';
    }

    const maxChipCount = input.density === 'minimal' ? MINIMAL_INLINE_MAX_CHIPS : COMPACT_INLINE_MAX_CHIPS;
    if (input.tags.length > maxChipCount) {
        return 'below';
    }

    const maxLabelLength = input.density === 'minimal'
        ? MINIMAL_INLINE_MAX_LABEL_LENGTH
        : COMPACT_INLINE_MAX_LABEL_LENGTH;
    if (input.tags.some((tag) => tag.label.length > maxLabelLength)) {
        return 'below';
    }

    const tagWidth = estimateInlineTagWidth(input.tags);
    const maxTagWidth = input.density === 'minimal' ? MINIMAL_INLINE_MAX_TAG_WIDTH : COMPACT_INLINE_MAX_TAG_WIDTH;
    if (tagWidth > maxTagWidth) {
        return 'below';
    }

    if (input.rowWidth == null) {
        return 'inline';
    }

    const nonTitleChrome = input.density === 'minimal' ? MINIMAL_ROW_NON_TITLE_CHROME : COMPACT_ROW_NON_TITLE_CHROME;
    const titleMinWidth = input.density === 'minimal' ? MINIMAL_TITLE_MIN_WIDTH : COMPACT_TITLE_MIN_WIDTH;
    const trailingMetaWidth = input.hasTrailingMeta ? TRAILING_META_WIDTH : 0;
    const availableTagWidth = input.rowWidth - nonTitleChrome - trailingMetaWidth - titleMinWidth;
    return tagWidth <= availableTagWidth ? 'inline' : 'below';
}

function estimateInlineTagWidth(tags: readonly SessionTagPlacementChip[]): number {
    if (tags.length === 0) return 0;
    const chipWidths = tags.map((tag) =>
        Math.ceil(tag.label.length * ESTIMATED_TAG_CHARACTER_WIDTH) + ESTIMATED_TAG_HORIZONTAL_CHROME
    );
    const gapWidth = Math.max(0, tags.length - 1) * 4;
    return chipWidths.reduce((sum, width) => sum + width, 0) + gapWidth;
}
