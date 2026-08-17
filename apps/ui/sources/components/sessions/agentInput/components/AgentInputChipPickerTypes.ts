import { t } from '@/text';

export type AgentInputChipPickerDetailSelectOption = Readonly<{
    id: string;
    label: string;
    subtitle?: string;
    selected?: boolean;
    disabled?: boolean;
}>;

export type AgentInputChipPickerOptionRailAction = Readonly<{
    icon: React.ReactNode;
    accessibilityLabel: string;
    testID?: string;
    selected?: boolean;
    disabled?: boolean;
    onPress: () => void;
}>;

export const AGENT_INPUT_CHIP_PICKER_DETAIL_MIN_HEIGHT = 272;

export type AgentInputChipPickerOption = Readonly<{
    id: string;
    label: string;
    icon?: React.ReactNode;
    subtitle?: string;
    /**
     * Overrides the row's accessible name when the label alone would drop state a
     * sighted reader gets from the row itself — a checkmark is a glyph, not an
     * accessible state, and a row whose meaning is carried visually still owes a
     * screen reader that meaning in words.
     */
    accessibilityLabel?: string;
    /**
     * When true, the option is visually de-emphasized (e.g. CLI not detected),
     * but can still be focused/inspected in detailed pickers.
     */
    muted?: boolean;
    sectionId?: string;
    sectionLabel?: string;
    detailTitle?: string;
    detailDescription?: string;
    detailBullets?: ReadonlyArray<string>;
    detailContent?: React.ReactNode;
    renderDetailContent?: () => React.ReactNode;
    /**
     * Defers expensive custom detail rendering until after native interactions
     * so the popover shell can become visible without waiting on model/config UI.
     */
    deferRenderDetailContent?: boolean;
    /**
     * Stable identity for deferred detail readiness. Once this key has rendered,
     * later popover opens can show cached detail immediately.
     */
    deferredDetailContentCacheKey?: string;
    detailSelectOptions?: ReadonlyArray<AgentInputChipPickerDetailSelectOption>;
    detailActionLabel?: string;
    onDetailAction?: () => void;
    onSelectImmediate?: () => void;
    closeOnSelectImmediate?: boolean;
    /**
     * Label for this option's apply affordance. Options can carry different
     * consequences in one picker, so a row may name its own outcome instead of
     * inheriting the panel-wide label.
     */
    applyLabel?: string;
    preserveFocusOnExternalSelectionChange?: boolean;
    /**
     * A non-selection state mark for the row's indicator slot — drawn only when the
     * row is NOT the selection, so it stands in the checkmark's place rather than
     * beside it.
     *
     * It exists for the one fact a checkmark cannot carry: which option is the one
     * in use right now, once the selection has moved somewhere else. The producer
     * supplies the rendered glyph so this type keeps no opinion about which mark
     * means what — the composer's applied-runtime marker owner does.
     */
    statusMarker?: React.ReactNode;
    railAction?: AgentInputChipPickerOptionRailAction;
    onApply?: () => void;
    disabled?: boolean;
}>;

export type AgentInputChipPickerPanelProps = Readonly<{
    title: string;
    options: ReadonlyArray<AgentInputChipPickerOption>;
    selectedOptionId?: string | null;
    onSelect: (id: string) => void;
    onRequestClose: () => void;
    applyLabel?: string;
    showCloseButton?: boolean;
    railWidth?: number;
    railMaxWidth?: number | `${number}%`;
    detailPaneHeaderAccessory?: React.ReactNode;
    /**
     * Height the surrounding popover gives this panel. The split layout bounds each of its two
     * columns to it so the rail and the detail pane scroll independently instead of riding the
     * popover's single scroller together.
     */
    maxHeight?: number | null;
}>;

export type AgentInputChipPickerOptionSection = Readonly<{
    id: string;
    label?: string;
    options: ReadonlyArray<AgentInputChipPickerOption>;
}>;

/**
 * The accessible name for one picker row.
 *
 * A checkmark is a glyph, not an accessible state, and `accessibilityState.selected` maps to
 * `aria-selected`, which is invalid on `role="button"` and never reaches the web accessibility
 * tree — measured on the rendered rail, where every row exposed nothing but `aria-label`. The
 * selection therefore travels in the name, which is the pattern the in-session rail already uses
 * through `option.accessibilityLabel`. A row that supplies its own name keeps it: it is already
 * saying something more precise than "selected".
 */
export function resolveAgentInputChipPickerOptionAccessibilityLabel(
    option: AgentInputChipPickerOption,
    selected: boolean,
): string {
    if (option.accessibilityLabel) return option.accessibilityLabel;
    if (!selected) return option.label;
    return t('agentInput.chipPicker.selectedOptionAccessibilityLabel', { option: option.label });
}

export function buildAgentInputChipPickerSections(
    options: ReadonlyArray<AgentInputChipPickerOption>,
): ReadonlyArray<AgentInputChipPickerOptionSection> {
    const sections: AgentInputChipPickerOptionSection[] = [];
    const indexById = new Map<string, number>();

    for (const option of options) {
        const sectionId = option.sectionId ?? '__default__';
        const existingIndex = indexById.get(sectionId);
        if (existingIndex === undefined) {
            indexById.set(sectionId, sections.length);
            sections.push({
                id: sectionId,
                label: option.sectionLabel,
                options: [option],
            });
            continue;
        }

        const existing = sections[existingIndex];
        sections[existingIndex] = {
            ...existing,
            label: existing.label ?? option.sectionLabel,
            options: [...existing.options, option],
        };
    }

    return sections;
}

export function agentInputChipPickerHasDetailPane(
    options: ReadonlyArray<AgentInputChipPickerOption>,
): boolean {
    return options.some((option) =>
        Boolean(
            option.detailTitle
            || option.detailDescription
            || option.detailContent
            || option.renderDetailContent
            || (option.detailSelectOptions?.length ?? 0) > 0
            || option.detailActionLabel
            || (option.detailBullets?.length ?? 0) > 0,
        )
    );
}
