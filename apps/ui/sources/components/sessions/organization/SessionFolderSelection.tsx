import * as React from 'react';
import { SelectionList, type SelectionListStep } from '@/components/ui/selectionList';
import { Modal } from '@/modal';
import type { SectionAddress, SessionSection } from '@/sync/domains/session/organization/sections';
import { useSessionSectionChoiceLabels } from '@/sync/domains/session/organization/useSessionSectionChoiceLabels';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { t } from '@/text';
import { buildSessionSectionMoveMenuItems, readSessionSectionMoveMenuChoice } from './sessionSectionMoveMenu';

export type SessionSectionChooserProps = Readonly<{
    sourceLabel: string;
    serverId: string;
    value: SectionAddress | null;
    sections: readonly SessionSection[];
    onChange: (next: SectionAddress | null) => void;
    onCreate?: () => Promise<SectionAddress | null>;
    disabledReason?: string;
    projectTitle?: string | null;
    /** Bulk selections retain each member's current assignment without inventing one common value. */
    currentSectionIds?: readonly (string | null)[];
    onCancel: () => void;
}>;

/** Controlled Info/bulk chooser. Loading, Account lifetime and writes remain with its host. */
export function SessionSectionChooser(props: SessionSectionChooserProps): React.ReactElement {
    const sectionChoiceLabels = useSessionSectionChoiceLabels(props.sections, props.serverId, t('common.unavailable'));
    const items = buildSessionSectionMoveMenuItems({
        serverId: props.serverId, sections: props.sections,
        currentSectionIds: props.currentSectionIds ?? [props.value?.serverId === props.serverId ? props.value.sectionId : null],
        projectTitle: props.projectTitle ?? null, canCreate: Boolean(props.onCreate),
        sectionChoiceLabels,
    });
    const [busy, select] = useHappyAction(async (id: string) => {
        if (props.disabledReason) return;
        const item = items.find(candidate => candidate.id === id);
        if (!item || item.disabled || item.checked) return;
        const choice = readSessionSectionMoveMenuChoice(id);
        if (choice?.kind === 'project') props.onChange(null);
        else if (choice?.kind === 'new') {
            const created = await props.onCreate?.();
            if (created?.serverId === props.serverId) props.onChange(created);
        } else if (choice?.kind === 'section') {
            const section = props.sections.find(candidate => candidate.address.serverId === props.serverId
                && candidate.address.sectionId === choice.sectionId);
            if (section) props.onChange(section.address);
        }
    });
    const rootStep: SelectionListStep = {
        id: 'root',
        title: t('sessionsList.moveSheetTitle', { item: props.sourceLabel }),
        inputPlaceholder: t('sessionsList.moveSheetSearchPlaceholder'),
        emptyStateLabel: props.disabledReason ?? t('sessionsList.moveSheetEmpty'),
        sections: [{
            kind: 'static', id: 'folders',
            options: items.map(item => ({ id: item.id, label: item.title,
                disabled: busy || Boolean(props.disabledReason) || item.disabled || item.checked,
                ...(item.icon ? { icon: item.icon } : {}) })),
        }],
    };
    return <SelectionList rootStep={rootStep}
        onSelect={select}
        onRequestClose={props.onCancel}
        keyboardHintsEnabled={false} disableTransitions testID="session-folder-selection" />;
}

/** Undefined cancels; null is an explicit Back to project choice. */
export function openSessionFolderSelection(params: Omit<SessionSectionChooserProps, 'onChange' | 'onCancel'>): Promise<SectionAddress | null | undefined> {
    return new Promise(resolve => {
        let settled = false;
        let modalId: string | null = null;
        const settle = (target: SectionAddress | null | undefined) => {
            if (settled) return;
            settled = true;
            if (modalId) Modal.hide(modalId);
            resolve(target);
        };
        modalId = Modal.show({
            component: SessionSectionChooser,
            chrome: { kind: 'card', title: t('sessionsList.moveSheetTitle', { item: params.sourceLabel }) },
            closeOnBackdrop: true,
            onRequestClose: () => settle(undefined),
            props: { ...params, onChange: settle, onCancel: () => settle(undefined) },
        });
    });
}
