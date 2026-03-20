export type AgentInputChipPickerOption = Readonly<{
    id: string;
    label: string;
    subtitle?: string;
    sectionId?: string;
    sectionLabel?: string;
    detailTitle?: string;
    detailDescription?: string;
    detailBullets?: ReadonlyArray<string>;
    detailContent?: React.ReactNode;
    renderDetailContent?: () => React.ReactNode;
    detailActionLabel?: string;
    onDetailAction?: () => void;
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
            || option.detailActionLabel
            || (option.detailBullets?.length ?? 0) > 0,
        )
    );
}
