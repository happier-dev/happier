import * as React from 'react';
import { getWidgetSizeFootprintV1 } from '@happier-dev/protocol/widgets';

import { CardGrid, CardGridCell } from '@/components/ui/cardGrid/CardGrid';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PageColumnProvider } from '@/components/ui/lists/listPresentation';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';

import { isHomeHubCardSection, type HomeHubSection } from './layout/homeHubLayout';

/** Widgets and card-like sections sit two to a row (one on a phone). */
export const HOME_HUB_CARD_ROW_COLUMNS = 2;

type Placed = Readonly<{ section: HomeHubSection<WidgetCandidate>; index: number }>;

type Slot =
    | Readonly<{ kind: 'single'; key: string; entry: Placed }>
    /** Consecutive cards (widgets, Latest runs) share one row container, two across. */
    | Readonly<{ kind: 'cards'; key: string; entries: readonly Placed[] }>;

/**
 * The visible sections in order, consecutive cards grouped into rows. Every other section is its own
 * slot keyed by its id. A card run belongs to the preceding non-card boundary (even when hidden), independently of
 * which cards are visible or first, so edits within a run preserve its unaffected children.
 */
function buildSlots(sections: readonly HomeHubSection<WidgetCandidate>[]): Slot[] {
    const slots: Slot[] = [];
    let run: Placed[] = [];
    let runKey = 'cards:root';
    const flush = () => {
        if (run.length > 0) slots.push({ kind: 'cards', key: runKey, entries: run });
        run = [];
    };
    sections.forEach((section, index) => {
        if (isHomeHubCardSection(section)) {
            if (!section.hidden) run.push({ section, index });
            return;
        }
        flush();
        if (!section.hidden) slots.push({ kind: 'single', key: section.id, entry: { section, index } });
        runKey = `cards:after:${section.id}`;
    });
    flush();
    return slots;
}

/** A full-width widget, or a full-width group, takes the whole row. */
function spansRow(section: HomeHubSection<WidgetCandidate>): boolean {
    if (section.kind === 'group') return section.group.width === 'full';
    return section.kind === 'widget' && getWidgetSizeFootprintV1('home', section.size)?.columnSpan === HOME_HUB_CARD_ROW_COLUMNS;
}

/**
 * Which cards of a two-up run take the whole row: a full-width card, and any half that would otherwise
 * sit beside an empty slot (no half follows it in its row). Saved sizes are untouched; this is placement.
 */
function rowSpanningCards(entries: readonly Placed[]): ReadonlySet<string> {
    const spanning = new Set<string>();
    let column = 0;
    entries.forEach((entry, index) => {
        if (spansRow(entry.section)) { spanning.add(entry.section.id); column = 0; return; }
        if (column === 1) { column = 0; return; }
        const next = entries[index + 1];
        if (!next || spansRow(next.section)) { spanning.add(entry.section.id); return; }
        column = 1;
    });
    return spanning;
}

/** What a section is told about where it landed. */
export type HomeHubSectionPlacement = Readonly<{
    /**
     * The card has its whole row to itself in a two-up grid, though it was saved at a half-row size. It
     * presents at its full-row size (lab rw-V: a Small left alone reads as its Wide) instead of stretching.
     */
    ownsRow: boolean;
    /**
     * The card sits in a row of small cards (three across, or the smalls a lead card left): it keeps its column and
     * takes the row's regular height.
     */
    inRowOfThree: boolean;
    /**
     * The card leads Home's cards on its own row (Machines with no machine yet, 58d AF1): it presents at its Full
     * size and takes its content's height, with no partner to match. Placement only; the saved size is untouched.
     */
    leads: boolean;
}>;

type RenderSection = (section: HomeHubSection<WidgetCandidate>, index: number, placement: HomeHubSectionPlacement) => React.ReactNode;

/**
 * A small card: a Small widget, or a built-in card (Latest runs), which has no size of its own and reads
 * as a short glance.
 */
function joinsSmallRow(section: HomeHubSection<WidgetCandidate>): boolean {
    return section.kind === 'builtin' || (section.kind === 'widget' && section.size === 'small');
}

type Segment = Readonly<{
    kind: 'lead' | 'twoUp' | 'threeUp';
    entries: readonly Placed[];
    /**
     * Behind a lead card the smalls it left (no longer three) pair two-up at the regular height a row of smalls
     * takes, so a glance's state is not squeezed to one line beside a card that shows its scene.
     */
    smallsAtRegularHeight?: boolean;
}>;

/**
 * Describes a card run's rows: three consecutive small cards sit three across in their own row
 * (owner 10-31, berthd's Boxes | Running services | Recent areas); every other card keeps the two-up flow.
 */
function segmentCardRun(entries: readonly Placed[], leadCardId: string | null): Segment[] {
    const segments: Segment[] = [];
    let twoUp: Placed[] = [];
    let index = 0;
    // The lead card (placed first by `firstRunOrder`) has its row to itself.
    if (leadCardId !== null && entries[0]?.section.id === leadCardId) {
        segments.push({ kind: 'lead', entries: [entries[0]] });
        index = 1;
    }
    while (index < entries.length) {
        const trio = entries.slice(index, index + 3);
        if (trio.length === 3 && trio.every((entry) => joinsSmallRow(entry.section))) {
            if (twoUp.length > 0) segments.push({ kind: 'twoUp', entries: twoUp });
            twoUp = [];
            segments.push({ kind: 'threeUp', entries: trio });
            index += 3;
            continue;
        }
        twoUp.push(entries[index]!);
        index += 1;
    }
    if (twoUp.length > 0) segments.push({ kind: 'twoUp', entries: twoUp });
    const led = segments[0]?.kind === 'lead';
    return led ? segments.map((segment) => segment.kind === 'twoUp' ? { ...segment, smallsAtRegularHeight: true } : segment) : segments;
}

/**
 * One stable grid per card run. Row capacity changes are placement facts on its keyed cells, so a
 * surviving card keeps its state and subscriptions when a trio becomes a pair or its size changes.
 */
function CardRow(props: Readonly<{ slot: Extract<Slot, { kind: 'cards' }>; leadCardId: string | null; renderSection: RenderSection }>) {
    const { slot, renderSection } = props;
    const [columns, setColumns] = React.useState(1);
    return (
        <ItemGroup surface="none">
            <CardGrid testID={`home-hub.${slot.key}`} columns={3} onColumnCountChange={setColumns}>
                {segmentCardRun(slot.entries, props.leadCardId).flatMap(segment => {
                    const leads = segment.kind === 'lead';
                    const spanning = segment.kind === 'twoUp' ? rowSpanningCards(segment.entries) : NO_SPANNING;
                    return segment.entries.map((entry, index) => {
                        const span = leads || spanning.has(entry.section.id) ? 'row' : undefined;
                        const ownsRow = !leads && span === 'row' && columns > 1 && !spansRow(entry.section);
                        return (
                            <CardGridCell key={entry.section.id} span={span} columns={segment.kind === 'threeUp' ? 3 : HOME_HUB_CARD_ROW_COLUMNS} startRow={index === 0}>
                                {renderSection(entry.section, entry.index, {
                                    ownsRow,
                                    inRowOfThree: segment.kind === 'threeUp' || (segment.smallsAtRegularHeight === true && joinsSmallRow(entry.section)),
                                    leads,
                                })}
                            </CardGridCell>
                        );
                    });
                })}
            </CardGrid>
        </ItemGroup>
    );
}
const NO_SPANNING: ReadonlySet<string> = new Set();

/** Home's composer section: it keeps the reading column wherever it is placed. */
export const HOME_HUB_COMPOSER_SECTION_ID = 'start';
/** Get set up: with no machine yet it follows the cards, which carry the first steps, at their width. */
const HOME_HUB_SETUP_SECTION_ID = 'setup';

/**
 * The blocks that ask something of the person (the composer, Needs your attention, Get set up) share
 * the composer's reading column, centred, so the page reads as one column of things to do; the cards
 * below keep the wider dashboard grid (owner, 2026-10-30).
 */
const HOME_HUB_READING_SECTION_IDS: ReadonlySet<string> = new Set([HOME_HUB_COMPOSER_SECTION_ID, 'attention', HOME_HUB_SETUP_SECTION_ID]);

/**
 * With no machine yet the one question is where agents will run (58d AF1): the shown Machines widget leads
 * Home's cards. Home and its `/dev/home` fixture both ask this one owner; once a machine exists nothing leads.
 */
export function resolveHomeHubFirstRunLeadId(sections: readonly HomeHubSection<WidgetCandidate>[]): string | null {
    const lead = sections.find((section) => section.kind === 'widget' && !section.hidden
        && section.instance.definition.kind === 'builtin' && section.instance.definition.id === 'machine_fleet');
    return lead?.id ?? null;
}

type HomeHubOrder = Readonly<{
    sections: readonly HomeHubSection<WidgetCandidate>[];
    /** The sections that keep the reading column here (Get set up leaves it when it follows the cards). */
    readingIds: ReadonlySet<string>;
}>;

/**
 * The first-run order (58d AF1): the lead card moves to the head of the cards, and Get set up follows them, so the
 * composer is followed by where agents will run. Below the cards Get set up takes their dashboard column, so the page
 * reads narrow then wide, not narrow, wide, narrow (D1 C4). Placement only: every other section keeps its saved place.
 */
function firstRunOrder(sections: readonly HomeHubSection<WidgetCandidate>[], leadCardId: string | null | undefined): HomeHubOrder {
    const saved: HomeHubOrder = { sections, readingIds: HOME_HUB_READING_SECTION_IDS };
    if (!leadCardId) return saved;
    const lead = sections.find((section) => section.id === leadCardId);
    if (!lead || lead.hidden || !isHomeHubCardSection(lead)) return saved;
    const setup = sections.find((section) => section.id === HOME_HUB_SETUP_SECTION_ID);
    const rest = sections.filter((section) => section !== lead && section !== setup);
    const firstCard = rest.findIndex((section) => !section.hidden && isHomeHubCardSection(section));
    if (firstCard < 0) return saved;
    return {
        sections: [...rest.slice(0, firstCard), lead, ...rest.slice(firstCard), ...(setup ? [setup] : [])],
        readingIds: FIRST_RUN_READING_SECTION_IDS,
    };
}
const FIRST_RUN_READING_SECTION_IDS: ReadonlySet<string> = new Set(
    [...HOME_HUB_READING_SECTION_IDS].filter((id) => id !== HOME_HUB_SETUP_SECTION_ID),
);

/** Home's reading column, for the blocks above the sections (the greeting, the present, the brief). */
export function HomeHubReadingColumn(props: Readonly<{ children: React.ReactNode }>) {
    return <PageColumnProvider value="reading">{props.children}</PageColumnProvider>;
}

/**
 * Home's sections below the header, on Home's `dashboard` page column. The composer, Needs your
 * attention and Get set up keep the reading column, centred, wherever the person placed them (except Get set up
 * after the cards with no machine yet, which takes their column); the cards (widgets, Latest runs) share the dashboard column's edges, wider than the composer (lab
 * `.at-wsec`), and consecutive cards form two-up rows. A card left alone in its row (alone in the run,
 * or beside a full-width card) takes the whole row rather than leaving a hole. Home and its `/dev/home`
 * fixture both lay out through this one owner.
 */
export function HomeHubSectionList(props: Readonly<{
    sections: readonly HomeHubSection<WidgetCandidate>[];
    /**
     * The card that leads the cards on its own row ({@link resolveHomeHubFirstRunLeadId}), with Get set up after the
     * cards at their width; none once a machine exists, and the saved order and columns return.
     */
    leadCardId?: string | null;
    renderSection: RenderSection;
}>) {
    const leadCardId = props.leadCardId ?? null;
    const { sections, readingIds } = React.useMemo(() => firstRunOrder(props.sections, leadCardId), [leadCardId, props.sections]);
    return (
        <>
            {buildSlots(sections).map((slot) => {
                if (slot.kind === 'cards') return <CardRow key={slot.key} slot={slot} leadCardId={leadCardId} renderSection={props.renderSection} />;
                const block = props.renderSection(slot.entry.section, slot.entry.index, { ownsRow: false, inRowOfThree: false, leads: false });
                return readingIds.has(slot.entry.section.id)
                    ? <HomeHubReadingColumn key={slot.key}>{block}</HomeHubReadingColumn>
                    : <React.Fragment key={slot.key}>{block}</React.Fragment>;
            })}
        </>
    );
}
