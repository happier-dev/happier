import type { ReactElement, ReactNode } from 'react';
import type { SurfaceAddress } from '@happier-dev/plugin-sdk/ui';
import { useThemeSurfaceBinding } from '../presentation/themeSurfaceBinding.js';
import { View } from 'react-native';

import {
  HappierCollectionConditionEditor,
  type HappierCollectionConditionEditorHost,
  type HappierCollectionConditionEditorProps,
  type HappierCollectionConditionIcon,
  type HappierCollectionConditionTextRole,
} from '../presentation/collection/CollectionConditionEditor.js';
import { HappierTextField } from '../presentation/form/Fields.js';
import type { HappierStyleProp } from '../presentation/portableTypes.js';
import { HappierText } from '../presentation/text/Text.js';
import { useHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import type { HappierTypeRole } from '../presentation/text/typeScale.js';
import { Button } from './Button.js';
import { PluginUiIconGlyph, type IconName } from './Icon.js';
import { usePluginTheme } from './PluginUiProvider.js';

const TEXT: Readonly<
  Record<
    HappierCollectionConditionTextRole,
    Readonly<{
      role: HappierTypeRole;
      ink: 'text' | 'secondaryText' | 'mutedText';
    }>
  >
> = {
  title: { role: 'body', ink: 'text' },
  field: { role: 'meta', ink: 'secondaryText' },
  operator: { role: 'meta', ink: 'mutedText' },
  value: { role: 'meta', ink: 'text' },
  join: { role: 'meta', ink: 'mutedText' },
  action: { role: 'meta', ink: 'secondaryText' },
  count: { role: 'meta', ink: 'mutedText' },
  optionCount: { role: 'meta', ink: 'mutedText' },
  option: { role: 'body', ink: 'text' },
  groupTitle: { role: 'meta', ink: 'mutedText' },
  empty: { role: 'meta', ink: 'mutedText' },
};

const ICONS: Readonly<Record<HappierCollectionConditionIcon, IconName>> = {
  remove: 'close',
  check: 'check',
};

function PluginConditionText(
  props: Readonly<{
    role: HappierCollectionConditionTextRole;
    surface?: SurfaceAddress;
    numberOfLines?: number;
    accessibilityRole?: 'header';
    testID?: string;
    children: ReactNode;
  }>,
): ReactElement {
  const theme = usePluginTheme();
  const surface = useThemeSurfaceBinding(props.surface);
  const spec = TEXT[props.role];
  const style = useHappierTypeRoleStyle(spec.role, theme);
  return (
    <HappierText
      {...{ dataSet: surface.dataSet }}
      numberOfLines={props.numberOfLines}
      accessibilityRole={props.accessibilityRole}
      tabularNumbers={props.role === 'count' || props.role === 'optionCount'}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      style={[{ ...style, color: theme.colors[spec.ink], flexShrink: 1 }, surface.style]}
    >
      {props.children}
    </HappierText>
  );
}

function PluginConditionIcon(
  props: Readonly<{ name: HappierCollectionConditionIcon }>,
): ReactElement {
  return (
    <PluginUiIconGlyph name={ICONS[props.name]} size={14} tone="secondary" />
  );
}

function PluginConditionSearch(
  props: Readonly<{
    value: string;
    onChangeText: (text: string) => void;
    placeholder: string;
    testID?: string;
    style: HappierStyleProp;
  }>,
): ReactElement {
  const theme = usePluginTheme();
  return (
    <View style={props.style as never}>
      <HappierTextField
        label={props.placeholder}
        appearance="search"
        value={props.value}
        onChangeText={props.onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        theme={theme}
        {...(props.testID === undefined ? {} : { testID: props.testID })}
      />
    </View>
  );
}

function PluginConditionButton(
  props: Readonly<{
    label: string;
    tone: 'default' | 'primary';
    disabled?: boolean;
    onPress: () => void;
    testID?: string;
  }>,
): ReactElement {
  return (
    <Button
      title={props.label}
      variant={props.tone === 'primary' ? 'primary' : 'secondary'}
      size="small"
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      onPress={props.onPress}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
  );
}

function usePluginConditionColors() {
  const theme = usePluginTheme();
  return {
    fill: theme.colors.control,
    fillHover: theme.colors.elevatedSurface,
    divider: theme.colors.divider,
    focus: theme.colors.focus,
  };
}

const PLUGIN_CONDITION_HOST: HappierCollectionConditionEditorHost =
  Object.freeze({
    Text: PluginConditionText,
    Icon: PluginConditionIcon,
    SearchField: PluginConditionSearch,
    Button: PluginConditionButton,
    useColors: usePluginConditionColors,
  });

export type CollectionConditionEditorProps = Omit<
  HappierCollectionConditionEditorProps,
  'host'
>;

/**
 * The shared condition editor for a plugin page's collection: the same body Happier's own lists use,
 * over `conditionModelFromFilter(registry, filter)`. Apply each edit with `applyCollectionConditionEdit`.
 */
export function CollectionConditionEditor(
  props: CollectionConditionEditorProps,
): ReactElement {
  return (
    <HappierCollectionConditionEditor {...props} host={PLUGIN_CONDITION_HOST} />
  );
}
