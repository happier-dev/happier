import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  HappierCollectionConditionTokens,
  type HappierCollectionConditionTokenChipProps,
  type HappierCollectionConditionTokensHost,
} from '@happier-dev/plugin-ui/presentation';
import type { CollectionConditionToken } from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type { CollectionConditionToken } from '@happier-dev/plugin-ui/presentation';

function CoreConditionChip(props: HappierCollectionConditionTokenChipProps) {
  const filter = React.useMemo(() => ({
    ...props.token,
    testID: props.testID,
    onClear: () => props.onRemove(props.token.id),
    clearAccessibilityLabel: props.removeAccessibilityLabel,
  }), [props.token, props.testID, props.onRemove, props.removeAccessibilityLabel]);
  return <SelectionListFilterChip filter={filter} />;
}
function CoreSaveText(props: Readonly<{ children: React.ReactNode }>) {
  const { theme } = useUnistyles();
  return <Text style={{ color: theme.colors.text.secondary, ...Typography.variant('meta', 'semiBold') }}>{props.children}</Text>;
}
function CoreSaveIcon() {
  const { theme } = useUnistyles();
  return <Icon name="bookmark-plus" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />;
}
function useCoreAppearance() {
  const { theme } = useUnistyles();
  return { gap: theme.space.s8, paddingTop: theme.space.s2, paddingBottom: theme.space.s4, savePaddingHorizontal: theme.space.s4, saveActive: theme.colors.surface.selected };
}
const HOST: HappierCollectionConditionTokensHost = { Chip: CoreConditionChip, SaveText: CoreSaveText, SaveIcon: CoreSaveIcon, useAppearance: useCoreAppearance };
const removeLabel = (field: string) => t('sessionsList.conditionRemove', { field });

/** Core typography, localization and filter-chip adapter for the shared wrapping condition row. */
export const CollectionConditionTokens = React.memo(function CollectionConditionTokens(props: Readonly<{
  testIDPrefix: string;
  tokens: readonly CollectionConditionToken[];
  onRemove: (id: string) => void;
  onSave?: () => void;
}>) {
  return <HappierCollectionConditionTokens {...props} host={HOST} labels={{ remove: removeLabel, save: t('sessionsList.spacesSaveAs') }} />;
});
