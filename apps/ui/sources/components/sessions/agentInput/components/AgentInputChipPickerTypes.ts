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
    preserveFocusOnExternalSelectionChange?: boolean;
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
}>;

export type AgentInputChipPickerOptionSection = Readonly<{
    id: string;
    label?: string;
    options: ReadonlyArray<AgentInputChipPickerOption>;
}>;

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
