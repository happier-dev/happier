import type * as React from 'react';

import type { IconName } from '@/components/ui/icons/Icon';

import { widgetSetupNeedsStep, type WidgetSetup, type WidgetSetupSubmitResult } from './widgetSetupModel';

/**
 * The one Add popover's content model (lab `cwidgets` G1, round 2). Every placement — the Board, the
 * Companion — describes what can be added as sections of entries; the popover only draws them, in its
 * Gallery or List view, and hands each choice back to the placement's existing add path.
 */

/** Gallery shows each entry as a tile (with a live preview when it has one); List as a menu row. */
export type WidgetAddView = 'gallery' | 'list';

export type WidgetAddEntry = Readonly<{
    id: string;
    title: string;
    /** Where it comes from ("Channels", "Built in", "Note"). */
    subtitle?: string;
    icon: IconName;
    /**
     * Already on this surface and a second copy would be the same thing (a widget with no inputs):
     * stays in place, marked Added, and cannot be picked again.
     */
    added?: boolean;
    /**
     * A widget with inputs that is already here ("2 on Home"): picking it adds another copy, which
     * its binding names (lab `dashboards` dbind G). Replaces Added for configurable widgets.
     */
    count?: string;
    /**
     * The existing Set up step. The panel shows it when an input is missing or ambiguous or when
     * several admitted sizes need a choice; a ready single-size choice submits with scoped feedback.
     */
    setup?: () => WidgetSetup;
    /**
     * Gallery only: the real widget body at this placement's data. Mounted only while the gallery is
     * open; the List view never mounts it.
     */
    renderPreview?: () => React.ReactNode;
    /**
     * Picking opens something that needs the focus (a note editor, the composer), so the popover
     * closes. Otherwise it stays open so another widget can be added.
     */
    closesOnPick?: boolean;
    /** Actual Adds acknowledge their result; navigation/Make choices return nothing. */
    onPick: () => void | Promise<WidgetSetupSubmitResult>;
}>;

/** A quick picker can hand its completed Add to the same gallery without submitting it again. */
export type WidgetAddOutcome = Readonly<{ entryId: string; title: string; result: WidgetSetupSubmitResult }>;

export type WidgetAddSection = Readonly<{
    id: string;
    title: string;
    /** A quiet note at the section's right ("live, with this session's data"). */
    hint?: string;
    /** `preview`: tiles with previews; `make`: glyph tiles; `chips`: one-line chips (panes). */
    kind: 'preview' | 'make' | 'chips';
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

/** The remembered setting stores the Collection's words (`grid` | `list`); the popover says Gallery. */
export function widgetAddViewFromSetting(value: 'grid' | 'list' | undefined | null): WidgetAddView {
    return value === 'list' ? 'list' : 'gallery';
}

export function widgetAddViewToSetting(view: WidgetAddView): 'grid' | 'list' {
    return view === 'list' ? 'list' : 'grid';
}

/**
 * What picking an entry does, decided once for the Gallery and for any list that offers widgets (a
 * Board's Add to board): nothing for an Added widget; the Set up step only when an input is missing
 * or ambiguous or there are several admitted sizes; a fully bound single-size widget submits its
 * proposed inputs at once; anything else is the entry's own pick.
 */
export type WidgetAddPick =
    | Readonly<{ kind: 'added' }>
    | Readonly<{ kind: 'setup'; setup: WidgetSetup }>
    | Readonly<{ kind: 'submit'; setup: WidgetSetup }>
    | Readonly<{ kind: 'pick' }>;

export function resolveWidgetAddPick(entry: WidgetAddEntry): WidgetAddPick {
    if (entry.added) return { kind: 'added' };
    if (!entry.setup) return { kind: 'pick' };
    const setup = entry.setup();
    return (setup.sizeChoices?.sizes.length ?? 0) > 1 || widgetSetupNeedsStep(setup.fields, setup.resolve(setup.initial))
        ? { kind: 'setup', setup } : { kind: 'submit', setup };
}
