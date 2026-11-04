import * as React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { useUnistyles } from 'react-native-unistyles';
import type { SessionSection } from '@/sync/domains/session/organization/sections';
import { readSessionSectionChoiceLabels } from '@/sync/domains/session/organization/useSessionSectionChoiceLabels';
import { t } from '@/text';

import { resolveSessionSectionIcon } from './sessionSectionIcons';

/** Where a Move to section choice files the Session(s): a section, New section…, or back to its project. */
export type SessionSectionMoveChoice =
    | Readonly<{ kind: 'section'; sectionId: string }>
    | Readonly<{ kind: 'new' }>
    | Readonly<{ kind: 'project' }>;

const ITEM_PREFIX = 'session.section.move:';
const NEW_ITEM_ID = `${ITEM_PREFIX}new`;
const PROJECT_ITEM_ID = `${ITEM_PREFIX}project`;
const SECTION_ITEM_PREFIX = `${ITEM_PREFIX}section:`;

export function readSessionSectionMoveMenuChoice(itemId: string): SessionSectionMoveChoice | null {
    if (itemId === NEW_ITEM_ID) return { kind: 'new' };
    if (itemId === PROJECT_ITEM_ID) return { kind: 'project' };
    if (!itemId.startsWith(SECTION_ITEM_PREFIX)) return null;
    const sectionId = itemId.slice(SECTION_ITEM_PREFIX.length);
    return sectionId ? { kind: 'section', sectionId } : null;
}

function MoveIcon(props: Readonly<{ name: IconName; color?: string }>) {
    const { theme } = useUnistyles();
    return <Icon name={props.name} size={16} color={props.color ?? theme.colors.text.secondary} />;
}

export type SessionSectionMoveMenuInput = Readonly<{
    /** The Home the moved Session(s) live on: only its sections can hold them. */
    serverId: string;
    sections: readonly SessionSection[];
    /** The current section of each moved Session (null: in its project). */
    currentSectionIds: readonly (string | null)[];
    /** The moved Session's project, named in "Back to {project}" when known. */
    projectTitle: string | null;
    /** The menu's glyph colour; a chooser without one draws them in the secondary text role. */
    iconColor?: string;
    canCreate: boolean;
    /** The mounted chooser's live selection from the shared label owner; lazy menus read it on open. */
    sectionChoiceLabels?: ReadonlyMap<string, string>;
}>;

/**
 * The one Move to section choice list (lab `clsections:menu`): this Home's sections with their icons under
 * "Sections", then New section… and Back to {project}. The row menu draws it as a submenu and bulk move offers
 * the same choices, so every entry point files through the same places with the same names.
 */
export function buildSessionSectionMoveMenuItems(input: SessionSectionMoveMenuInput): DropdownMenuItem[] {
    const sections = input.sections.filter((section) => section.address.serverId === input.serverId
        && section.display.status === 'available');
    const labels = input.sectionChoiceLabels ?? readSessionSectionChoiceLabels(sections, input.serverId, t('common.unavailable'));
    const allIn = (sectionId: string | null) => input.currentSectionIds.length > 0
        && input.currentSectionIds.every((current) => current === sectionId);
    const category = t('sessionsList.sectionsMenuTitle');
    const items: DropdownMenuItem[] = sections.map((section) => ({
        id: `${SECTION_ITEM_PREFIX}${section.address.sectionId}`,
        title: labels.get(section.address.sectionId) ?? section.address.sectionId,
        category,
        icon: <MoveIcon name={resolveSessionSectionIcon(section.display.status === 'available' ? section.display.value.icon : null)}
            color={input.iconColor} />,
        ...(allIn(section.address.sectionId) ? { checked: true } : {}),
    }));
    if (input.canCreate) {
        items.push({ id: NEW_ITEM_ID, title: t('sessionsList.newSectionEllipsis'),
            icon: <MoveIcon name="plus" color={input.iconColor} /> });
    }
    items.push({
        id: PROJECT_ITEM_ID,
        title: input.projectTitle?.trim()
            ? t('sessionsList.moveToProjectNamed', { project: input.projectTitle.trim() })
            : t('sessionsList.moveToWorkspaceRoot'),
        icon: <MoveIcon name="folder" color={input.iconColor} />,
        ...(allIn(null) ? { disabled: true } : {}),
    });
    return items;
}
