import type * as React from 'react';

import type { IconName } from '@/components/ui/icons/Icon';
import type { ItemAction } from '@/components/ui/lists/itemActions';

import type { WidgetSetup, WidgetSetupSubmitResult } from './widgetSetupModel';

/**
 * The one Add surface's content model (lab `widget-add` wsplit A). Every placement — Home, a
 * WorkBoard, a Session Board, the Companion, a plugin area — describes what can be added as sections
 * of entries; the surface lists them, shows the selected one beside the list, and hands its Add back
 * to the placement's existing add path.
 */
export type WidgetAddEntry = WidgetAddEntryBase & (
    /** A widget: its pane is its setup, and its Add is the setup's canonical Action. */
    | Readonly<{ setup: () => WidgetSetup; onPick?: never; renderPreview?: never; actionLabel?: never; closesOnPick?: never }>
    | WidgetAddPickEntry
);

type WidgetAddEntryBase = Readonly<{
    id: string;
    title: string;
    /** One line of purpose ("New people per day, against last week"). */
    subtitle?: string;
    icon: IconName;
    /**
     * Already on this surface and a second copy would be the same thing (a widget with no inputs):
     * stays listed, marked Added, and its Add cannot add it again.
     */
    added?: boolean;
    /**
     * A widget with inputs that is already here ("2 on Home"): Add adds another copy, which its
     * binding names (lab `dashboards` dbind G). Replaces Added for configurable widgets.
     */
    count?: string;
    /** Management of this saved entry; separate from selecting or adding a placed copy. */
    actions?: ItemAction[];
}>;

/** Something else to add (a note, a pane link, a Board item): its pane shows it, and its Add runs `onPick`. */
type WidgetAddPickEntry = Readonly<{
    setup?: never;
    /**
     * An entry without a setup (a note, a pane link, a Board item): what its pane shows. Mounted only
     * while the entry is selected.
     */
    renderPreview?: () => React.ReactNode;
    /** An entry without a setup: its primary's words when they are not the surface's Add. */
    actionLabel?: string;
    /**
     * Its Add opens something that needs the focus (a note editor, the composer), so the surface
     * closes. Otherwise it stays open so another widget can be added.
     */
    closesOnPick?: boolean;
    /** An entry without a setup: its Add. Actual Adds acknowledge their result; navigation returns nothing. */
    onPick: () => void | Promise<WidgetSetupSubmitResult>;
}>;

export type WidgetAddSection = Readonly<{
    id: string;
    /** Where its widgets come from: Built in, a plugin's own name, Your widgets. */
    title: string;
    /** A quiet note after the title ("plugin", "by you or your agents"). */
    hint?: string;
    /** A plugin's own section: its installed mark leads the title. */
    pluginId?: string;
    entries: readonly WidgetAddEntry[];
}>;

/** "Ask the agent for a widget": drafts a sentence in the composer and sends nothing. */
export type WidgetAddAsk = Readonly<{
    title: string;
    /** The sentence it will draft ("Put something on this board that shows "). */
    draft: string;
    note: string;
    onPick: () => void;
}>;

function matches(needle: string, entry: WidgetAddEntry): boolean {
    if (needle.length === 0) return true;
    return [entry.title, entry.subtitle].some((value) => value !== undefined && value.toLocaleLowerCase().includes(needle));
}

/** The sections a search leaves: matching entries in place, empty sections dropped. */
export function filterWidgetAddSections(
    sections: readonly WidgetAddSection[],
    query: string,
): readonly WidgetAddSection[] {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length === 0) return sections.filter((section) => section.entries.length > 0);
    return sections.flatMap((section) => {
        const entries = section.entries.filter((entry) => matches(needle, entry));
        return entries.length > 0 ? [{ ...section, entries }] : [];
    });
}

/** The ask entry survives a search only when the query is part of what it does. */
export function matchesWidgetAddAsk(ask: WidgetAddAsk, query: string): boolean {
    const needle = query.trim().toLocaleLowerCase();
    return needle.length === 0 || ask.title.toLocaleLowerCase().includes(needle) || ask.draft.toLocaleLowerCase().includes(needle);
}

/**
 * The selection after an arrow key, in reading order across the visible sections: the first entry
 * when nothing is selected (or the selection was filtered away), clamped at either end.
 */
export function stepWidgetAddSelection(ids: readonly string[], current: string | null, step: -1 | 1): string | null {
    if (ids.length === 0) return null;
    const index = current === null ? -1 : ids.indexOf(current);
    if (index < 0) return step > 0 ? ids[0]! : ids[ids.length - 1]!;
    return ids[Math.max(0, Math.min(ids.length - 1, index + step))]!;
}
