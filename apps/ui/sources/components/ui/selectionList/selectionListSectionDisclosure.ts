import * as React from 'react';

import type { SelectionListOption } from './_types';

/**
 * A collapsible section (`SelectionListSection.collapsible`) reads as ONE disclosure row, closed until pressed
 * (owner 11-16: the model picker's "Unavailable (N)"). Open, its rows follow the disclosure row in one column.
 * The list owns which sections are open; this module owns the row's identity and shape.
 */
const SECTION_DISCLOSURE_ID_PREFIX = 'selection-list-section-disclosure:';

export function selectionListSectionDisclosureOptionId(
  sectionId: string,
): string {
  return `${SECTION_DISCLOSURE_ID_PREFIX}${sectionId}`;
}

/** The section a disclosure row opens, or `null` for an ordinary option. */
export function readSelectionListSectionDisclosureSectionId(
  optionId: string | null | undefined,
): string | null {
  return typeof optionId === 'string' &&
    optionId.startsWith(SECTION_DISCLOSURE_ID_PREFIX)
    ? optionId.slice(SECTION_DISCLOSURE_ID_PREFIX.length)
    : null;
}

/** A section whose first row is its disclosure stands in one column, whatever the list's grid. */
export function isSelectionListSingleColumnSection(
  options: ReadonlyArray<Readonly<{ id: string }>>,
): boolean {
  return readSelectionListSectionDisclosureSectionId(options[0]?.id) !== null;
}

export function buildSelectionListSectionDisclosureOption(
  params: Readonly<{
    sectionId: string;
    label: string;
    open: boolean;
    onToggle: () => void;
  }>,
): SelectionListOption {
  return {
    id: selectionListSectionDisclosureOptionId(params.sectionId),
    testID: `selection-list-section-disclosure:${params.sectionId}`,
    label: params.label,
    disclosure: true,
    // The row's caret follows the section, not the selection: `always` reads as open.
    expandedContentVisibility: params.open ? 'always' : 'selected',
    onSelect: params.onToggle,
  };
}

export type SelectionListSectionDisclosures = (
  sectionId: string,
) => Readonly<{ open: boolean; onToggle: () => void }>;

/**
 * Which folded sections are open, kept per list so a lower disclosure never inserts rows above itself.
 * The one open-state owner for a list's in-place folds (the "Unavailable" folds of the model picker and of
 * Runs through).
 */
export function useSelectionListSectionDisclosures(): SelectionListSectionDisclosures {
  const [openSectionIds, setOpenSectionIds] = React.useState<
    ReadonlySet<string>
  >(() => new Set());
  return React.useCallback(
    (sectionId: string) => ({
      open: openSectionIds.has(sectionId),
      onToggle: () =>
        setOpenSectionIds((current) => {
          const next = new Set(current);
          if (next.has(sectionId)) next.delete(sectionId);
          else next.add(sectionId);
          return next;
        }),
    }),
    [openSectionIds],
  );
}
