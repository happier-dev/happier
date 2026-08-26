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

const INLINE_MAX_TOTAL_LABEL_LENGTH = 18;

export function resolveSessionTagPlacement(input: ResolveSessionTagPlacementInput): SessionTagPlacement {
    void input;
    return 'inline';
}

export function planSessionTagDisplay(input: ResolveSessionTagPlacementInput): SessionTagDisplayPlan {
    if (input.tags.length === 0 || input.hasRowActions) {
        return {
            placement: 'inline',
            chips: [],
        };
    }

    return { placement: 'inline', chips: createBudgetedInlineTagChips(input.tags, INLINE_MAX_TOTAL_LABEL_LENGTH) };
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

function createTagChip(tag: SessionTagPlacementChip, index: number): SessionTagDisplayChip {
    return {
        key: tag.key ?? `${tag.label}:${index}`,
        label: tag.label,
        isOverflow: false,
    };
}
