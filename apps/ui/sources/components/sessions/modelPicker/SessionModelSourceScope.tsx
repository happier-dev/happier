import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DaemonProviderModelProjectionHiddenSourceV1 } from '@happier-dev/protocol/rpc';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { OptionPickerPaneRow } from '@/components/sessions/pickers/OptionPickerPaneRow';
import { SELECTION_LIST_CARD_CONTENT_INSET_PX } from '@/components/ui/selectionList/_constants';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { providerConnectionSourceLabel } from '@/providers/session/resolveSessionRoutePresentation';
import { t } from '@/text';

export type SessionModelHiddenSource =
  DaemonProviderModelProjectionHiddenSourceV1;

/** One model source; null connection means this exact Agent's native models. Local picker state only. */
export type SessionModelBrowseScope = Readonly<{
  label: string;
} & ({ connectionId: string } | { connectionId: null })>;

export function sessionModelBrowseScope(
  source: SessionModelHiddenSource,
): SessionModelBrowseScope {
  return {
    connectionId: source.connectionId,
    label: providerConnectionSourceLabel(source),
  };
}

/**
 * The sources switched off for the picker, each a row that opens that source in the same pane,
 * so it stays one tap away without changing the session.
 */
export function SessionModelHiddenSources(
  props: Readonly<{
    sources: readonly SessionModelHiddenSource[];
    onBrowse: (scope: SessionModelBrowseScope) => void;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <View testID="model-picker-hidden-sources" style={styles.sources}>
      <Text accessibilityRole="header" style={styles.sourcesTitle}>{t('agentInput.model.moreSources')}</Text>
      {props.sources.map((source) => {
        const scope = sessionModelBrowseScope(source);
        return (
          <OptionPickerPaneRow
            key={source.connectionId}
            testID={`model-picker-hidden-source:${source.connectionId}`}
            title={scope.label}
            trailing={<Icon name="caret-right" size={14} color={theme.colors.text.tertiary} />}
            accessibilityLabel={t('agentInput.model.browseSource', { source: scope.label })}
            onPress={() => props.onBrowse(scope)}
          />
        );
      })}
    </View>
  );
}

/** The way back from one browsed source to every shown source; the source's name is the pane's title. */
export function SessionModelSourceBack(
  props: Readonly<{ onExit: () => void }>,
) {
  return (
    <IconButton
      testID="model-picker-source-scope-back"
      iconName="caret-left"
      variant="plain"
      size={24}
      iconSize={16}
      accessibilityLabel={t('agentInput.model.allShownSources')}
      tooltip={t('agentInput.model.allShownSources')}
      onPress={props.onExit}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  sources: { gap: theme.space.s2 },
  sourcesTitle: {
    ...Typography.variant('meta', 'medium'),
    color: theme.colors.text.secondary,
    paddingHorizontal: SELECTION_LIST_CARD_CONTENT_INSET_PX,
    paddingBottom: theme.space.s2,
  },
}));
