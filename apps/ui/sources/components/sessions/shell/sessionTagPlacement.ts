export type SessionTagPlacement = 'below' | 'inline';
export type SessionTagPlacementDensity = 'default' | 'compact' | 'minimal';

export type SessionTagPlacementChip = Readonly<{
    key?: string;
    label: string;
}>;

export type ResolveSessionTagPlacementInput = Readonly<{
    density: SessionTagPlacementDensity;
    tags: readonly SessionTagPlacementChip[];
    rowWidth: number | null;
    hasTrailingMeta: boolean;
    hasRowActions: boolean;
    hasLeadingIdentity?: boolean;
}>;

export type SessionTagDisplayChip = Readonly<{
    key: string;
    label: string;
    isOverflow: boolean;
}>;

export type SessionTagDisplayPlan = Readonly<{
    placement: SessionTagPlacement;
    chips: readonly SessionTagDisplayChip[];
}>;

const NARROW_INLINE_MAX_TOTAL_LABEL_LENGTH = 10;
const COMPACT_INLINE_MAX_TOTAL_LABEL_LENGTH = 10;
const COMPACT_INLINE_MAX_TOTAL_LABEL_LENGTH_WITH_IDENTITY = 5;
const COMPACT_INLINE_MAX_TAG_WIDTH = 96;
const ESTIMATED_TAG_CHARACTER_WIDTH = 5.5;
const ESTIMATED_TAG_HORIZONTAL_CHROME = 16;
const COMPACT_ROW_NON_TITLE_CHROME = 102;
const TRAILING_META_WIDTH = 28;
const COMPACT_TITLE_MIN_WIDTH = 92;

export function resolveSessionTagPlacement(input: ResolveSessionTagPlacementInput): SessionTagPlacement {
    if (input.hasRowActions) return 'below';
    return planSessionTagDisplay(input).placement;
}

export function planSessionTagDisplay(input: ResolveSessionTagPlacementInput): SessionTagDisplayPlan {
    if (input.tags.length === 0 || input.hasRowActions) {
        return {
            placement: 'inline',
            chips: [],
        };
    }

    if (input.density === 'minimal') {
        return {
            placement: 'inline',
            chips: createBudgetedInlineTagChips(input.tags, NARROW_INLINE_MAX_TOTAL_LABEL_LENGTH),
        };
    }

    const allChips = createTagChips(input.tags);
    if (input.density === 'default') {
        return {
            placement: 'below',
            chips: allChips,
        };
    }

    const maxTotalLabelLength = input.hasLeadingIdentity === true
        ? COMPACT_INLINE_MAX_TOTAL_LABEL_LENGTH_WITH_IDENTITY
        : COMPACT_INLINE_MAX_TOTAL_LABEL_LENGTH;
    if (getTotalLabelLength(input.tags) > maxTotalLabelLength) {
        return {
            placement: 'below',
            chips: allChips,
        };
    }

    const tagWidth = estimateInlineTagWidth(input.tags);
    if (tagWidth > COMPACT_INLINE_MAX_TAG_WIDTH) {
        return {
            placement: 'below',
            chips: allChips,
        };
    }

    if (input.rowWidth == null) {
        return {
            placement: 'inline',
            chips: allChips,
        };
    }

    const trailingMetaWidth = input.hasTrailingMeta ? TRAILING_META_WIDTH : 0;
    const availableTagWidth = input.rowWidth - COMPACT_ROW_NON_TITLE_CHROME - trailingMetaWidth - COMPACT_TITLE_MIN_WIDTH;
    return tagWidth <= availableTagWidth
        ? {
            placement: 'inline',
            chips: allChips,
        }
        : {
            placement: 'below',
            chips: allChips,
        };
}

function createBudgetedInlineTagChips(
    tags: readonly SessionTagPlacementChip[],
    maxTotalLabelLength: number,
): readonly SessionTagDisplayChip[] {
    const sortedTags = tags
        .map((tag, index) => ({ tag, index }))
        .sort((a, b) => {
            const lengthDelta = a.tag.label.length - b.tag.label.length;
            return lengthDelta === 0 ? a.index - b.index : lengthDelta;
        });
    const visibleTags: Array<{ tag: SessionTagPlacementChip; index: number }> = [];
    let usedLabelLength = 0;
    for (const candidate of sortedTags) {
        const nextLabelLength = usedLabelLength + candidate.tag.label.length;
        if (nextLabelLength > maxTotalLabelLength) continue;
        visibleTags.push(candidate);
        usedLabelLength = nextLabelLength;
    }

    const hiddenCount = tags.length - visibleTags.length;
    const visibleChips = visibleTags.map(({ tag, index }) => createTagChip(tag, index));
    if (hiddenCount <= 0) return visibleChips;

    return [
        ...visibleChips,
        {
            key: '__more__',
            label: `+${hiddenCount}`,
            isOverflow: true,
        },
    ];
}

function createTagChips(tags: readonly SessionTagPlacementChip[]): readonly SessionTagDisplayChip[] {
    return tags.map((tag, index) => createTagChip(tag, index));
}

function createTagChip(tag: SessionTagPlacementChip, index: number): SessionTagDisplayChip {
    return {
        key: tag.key ?? `${tag.label}:${index}`,
        label: tag.label,
        isOverflow: false,
    };
}

function getTotalLabelLength(tags: readonly SessionTagPlacementChip[]): number {
    return tags.reduce((sum, tag) => sum + tag.label.length, 0);
}

function estimateInlineTagWidth(tags: readonly SessionTagPlacementChip[]): number {
    if (tags.length === 0) return 0;
    const chipWidths = tags.map((tag) =>
        Math.ceil(tag.label.length * ESTIMATED_TAG_CHARACTER_WIDTH) + ESTIMATED_TAG_HORIZONTAL_CHROME
    );
    const gapWidth = Math.max(0, tags.length - 1) * 4;
    return chipWidths.reduce((sum, width) => sum + width, 0) + gapWidth;
}
