import * as React from 'react';
import { View } from 'react-native';

import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useLentHeaderMenuRows } from '@/components/navigation/stackHeaderActions';
import { useUnistyles } from 'react-native-unistyles';

/**
 * A view's own part of the comparison menu (Find, the diff's display choices, a walkthrough's edits). Its rows
 * are ordinary menu rows, so choosing one closes the menu like every other choice.
 */
export type ScmComparisonMenuSection = Readonly<{
  id: string;
  /** Heads the section ("Display"); the comparison's own actions lead the menu untitled. */
  title?: string;
  items: readonly DropdownMenuItem[];
  onSelect: (itemId: string) => void;
}>;

/** One section's rows as menu rows, under ids that route a choice back to its section. */
export function scmComparisonMenuSectionItems(
  section: ScmComparisonMenuSection,
  category: string,
): DropdownMenuItem[] {
  return section.items.map((item) => ({
    ...item,
    id: `section:${section.id}:${item.id}`,
    category,
  }));
}

/**
 * The rows a pane lends to the header this menu is the `⋯` of (a phone group's other pages, pin, close), as the menu's
 * last section; null when none. Only a header's own `⋯` adds it, never a bar's.
 */
export function useLentHeaderMenuSection(): ScmComparisonMenuSection | null {
  const { theme } = useUnistyles();
  const rows = useLentHeaderMenuRows();
  return React.useMemo(() => !rows || rows.length === 0 ? null : {
    id: 'lent',
    items: rows.map((row) => ({ id: row.id, testID: row.testID, title: row.title,
      icon: <Icon name={row.iconName} size={ICON_SIZE.sm} color={theme.colors.text.secondary} /> })),
    onSelect: (id) => rows.find((row) => row.id === id)?.onSelect(),
  }, [rows, theme.colors.text.secondary]);
}

/** Routes a chosen row to the section that offered it; false when no section owns the id. */
export function selectScmComparisonMenuItem(
  sections: readonly ScmComparisonMenuSection[],
  id: string,
): boolean {
  const section = sections.find((candidate) =>
    id.startsWith(`section:${candidate.id}:`),
  );
  if (!section) return false;
  section.onSelect(id.slice(`section:${section.id}:`.length));
  return true;
}

/**
 * The wide comparison bar's `⋯` (Walkthrough lab WT1/WT8): the same view-owned sections a phone lists in its
 * comparison menu, so a choice lives in one place per width and never as a loose row of buttons in the page.
 */
export const ScmComparisonMoreMenu = React.memo(function ScmComparisonMoreMenu(
  props: Readonly<{
    sections: readonly ScmComparisonMenuSection[];
    testID?: string;
    /** The gap to the neighbouring bar action: their finger frames split it. */
    interactiveTargetGapPx?: number;
  }>,
) {
  const [open, setOpen] = React.useState(false);
  const sections = props.sections;
  const titled = sections.some((section) => section.title);
  const items = React.useMemo(
    () =>
      sections.flatMap((section) =>
        scmComparisonMenuSectionItems(section, section.title ?? ''),
      ),
    [sections],
  );
  const testID = props.testID ?? 'scm-comparison-more';
  if (items.length === 0) return null;
  return (
    <DropdownMenu
      testID={`${testID}-menu`}
      open={open}
      onOpenChange={setOpen}
      items={items}
      selectedId={null}
      onSelect={(id) => {
        selectScmComparisonMenuItem(sections, id);
      }}
      search={false}
      matchTriggerWidth={false}
      maxWidthCap={280}
      placement="bottom"
      popoverAnchorAlign="end"
      showCategoryTitles={titled}
      trigger={({ toggle, open: triggerOpen }) => (
        <View>
          <IconButton
            testID={testID}
            variant="plain"
            size={28}
            iconName="dots-three"
            iconSize={18}
            selected={triggerOpen}
            expanded={triggerOpen}
            hasPopup="menu"
            accessibilityLabel={t('common.more')}
            tooltip={t('common.more')}
            onPress={toggle}
            interactiveTargetGapPx={props.interactiveTargetGapPx}
          />
        </View>
      )}
    />
  );
});
