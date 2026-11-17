import * as React from 'react';
import type { SurfaceAddress } from '@happier-dev/plugin-sdk/ui';
import { useHappierThemeSurfaceOverridesEnabled } from '@happier-dev/plugin-ui/presentation';
import { themeSurfaceStyles } from '@/theme/css/themeSurfaceStyles';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierCollectionConditionEditor,
  type HappierCollectionConditionEditorHost,
  type HappierCollectionConditionEditorLabels,
  type HappierCollectionConditionEditorProps,
  type HappierCollectionConditionIcon,
  type HappierCollectionConditionTextRole,
} from '@happier-dev/plugin-ui/components';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
  title: {
    ...Typography.variant('body', 'semiBold'),
    color: theme.colors.text.primary,
  },
  field: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  operator: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  value: {
    ...Typography.variant('meta'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  join: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
  action: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  count: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  option: { ...Typography.variant('body'), color: theme.colors.text.primary },
  groupTitle: {
    ...Typography.variant('meta', 'medium'),
    color: theme.colors.text.tertiary,
  },
  empty: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
}));

function conditionTextStyle(role: HappierCollectionConditionTextRole) {
  switch (role) {
    case 'title': return stylesheet.title;
    case 'field': return stylesheet.field;
    case 'operator': return stylesheet.operator;
    case 'value': return stylesheet.value;
    case 'join': return stylesheet.join;
    case 'action': return stylesheet.action;
    case 'count':
    case 'optionCount': return stylesheet.count;
    case 'option': return stylesheet.option;
    case 'groupTitle': return stylesheet.groupTitle;
    case 'empty': return stylesheet.empty;
  }
}

function ConditionText(props: Readonly<{
  role: HappierCollectionConditionTextRole;
  surface?: SurfaceAddress;
  numberOfLines?: number;
  accessibilityRole?: 'header';
  testID?: string;
  children: React.ReactNode;
}>) {
  const enabled = useHappierThemeSurfaceOverridesEnabled();
  return (
    <Text
      {...(props.surface ? { dataSet: { ...props.surface, state: props.surface.state ?? 'default' } } : {})}
      style={[conditionTextStyle(props.role), themeSurfaceStyles.surface(enabled ? props.surface : undefined)]}
      numberOfLines={props.numberOfLines}
      accessibilityRole={props.accessibilityRole}
      accessibilityLiveRegion={props.role === 'count' ? 'polite' : undefined}
      testID={props.testID}
    >
      {props.children}
    </Text>
  );
}

const EDITOR_ICONS: Readonly<Record<HappierCollectionConditionIcon, IconName>> =
  {
    remove: 'x',
    check: 'check',
  };

function ConditionIcon(
  props: Readonly<{ name: HappierCollectionConditionIcon }>,
) {
  const { theme } = useUnistyles();
  return (
    <Icon
      name={EDITOR_ICONS[props.name]}
      size={ICON_SIZE.xs}
      color={theme.colors.text.secondary}
    />
  );
}

function ConditionSearch(
  props: Readonly<{
    value: string;
    onChangeText: (text: string) => void;
    placeholder: string;
    testID?: string;
    style: unknown;
  }>,
) {
  return (
    <View style={props.style as never}>
      <CompactSearchField
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        accessibilityLabel={props.placeholder}
        testID={props.testID}
        autoFocus
      />
    </View>
  );
}

function ConditionButton(
  props: Readonly<{
    label: string;
    tone: 'default' | 'primary';
    disabled?: boolean;
    onPress: () => void;
    testID?: string;
  }>,
) {
  return (
    <ToolbarButton
      label={props.label}
      tone={props.tone}
      disabled={props.disabled}
      onPress={props.onPress}
      testID={props.testID}
    />
  );
}

function useConditionColors() {
  const { theme } = useUnistyles();
  return {
    fill: theme.colors.surface.selected,
    fillHover: theme.colors.surface.selectedFocused,
    divider: theme.colors.border.subtle,
    focus: theme.colors.border.focus,
  };
}

const ConditionFieldIconsContext = React.createContext<Readonly<Record<string, IconName>> | null>(null);

/** A field its list names no mark for (a plugin's field) still keeps the field rows' one anatomy. */
const DEFAULT_CONDITION_FIELD_ICON: IconName = 'funnel-simple';

function ConditionFieldIcon(props: Readonly<{ fieldId: string }>) {
  const { theme } = useUnistyles();
  const name = React.useContext(ConditionFieldIconsContext)?.[props.fieldId] ?? DEFAULT_CONDITION_FIELD_ICON;
  return <Icon name={name} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />;
}

const APP_CONDITION_HOST: HappierCollectionConditionEditorHost = Object.freeze({
  Text: ConditionText,
  Icon: ConditionIcon,
  FieldIcon: ConditionFieldIcon,
  SearchField: ConditionSearch,
  Button: ConditionButton,
  useColors: useConditionColors,
});

export type CollectionConditionEditorProps = Omit<HappierCollectionConditionEditorProps, 'host'> &
  Readonly<{
    /** Each field's mark in Add filter, from the app's one icon family. */
    fieldIcons?: Readonly<Record<string, IconName>>;
  }>;

/**
 * The shared condition editor (`@happier-dev/plugin-ui` `HappierCollectionConditionEditor`) on the app's
 * text, glyphs, search field and buttons. Every app list that edits a filter draws this one body.
 */
export const CollectionConditionEditor = React.memo(function CollectionConditionEditor(
  props: CollectionConditionEditorProps,
) {
  const { fieldIcons, ...editor } = props;
  return (
    <ConditionFieldIconsContext.Provider value={fieldIcons ?? null}>
      <HappierCollectionConditionEditor {...editor} host={APP_CONDITION_HOST} />
    </ConditionFieldIconsContext.Provider>
  );
});

/** The editor's own words (Filter · Clear, Add filter, operators, the count), the same in every list. */
export function buildCollectionConditionEditorLabels(): HappierCollectionConditionEditorLabels {
  return {
    title: t('sessionsList.conditionTitle'),
    clear: t('sessionsList.conditionClear'),
    add: t('sessionsList.conditionAdd'),
    addSearch: t('sessionsList.conditionAddSearch'),
    or: t('sessionsList.conditionOr'),
    operators: {
      is: t('sessionsList.conditionOpIs'),
      is_not: t('sessionsList.conditionOpIsNot'),
      before: t('sessionsList.conditionOpBefore'),
      after: t('sessionsList.conditionOpAfter'),
      between: t('sessionsList.conditionOpBetween'),
      unavailable: t('sessionsList.conditionUnavailable'),
    },
    remove: (field: string) => t('sessionsList.conditionRemove', { field }),
    count: (count: number) => t('sessionsList.filtersResultCount', { count }),
    countPartial: (count: number) => t('sessionsList.conditionCountPartial', { count }),
    saveAsSpace: t('sessionsList.spacesSaveAs'),
    done: t('sessionsList.filtersDone'),
    noFields: t('sessionsList.conditionNoFields'),
    noValues: t('sessionsList.filtersNoOptions'),
  };
}
