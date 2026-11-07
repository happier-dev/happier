import type { ReactNode } from 'react';

import { useOptionalHappierUiTypography } from '../environment/context.js';
import {
  HappierCollectionConditionTokens,
  type HappierCollectionConditionTokenChipProps,
  type HappierCollectionConditionTokensHost,
  type HappierCollectionConditionTokensProps,
} from '../presentation/collection/CollectionConditionTokens.js';
import { HappierFilterChip } from '../presentation/collection/FilterChip.js';
import { happierFocusRingStyle } from '../presentation/interaction/focusVisible.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { Icon, PluginUiIconGlyph } from './Icon.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type CollectionConditionTokensProps = Omit<HappierCollectionConditionTokensProps, 'host'>;

function ConditionChip(props: HappierCollectionConditionTokenChipProps) {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  return <HappierFilterChip gap={theme.spacing.xsmall} testID={props.testID} accessibilityRole="button"
    accessibilityLabel={[props.token.valueLabel, props.removeAccessibilityLabel].filter(Boolean).join(', ')}
    onPress={() => props.onRemove(props.token.id)}
    style={(state) => [{ borderColor: theme.colors.border, backgroundColor: state.pressed ? theme.colors.control : theme.colors.surface },
      happierFocusRingStyle({ visible: state.focused === true, color: theme.colors.focus })]}>
    <HappierText numberOfLines={1} style={[resolveHappierTypeRoleStyle('body', theme, typography, 'medium'), { color: theme.colors.text, flexShrink: 1 }]}>{props.token.valueLabel}</HappierText>
    <PluginUiIconGlyph name="close" size={12} tone="secondary" />
  </HappierFilterChip>;
}
function SaveText(props: Readonly<{ children: ReactNode }>) {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  return <HappierText style={[resolveHappierTypeRoleStyle('meta', theme, typography, 'semiBold'), { color: theme.colors.secondaryText }]}>{props.children}</HappierText>;
}
function SaveIcon() {
  return <Icon name="book" size="small" tone="secondary" />;
}
function useAppearance() {
  const theme = usePluginTheme();
  return { gap: theme.spacing.small, paddingTop: theme.spacing.xsmall / 2, paddingBottom: theme.spacing.xsmall, savePaddingHorizontal: theme.spacing.xsmall, saveActive: theme.colors.control };
}
const HOST: HappierCollectionConditionTokensHost = { Chip: ConditionChip, SaveText, SaveIcon, useAppearance };

/** Removable conditions that stay visible in a narrow collection, with an optional Save action. */
export function CollectionConditionTokens(props: CollectionConditionTokensProps) {
  return <HappierCollectionConditionTokens {...props} host={HOST} />;
}
