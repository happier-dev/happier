import * as React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { t } from '@/text';

export type SessionTagsMenuContentTag = Readonly<{
    id: string;
    label: string;
}>;

export type SessionTagsMenuContent = Readonly<{
    tags: readonly SessionTagsMenuContentTag[];
    selectedTagIds: readonly string[];
    dropdownItems: readonly DropdownMenuItem[];
    dropdownOnSelect: (tagId: string) => void;
    dropdownOnCreate: ((label: string) => void) | null;
    selectionListStep: SelectionListStep;
}>;

function normalizeTags(tags: readonly SessionTagsMenuContentTag[]): SessionTagsMenuContentTag[] {
    const seen = new Set<string>();
    const normalized: SessionTagsMenuContentTag[] = [];
    for (const tag of tags) {
        const id = tag.id.trim();
        const label = tag.label.trim();
        if (!id || !label || seen.has(id)) continue;
        seen.add(id);
        normalized.push({ id, label });
    }
    return normalized;
}

function normalizeIds(ids: readonly string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const rawId of ids) {
        const id = rawId.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        normalized.push(id);
    }
    return normalized;
}

/**
 * The shared tag-picker presentation model for Session rows, Session info and
 * new-Session authoring. Each surface keeps its incumbent overlay owner while
 * tag identity, selection affordances, search/create behavior and callbacks are
 * projected once here.
 */
export function buildSessionTagsMenuContent(params: Readonly<{
    tags: readonly SessionTagsMenuContentTag[];
    selectedTagIds: readonly string[];
    iconColor: string;
    onToggle: (tagId: string) => void;
    onCreate?: (label: string) => void;
}>): SessionTagsMenuContent {
    const tags = normalizeTags(params.tags);
    const selectedTagIds = normalizeIds(params.selectedTagIds);
    const selected = new Set(selectedTagIds);
    const dropdownOnSelect = (tagId: string) => {
        const normalized = tagId.trim();
        if (normalized) params.onToggle(normalized);
    };
    const dropdownOnCreate = params.onCreate
        ? (label: string) => {
            const normalized = label.trim();
            if (normalized) params.onCreate?.(normalized);
        }
        : null;
    const dropdownItems: DropdownMenuItem[] = tags.map((tag) => ({
        id: tag.id,
        testID: `session-tags-menu-item:${tag.id}`,
        title: tag.label,
        rightElement: selected.has(tag.id)
            ? <Icon name="check" size={16} color={params.iconColor} />
            : undefined,
    }));
    const selectionListStep: SelectionListStep = {
        id: 'session-tags-root',
        title: t('sessionTags.editTagsLabel'),
        inputPlaceholder: t('sessionTags.searchOrAddPlaceholder'),
        buildInputRow: dropdownOnCreate
            ? (input) => {
                const label = input.trim();
                if (!label || tags.some((tag) => tag.label === label)) return null;
                return {
                    id: 'session-tags-create',
                    label: `${t('dropdown.createItem.prefix')} ${label}`,
                    icon: <Icon name="plus" size={16} color={params.iconColor} />,
                    onSelect: () => dropdownOnCreate(label),
                };
            }
            : undefined,
        sections: [{
            kind: 'static',
            id: 'session-tags',
            options: tags.map((tag) => ({
                id: tag.id,
                testID: `session-tags-menu-item:${tag.id}`,
                label: tag.label,
                rightAccessory: selected.has(tag.id)
                    ? <Icon name="check" size={16} color={params.iconColor} />
                    : undefined,
                onSelect: () => params.onToggle(tag.id),
            })),
        }],
    };

    return {
        tags,
        selectedTagIds,
        dropdownItems,
        dropdownOnSelect,
        dropdownOnCreate,
        selectionListStep,
    };
}
