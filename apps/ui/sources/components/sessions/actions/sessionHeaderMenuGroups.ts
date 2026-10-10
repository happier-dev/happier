import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/**
 * The groups of a session's ⋯ menu, in reading order: what opens beside or inside the session, what
 * changes this session, how it behaves (a bot or a regular session, its tool calls: lab `b-promote`),
 * what starts work from it, and what ends it. Every producer (session operations, Action specs, the
 * session view's extras, plugins) files its rows under one of these.
 */
export type SessionHeaderMenuGroup = 'open' | 'session' | 'behavior' | 'work' | 'finish';

const GROUP_ORDER: readonly SessionHeaderMenuGroup[] = ['open', 'session', 'behavior', 'work', 'finish'];

const GROUP_LABEL_KEYS = {
    session: 'session.actionMenu.groups.session',
    behavior: 'session.actionMenu.groups.behavior',
    work: 'session.actionMenu.groups.work',
    finish: 'session.actionMenu.groups.finish',
} as const;

/** Action-spec rows of the menu: where each sits and its mark (a spec carries neither). */
export const SESSION_HEADER_MENU_SPEC_PRESENTATION: Readonly<Record<string, Readonly<{ group: SessionHeaderMenuGroup; icon: IconName }>>> = {
    'review.start': { group: 'work', icon: 'shield-check' },
    'review.walkthrough': { group: 'work', icon: 'book-open' },
    'review.explain_findings': { group: 'work', icon: 'lightbulb' },
    'subagents.plan.start': { group: 'work', icon: 'list-checks' },
    'subagents.delegate.start': { group: 'work', icon: 'arrow-elbow-down-right' },
    'session.fork': { group: 'work', icon: 'git-branch' },
    'session.handoff': { group: 'work', icon: 'laptop' },
};

/** Rows the session view adds that start work; its other rows open something (a pane, a terminal). */
const WORK_EXTRA_ITEM_IDS: ReadonlySet<string> = new Set(['header.makeRepeatable', 'header.automateExactTurnCompletion']);

export function resolveSessionHeaderExtraItemGroup(itemId: string): SessionHeaderMenuGroup {
    return WORK_EXTRA_ITEM_IDS.has(itemId) ? 'work' : 'open';
}

/**
 * Orders the menu by group (producer order is kept inside a group) and names every group after the
 * first with a quiet sentence-case label. Destructive operations always close the menu, in the last
 * group, whichever group their producer chose.
 */
export function composeSessionHeaderMenu(
    entries: ReadonlyArray<Readonly<{ group: SessionHeaderMenuGroup; item: DropdownMenuItem }>>,
): DropdownMenuItem[] {
    const byGroup = new Map<SessionHeaderMenuGroup, DropdownMenuItem[]>();
    for (const entry of entries) {
        const group = entry.item.destructive ? 'finish' : entry.group;
        const items = byGroup.get(group) ?? [];
        items.push(entry.item);
        byGroup.set(group, items);
    }
    const result: DropdownMenuItem[] = [];
    for (const group of GROUP_ORDER) {
        const items = byGroup.get(group);
        if (!items || items.length === 0) continue;
        // The first group present opens the menu without a heading; later ones say what they hold.
        const category = result.length === 0 || group === 'open' ? undefined : t(GROUP_LABEL_KEYS[group]);
        for (const item of items) {
            // A producer's own category never splits a group: the group decides the heading.
            const { category: _producerCategory, ...row } = item;
            result.push(category ? { ...row, category } : row);
        }
    }
    return result;
}
