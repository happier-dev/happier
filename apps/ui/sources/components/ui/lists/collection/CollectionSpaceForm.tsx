import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { CollectionSpaceIconV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { COLLECTION_SPACE_GLYPHS } from './collectionSpaceGlyphs';
import { CollectionSpaceIcon } from './CollectionSpaceIcon';

/** Glyphs a space can wear, from the shared icon vocabulary (lab `clfilter:save`). */


export type CollectionSpaceFormValue = Readonly<{
  name: string;
  icon: CollectionSpaceIconV1;
  includeNeedsYouEverywhere: boolean;
}>;

export type CollectionSpaceFormProps = Readonly<{
  /** `<prefix>-form`, `<prefix>-name`, `<prefix>-icon:<key>`, `<prefix>-submit`, … */
  testIDPrefix: string;
  mode: 'create' | 'edit';
  initial: CollectionSpaceFormValue;
  /** Whether the list's Needs you can draw requests from everywhere (Sessions); others keep the stored value. */
  everywhereChoice?: boolean;
  /** Icons that fit the conditions (a named project's mark) lead the glyphs. */
  suggestedIcons: readonly CollectionSpaceIconV1[];
  /** What the space keeps, one short phrase per condition. */
  summary: readonly string[];
  busy?: boolean;
  error?: string | null;
  /** The default space can be reset but never deleted. */
  deletion?: 'delete' | 'reset';
  onSubmit: (value: CollectionSpaceFormValue) => void;
  onCancel: () => void;
  onDelete?: () => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
  root: {
    width: '100%',
    minWidth: 300,
    padding: theme.space.s12,
    gap: theme.space.s8,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
  },
  nameIcon: {
    width: 24,
    alignItems: 'center',
  },
  nameField: {
    flex: 1,
    minWidth: 0,
  },
  icons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s2,
  },
  iconTile: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconTileSelected: {
    backgroundColor: theme.colors.surface.selected,
    borderWidth: 1.5,
    borderColor: theme.colors.text.primary,
  },
  summary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s6,
    paddingVertical: theme.space.s4,
  },
  summaryChip: {
    minHeight: 22,
    borderRadius: 6,
    paddingHorizontal: theme.space.s8,
    justifyContent: 'center',
    backgroundColor: theme.colors.surface.selected,
  },
  summaryText: {
    ...Typography.variant('micro'),
    color: theme.colors.text.secondary,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    paddingVertical: theme.space.s4,
  },
  switchText: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s2,
  },
  switchTitle: {
    ...Typography.variant('body', 'medium'),
    color: theme.colors.text.primary,
  },
  switchDescription: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  error: {
    ...Typography.variant('meta'),
    color: theme.colors.state.danger.textForeground,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingTop: theme.space.s4,
  },
  grow: {
    flex: 1,
  },
}));

function iconKey(icon: CollectionSpaceIconV1): string {
  return icon.kind === 'icon'
    ? `icon:${icon.name}`
    : `project:${icon.project.serverId}:${icon.project.projectKey}`;
}

/**
 * Save as space / Edit space (lab `clfilter:save`): the prefilled name, an icon, what the space keeps,
 * and whether its Needs you includes requests from everywhere. Add space puts it at the end of the
 * strip and switches to it; the form keeps its values when a save is refused.
 */
export const CollectionSpaceForm = React.memo(function CollectionSpaceForm(
  props: CollectionSpaceFormProps,
) {
  const styles = stylesheet;
  const { theme } = useUnistyles();
  const [name, setName] = React.useState(props.initial.name);
  const [icon, setIcon] = React.useState(props.initial.icon);
  const [everywhere, setEverywhere] = React.useState(
    props.initial.includeNeedsYouEverywhere,
  );
  const icons = React.useMemo(() => {
    const seen = new Set<string>();
    return [
      ...props.suggestedIcons,
      props.initial.icon,
      ...COLLECTION_SPACE_GLYPHS.map((name): CollectionSpaceIconV1 => ({
        kind: 'icon',
        name,
      })),
    ].filter((candidate) => {
      const key = iconKey(candidate);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [props.initial.icon, props.suggestedIcons]);
  const trimmed = name.trim();
  const submit = React.useCallback(() => {
    if (trimmed.length === 0 || props.busy) return;
    props.onSubmit({
      name: trimmed,
      icon,
      includeNeedsYouEverywhere: everywhere,
    });
  }, [everywhere, icon, props, trimmed]);
  const selectedKey = iconKey(icon);
  return (
    <View testID={`${props.testIDPrefix}-form`} style={styles.root}>
      <View style={styles.nameRow}>
        <View style={styles.nameIcon}>
          <CollectionSpaceIcon
            icon={icon}
            size={ICON_SIZE.md}
            color={theme.colors.text.primary}
          />
        </View>
        <FieldTextInput
          testID={`${props.testIDPrefix}-name`}
          accessibilityLabel={t('sessionsList.spacesName')}
          value={name}
          onChangeText={setName}
          autoFocus
          selectTextOnFocus
          returnKeyType="done"
          onSubmitEditing={submit}
          style={styles.nameField}
        />
      </View>
      <View
        style={styles.icons}
        accessibilityRole="radiogroup"
        accessibilityLabel={t('sessionsList.spacesIcon')}
      >
        {icons.map((candidate) => {
          const key = iconKey(candidate);
          const selected = key === selectedKey;
          return (
            <HappierPressable
              key={key}
              testID={`${props.testIDPrefix}-icon:${key}`}
              accessibilityRole="radio"
              checked={selected}
              accessibilityLabel={
                candidate.kind === 'project'
                  ? candidate.project.projectKey
                  : candidate.name
              }
              onPress={() => setIcon(candidate)}
              style={(state) => [
                styles.iconTile,
                selected
                  ? styles.iconTileSelected
                  : state.hovered || state.pressed
                    ? { backgroundColor: theme.colors.surface.selected }
                    : null,
                focusRingStyle({
                  focused: state.focused,
                  color: theme.colors.border.focus,
                }),
              ]}
            >
              <CollectionSpaceIcon
                icon={candidate}
                size={ICON_SIZE.sm}
                color={theme.colors.text.secondary}
              />
            </HappierPressable>
          );
        })}
      </View>
      {props.summary.length > 0 ? (
        <View style={styles.summary}>
          {props.summary.map((phrase, index) => (
            <View key={`${index}:${phrase}`} style={styles.summaryChip}>
              <Text style={styles.summaryText} numberOfLines={1}>
                {phrase}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {props.everywhereChoice ? (
        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.switchTitle}>
              {t('sessionsList.spacesEverywhereTitle')}
            </Text>
            <Text style={styles.switchDescription}>
              {t('sessionsList.spacesEverywhereDescription')}
            </Text>
          </View>
          <Switch
            testID={`${props.testIDPrefix}-everywhere`}
            accessibilityLabel={t('sessionsList.spacesEverywhereTitle')}
            value={everywhere}
            onValueChange={setEverywhere}
          />
        </View>
      ) : null}
      {props.error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {props.error}
        </Text>
      ) : null}
      <View style={styles.footer}>
        {props.deletion && props.onDelete ? (
          <ToolbarButton
            testID={`${props.testIDPrefix}-delete`}
            label={
              props.deletion === 'delete'
                ? t('sessionsList.spacesDelete')
                : t('sessionsList.spacesResetDefault')
            }
            tone={props.deletion === 'delete' ? 'danger' : 'default'}
            onPress={props.onDelete}
          />
        ) : null}
        <View style={styles.grow} />
        <ToolbarButton
          testID={`${props.testIDPrefix}-cancel`}
          label={t('common.cancel')}
          onPress={props.onCancel}
        />
        <ToolbarButton
          testID={`${props.testIDPrefix}-submit`}
          label={
            props.mode === 'create'
              ? t('sessionsList.spacesAdd')
              : t('sessionsList.spacesSaveChanges')
          }
          tone="primary"
          disabled={trimmed.length === 0 || props.busy === true}
          onPress={submit}
        />
      </View>
    </View>
  );
});
