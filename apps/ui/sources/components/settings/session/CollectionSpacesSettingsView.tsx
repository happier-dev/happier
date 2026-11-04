import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
  COLLECTION_SPACE_ENABLEMENT_SETTING_KEYS_V1,
  CollectionEntityKindV1Schema,
  createDefaultCollectionSpaceV1,
  type CollectionEntityKindV1,
} from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';

import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { resolveCollectionSpaceIconName } from '@/components/ui/lists/collection/CollectionSpacesStrip';
import { useCollectionSpaceBinding } from '@/components/ui/lists/collection/useCollectionSpaceBinding';
import { useCollectionSpaceEditing } from '@/components/ui/lists/collection/useCollectionSpaceEditing';
import { useCollectionSpaceReorderBinding } from '@/components/ui/lists/collection/collectionSpaceReorder';
import { useSetCollectionSpacesEnabled } from '@/components/ui/lists/collection/useSetCollectionSpacesEnabled';
import { useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import {
  EntityFlatReorderList,
  EntityFlatReorderRow,
} from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { t } from '@/text';

import { collectionSpaceSettingRefs, collectionSpacesManageHref } from './collectionSpaceSettings';

function defaultName(entityKind: CollectionEntityKindV1) {
  return t(entityKind === 'sessionWork' ? 'sessionsList.filtersMyWork'
    : entityKind === 'workflow' ? 'sessionsList.spacesAllWorkflows' : 'sessionsList.spacesAllDiscussions');
}
function manageTitle(entityKind: CollectionEntityKindV1) {
  return t(entityKind === 'sessionWork' ? 'sessionsList.spacesManageSessions'
    : entityKind === 'workflow' ? 'sessionsList.spacesManageWorkflows' : 'sessionsList.spacesManageDiscussions');
}
const LEADING_STYLE = { flexDirection: 'row', alignItems: 'center' } as const;
const NO_SUGGESTION = {
  name: '',
  icon: { kind: 'icon', name: 'list' },
} as const;
const NO_SUMMARY: readonly string[] = [];

/** The entity a Manage spaces link names (`?entity=`); Sessions when absent or unknown. */
export function readManagedCollectionEntity(
  value: unknown,
): CollectionEntityKindV1 {
  const parsed = CollectionEntityKindV1Schema.safeParse(
    Array.isArray(value) ? value[0] : value,
  );
  return parsed.success ? parsed.data : 'sessionWork';
}

/** The list's switch subtitle: what the list shows now, and what turning it on does while every list is off. */
function listSwitchDescription(masterEnabled: boolean, listEnabled: boolean) {
  return !masterEnabled ? t('sessionsList.spacesListMasterOffDescription')
    : listEnabled ? t('sessionsList.spacesListEnabledDescription') : t('sessionsList.spacesListDisabledDescription');
}

/**
 * The page's switches, above its spaces: Sessions' page also carries the Account-wide switch (its search
 * anchor opens here). While every list is off, Sessions shows only that switch; another entity's page keeps its
 * own switch, which brings spaces back. Both write the same declarations as the list's title menu.
 */
function SpacesSwitches<K extends CollectionEntityKindV1>(props: Readonly<{
  entityKind: K;
  /** The binding's effective decision for this list. */
  spacesEnabled: boolean;
  /** This list's own preference, for its description. */
  listEnabled: boolean;
}>) {
  const { entityKind } = props;
  const refs = collectionSpaceSettingRefs(entityKind);
  const [masterEnabled, setMasterEnabled] = useSettingMutable('collectionSpacesEnabled');
  const setListEnabled = useSetCollectionSpacesEnabled(entityKind);
  const listValue = props.spacesEnabled;
  const showList = entityKind !== 'sessionWork' || masterEnabled;
  return (
    <ItemGroup>
      {entityKind === 'sessionWork' ? (
        <SettingAnchor setting={refs.masterEnabled}>
          <Item
            testID="collection-spaces-settings.master"
            title={t(refs.masterEnabled.titleKey)}
            subtitle={masterEnabled ? t('sessionsList.spacesEnabledDescription') : t('sessionsList.spacesDisabledDescription')}
            rightElement={<Switch testID="collection-spaces-settings.master-switch" value={masterEnabled} onValueChange={setMasterEnabled} />}
            showChevron={false}
            onPress={() => setMasterEnabled(!masterEnabled)}
          />
        </SettingAnchor>
      ) : null}
      {showList ? (
        <SettingAnchor setting={refs.enabled}>
          <Item
            testID="collection-spaces-settings.list"
            title={t(refs.enabled.titleKey)}
            subtitle={listSwitchDescription(masterEnabled, props.listEnabled)}
            rightElement={<Switch testID="collection-spaces-settings.list-switch" value={listValue} onValueChange={setListEnabled} />}
            showChevron={false}
            onPress={() => setListEnabled(!listValue)}
          />
        </SettingAnchor>
      ) : null}
    </ItemGroup>
  );
}

/**
 * Manage spaces (Settings → Sessions → Spaces, lab `clctx:settings`): this list's spaces switches, then its
 * saved spaces in their strip order. A row opens the same edit form as the list header (rename, icon, needs-you scope, delete or reset);
 * each row's grip moves it with a drag, the move chooser or the keyboard (the strip's accessible alternative),
 * through the same `settings.invoke` reorder intent. Selection never changes here.
 */
export const CollectionSpacesSettingsView = React.memo(
  function CollectionSpacesSettingsView(
    props: Readonly<{
      entityKind?: CollectionEntityKindV1;
    }>,
  ) {
    const params = useLocalSearchParams<{ entity?: string }>();
    const entityKind =
      props.entityKind ?? readManagedCollectionEntity(params.entity);
    return <ManagedSpaces key={entityKind} entityKind={entityKind} />;
  },
);

function ManagedSpaces<K extends CollectionEntityKindV1>(
  props: Readonly<{ entityKind: K }>,
) {
  const { entityKind } = props;
  const { theme } = useUnistyles();
  const name = defaultName(entityKind);
  const defaultFilter = React.useMemo(
    () => createDefaultCollectionSpaceV1(entityKind).filter,
    [entityKind],
  );
  const binding = useCollectionSpaceBinding(entityKind, {
    defaultName: name,
    defaultFilter,
  });
  const spaces = binding.spaces;
  const listEnabled = useSetting(COLLECTION_SPACE_ENABLEMENT_SETTING_KEYS_V1[entityKind]);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const editingSpace = spaces.find((space) => space.id === editingId) ?? null;
  const anchorRef = React.useRef<View | null>(null);
  const editing = useCollectionSpaceEditing({
    entityKind,
    testIDPrefix: 'collection-spaces-settings',
    serverId: binding.spaceSettingsScope?.serverId ?? null,
    spaces,
    selectedSpace: editingSpace,
    // Editing a space here changes its name, icon and scope, never its conditions.
    currentFilter: editingSpace?.filter ?? defaultFilter,
    suggestion: NO_SUGGESTION,
    summary: NO_SUMMARY,
    everywhereChoice: entityKind === 'sessionWork',
    anchorRef,
  });
  const { openEdit } = editing;
  const reorder = useCollectionSpaceReorderBinding({
    entityKind,
    spaces,
    invoke: editing.invoke,
    enabled: binding.spacesReady && spaces.length > 1,
  });
  const refs = collectionSpaceSettingRefs(entityKind);
  return (
    <ItemList style={{ paddingTop: 0 }} testID="collection-spaces-settings">
      <SettingsPageHeader
        title={manageTitle(entityKind)}
        description={t('sessionsList.spacesManageDescription')}
      />
      {binding.spacesReady ? <SpacesSwitches entityKind={entityKind} spacesEnabled={binding.spacesEnabled} listEnabled={listEnabled} /> : null}
      <SettingAnchor setting={refs.spaces}>
        <EntityFlatReorderList
          binding={reorder}
          testID="collection-spaces-settings.reorder"
        >
          <ItemGroup>
            {spaces.map((space) => (
              <EntityFlatReorderRow key={space.id} id={space.id}>
                {({ renderHandle }) => (
                  <View
                    ref={space.id === editingId ? anchorRef : undefined}
                    collapsable={false}
                  >
                    <Item
                      testID={`collection-spaces-settings:${space.id}`}
                      title={space.name}
                      leftElement={
                        <View style={LEADING_STYLE}>
                          {renderHandle(
                            `collection-spaces-settings.move:${space.id}`,
                          )}
                          <Icon
                            name={resolveCollectionSpaceIconName(space.icon)}
                            size={ICON_SIZE.md}
                            color={theme.colors.text.secondary}
                          />
                        </View>
                      }
                      showChevron={false}
                      rightElement={
                        <IconButton
                          testID={`collection-spaces-settings.edit:${space.id}`}
                          accessibilityLabel={t('sessionsList.spacesEditNamed', { name: space.name })}
                          tooltip={t('sessionsList.spacesEdit')}
                          variant="plain"
                          iconName="pencil-simple"
                          iconSize={ICON_SIZE.sm}
                          onPress={() => {
                            setEditingId(space.id);
                            openEdit();
                          }}
                        />
                      }
                    />
                  </View>
                )}
              </EntityFlatReorderRow>
            ))}
          </ItemGroup>
        </EntityFlatReorderList>
      </SettingAnchor>
      {editing.formOverlay}
    </ItemList>
  );
}

export default CollectionSpacesSettingsView;

/**
 * The link row into one entity's Manage spaces (lab `clctx:settings` → Spaces): it names the spaces in their
 * order and is the search anchor's row on the entity's settings page.
 */
export const CollectionSpacesSettingsSection = React.memo(function CollectionSpacesSettingsSection(props: Readonly<{
    entityKind: CollectionEntityKindV1;
}>) {
    const { entityKind } = props;
    const router = useRouter();
    const defaultFilter = React.useMemo(() => createDefaultCollectionSpaceV1(entityKind).filter, [entityKind]);
    const binding = useCollectionSpaceBinding(entityKind, { defaultName: defaultName(entityKind), defaultFilter });
    const masterEnabled = useSetting('collectionSpacesEnabled');
    const refs = collectionSpaceSettingRefs(entityKind);
    return (
        <ItemGroup title={t('sessionsList.spacesTitle')} description={t('sessionsList.spacesManageDescription')}>
            <SettingAnchor setting={refs.spaces}>
                <Item
                    testID={`collection-spaces-settings-link:${entityKind}`}
                    title={t('sessionsList.spacesTitle')}
                    icon={<Icon name="squares-four" />}
                    subtitle={!binding.spacesReady ? undefined
                        : binding.spacesEnabled ? binding.spaces.map(space => space.name).join(', ')
                            : t(masterEnabled ? 'sessionsList.spacesListDisabledDescription' : 'sessionsList.spacesDisabledDescription')}
                    onPress={() => router.push(collectionSpacesManageHref(entityKind))}
                />
            </SettingAnchor>
        </ItemGroup>
    );
});
