import * as React from 'react';
import type { SelectionListOption, SelectionListSectionDescriptor } from '@/components/ui/selectionList';

type OfflineFoldCopy = Readonly<{
  label: (count: number) => string;
  detail: string;
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  accessory: React.ReactNode;
}>;

/** Fold several offline-only Machines in place; a lone one and other refusals stay named. */
export function foldOfflineWorkers(
  sections: ReadonlyArray<SelectionListSectionDescriptor>,
  isOffline: (option: SelectionListOption) => boolean,
  copyForSection: (sectionId: string) => OfflineFoldCopy,
): SelectionListSectionDescriptor[] {
  return sections.map((section) => {
    if (section.kind !== 'static') return section;
    const folded = section.options.filter(isOffline);
    if (folded.length < 2) return section;
    const copy = copyForSection(section.id);
    const foldedIds = new Set(folded.map((option) => option.id));
    const fold: SelectionListOption = {
      id: `offline:${section.id}`,
      label: copy.label(folded.length),
      subtitle: copy.detail,
      searchText: folded.flatMap(option => [option.label, option.subtitle, option.searchText].filter(Boolean)).join('\n'),
      icon: copy.icon,
      rightAccessory: copy.accessory,
      onSelect: copy.onToggle,
    };
    return {
      ...section,
      options: [
        ...section.options.filter((option) => !foldedIds.has(option.id)),
        fold,
        ...(copy.open ? folded : []),
      ],
    };
  });
}

/** Keep expansion local to its section so a lower disclosure never inserts rows above itself. */
export function useOfflineWorkerSectionState(): (sectionId: string) => Pick<OfflineFoldCopy, 'open' | 'onToggle'> {
  const [openSectionIds, setOpenSectionIds] = React.useState<ReadonlySet<string>>(() => new Set());
  return React.useCallback((sectionId: string) => ({
    open: openSectionIds.has(sectionId),
    onToggle: () => setOpenSectionIds((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    }),
  }), [openSectionIds]);
}
