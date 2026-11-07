import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  useRouter,
  type Href,
} from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { resolveSessionSectionIcon } from '@/components/sessions/organization/sessionSectionIcons';
import { useSessionSectionMenu } from '@/components/sessions/organization/useSessionSectionMenu';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { SESSION_SECTIONS_SETTINGS } from './sessionSettings';
import { SettingsReorderList } from './SettingsReorderList';
import {
  useSessionSectionRows,
  useSessionSectionsOrganizer,
  type SessionSectionsOrganizerRow,
} from './useSessionSectionsOrganizer';

type Organizer = ReturnType<typeof useSessionSectionsOrganizer>;
const sectionsRef = SESSION_SECTIONS_SETTINGS.settings.sections;

/**
 * Sections (Settings → Sessions → Sections, P5 U4): the selected Home's Account sections in their list order.
 * Each row's grip moves it (drag, move chooser or keyboard); its "…" menu renames, re-icons, archives all or
 * removes it; New section adds one at the end. Every choice is the section Action the list and agents use.
 */
export const SessionSectionsSettingsView = React.memo(
  function SessionSectionsSettingsView() {
    const organizer = useSessionSectionsOrganizer();
    const items = useRowItems(organizer.sections);
    const [menuSectionId, setMenuSectionId] = React.useState<string | null>(
      null,
    );
    return (
      <SettingsReorderList
        testID="session-sections-settings"
        items={items}
        reorder={organizer.reorder}
        retainedId={menuSectionId}
        header={
          <SettingsPageHeader
            title={t(sectionsRef.titleKey)}
            description={t('sessionsList.sectionsManageDescription')}
          />
        }
        footer={
          organizer.serverId ? (
            <ItemGroup>
              <Item
                testID="session-sections-settings.new"
                title={t('sessionsList.newSection')}
                icon={<Icon name="plus" />}
                showChevron={false}
                onPress={() => {
                  void organizer.create();
                }}
              />
            </ItemGroup>
          ) : null
        }
        wrapItems={(children) => (
          <SettingAnchor setting={sectionsRef}>{children}</SettingAnchor>
        )}
        renderRow={(row, renderHandle) => (
          <SectionRow
            row={row}
            organizer={organizer}
            renderHandle={renderHandle}
            onMenuOpenChange={(open) =>
              setMenuSectionId((current) =>
                open ? row.id : current === row.id ? null : current,
              )
            }
          />
        )}
      />
    );
  },
);

export default SessionSectionsSettingsView;

type RowItem = SessionSectionsOrganizerRow & Readonly<{ id: string }>;
function useRowItems(
  rows: readonly SessionSectionsOrganizerRow[],
): readonly RowItem[] {
  return React.useMemo(
    () => rows.map((row) => ({ ...row, id: row.sectionId })),
    [rows],
  );
}

function SectionRow(
  props: Readonly<{
    row: RowItem;
    organizer: Organizer;
    renderHandle: (testID: string) => React.ReactNode;
    onMenuOpenChange(open: boolean): void;
  }>,
) {
  const { row, organizer } = props;
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const menu = useSessionSectionMenu({
    icon: row.icon,
    displayLocked: row.locked,
    memberCount: row.memberCount,
    onRename: () => organizer.rename(row.sectionId),
    onChangeIcon: (icon) => organizer.changeIcon(row.sectionId, icon),
    onRemove: () => organizer.remove(row.sectionId),
    onArchiveAll: () => organizer.archive(row.sectionId),
  });
  const onOpenChange = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      props.onMenuOpenChange(next);
    },
    [props.onMenuOpenChange],
  );
  return (
    <Item
      testID={`session-sections-settings:${row.sectionId}`}
      title={row.title}
      showChevron={false}
      leftElement={
        <View style={LEADING_STYLE}>
          {props.renderHandle(
            `session-sections-settings.move:${row.sectionId}`,
          )}
          <Icon
            name={resolveSessionSectionIcon(row.icon)}
            size={ICON_SIZE.md}
            color={theme.colors.text.secondary}
          />
        </View>
      }
      rightElement={
        <DropdownMenu
          open={open}
          onOpenChange={onOpenChange}
          items={menu.items}
          onSelect={menu.onSelect}
          placement="bottom"
          popoverAnchorAlign="end"
          variant="slim"
          matchTriggerWidth={false}
          maxWidthCap={240}
          showCategoryTitles={false}
          separateCategories
          popoverPortalWebTarget="body"
          trigger={({ toggle }) => (
            <IconButton
              testID={`session-sections-settings.menu:${row.sectionId}`}
              accessibilityLabel={t('common.moreActions')}
              variant="plain"
              iconName="dots-three"
              iconSize={ICON_SIZE.sm}
              onPress={toggle}
            />
          )}
        />
      }
    />
  );
}

/**
 * The Sessions page's link into Sections: it names the sections in their order and is the search anchor's row there.
 */
export const SessionSectionsSettingsSection = React.memo(
  function SessionSectionsSettingsSection() {
    const router = useRouter();
    const { rows } = useSessionSectionRows();
    return (
      <ItemGroup
        title={t(sectionsRef.titleKey)}
        description={t('sessionsList.sectionsManageDescription')}
      >
        <SettingAnchor setting={sectionsRef}>
          <Item
            testID="session-sections-settings-link"
            title={t(sectionsRef.titleKey)}
            icon={<Icon name="list" />}
            subtitle={
              rows.length > 0
                ? rows.map((section) => section.title).join(', ')
                : undefined
            }
            onPress={() => router.push(SETTINGS_ROUTES.sessionSections as Href)}
          />
        </SettingAnchor>
      </ItemGroup>
    );
  },
);

const LEADING_STYLE = { flexDirection: 'row', alignItems: 'center' } as const;
