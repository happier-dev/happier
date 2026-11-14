import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { useProjectSources } from '@/components/projects/sources/useProjectSources';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import {
  SelectionTiles,
  type SelectionTile,
} from '@/components/ui/forms/SelectionTiles';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

/** The first repository Projects shown as tiles (lab f1src "Your code", two per line); the rest stay one search away in a menu. */
const SHOWN = 4;
/** Above this many Projects the menu offers search, as the Project field does. */
const SEARCH_FROM = 8;
const NO_ROWS: readonly ProjectSourceV1[] = Object.freeze([]);

/**
 * Deploy an app → Your code: the Account's Projects that have a repository. Choosing one selects it; the host's
 * Continue opens that Project's new-Environment draft. A repository-free Project holds stored definitions only, so it
 * is reached through Already built instead. Nothing renders until the Projects have answered with a repository one.
 */
export function NewAppCodeSources(
  props: Readonly<{
    scope: ServerAccountScope;
    value: string | null;
    onChange: (projectSourceId: string | null) => void;
    /** Two per line in the dialog (owner 11-14); one on a phone (rows rule). */
    columns: 1 | 2;
    /** Lines the section up with the gallery beneath it inside the dialog card. */
    insetStyle: React.ComponentProps<typeof View>['style'];
  }>,
): React.ReactNode {
  const { state } = useProjectSources(props.scope);
  const rows = state.rows ?? NO_ROWS;
  const withCode = React.useMemo(
    () => rows.filter((row) => row.repository !== undefined),
    [rows],
  );
  const [menuOpen, setMenuOpen] = React.useState(false);
  // A Project chosen from the menu takes the last tile, so the choice is always visible and selected.
  const shown = React.useMemo(() => {
    const head = withCode.slice(0, SHOWN);
    const chosen = props.value
      ? (withCode.find((row) => row.id === props.value) ?? null)
      : null;
    return chosen && !head.includes(chosen)
      ? [...head.slice(0, SHOWN - 1), chosen]
      : head;
  }, [props.value, withCode]);
  const tiles = React.useMemo(
    (): Array<SelectionTile<string>> =>
      shown.map((row) => ({
        id: row.id,
        title: row.name,
        subtitle: t('newApp.codeSubtitle', {
          repository: row.repository!.repository.nameWithOwner,
          provider: row.repository!.provider.displayName,
        }),
        icon: 'git-branch',
      })),
    [shown],
  );
  const menuItems = React.useMemo(
    (): DropdownMenuItem[] =>
      withCode.map((row) => ({
        id: row.id,
        title: row.name,
        subtitle: row.repository!.repository.nameWithOwner,
        checked: row.id === props.value,
      })),
    [props.value, withCode],
  );
  if (withCode.length === 0) return null;
  return (
    <ItemGroup testID="newApp.code" title={t('newApp.yourCode')} surface="none">
      <View style={[styles.column, props.insetStyle]}>
        <SelectionTiles
          testIdPrefix="newApp.code"
          accessibilityLabel={t('newApp.yourCode')}
          density="compact"
          maximumColumns={props.columns}
          subtitleLines={1}
          value={props.value}
          onChange={props.onChange}
          options={tiles}
        />
        {withCode.length > SHOWN ? (
          <DropdownMenu
            testID="newApp.code.more"
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={menuItems}
            matchTriggerWidth={false}
            search={menuItems.length >= SEARCH_FROM}
            searchPlaceholder={t('capabilities.store.appPage.projectTitle')}
            selectedId={props.value ?? ''}
            onSelect={(id) => {
              setMenuOpen(false);
              if (id) props.onChange(id);
            }}
            trigger={({ toggle }) => (
              <View style={styles.more}>
                <RoundButton
                  testID="newApp.code.moreTrigger"
                  size="small"
                  display="secondary"
                  title={t('newApp.otherProject')}
                  onPress={toggle}
                />
              </View>
            )}
          />
        ) : null}
      </View>
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: { gap: theme.space.s8 },
  more: { alignItems: 'flex-start' },
}));
