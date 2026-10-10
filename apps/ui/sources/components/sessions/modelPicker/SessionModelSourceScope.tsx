import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DaemonProviderModelProjectionHiddenSourceV1 } from '@happier-dev/protocol/rpc';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { providerConnectionSourceLabel } from '@/providers/session/resolveSessionRoutePresentation';
import { t } from '@/text';

export type SessionModelHiddenSource =
  DaemonProviderModelProjectionHiddenSourceV1;

/** The scope a picker browses: one source, named by its connection label. Local picker state only. */
export type SessionModelBrowseScope = Readonly<{
  connectionId: string;
  label: string;
}>;

export function sessionModelBrowseScope(
  source: SessionModelHiddenSource,
): SessionModelBrowseScope {
  return {
    connectionId: source.connectionId,
    label: providerConnectionSourceLabel(source),
  };
}

/**
 * "Hidden here: Main gateway, OpenRouter · Work". Each name opens that source in the same picker,
 * so a source switched off for the picker stays one tap away without changing the session.
 */
export function SessionModelHiddenSourcesLine(
  props: Readonly<{
    sources: readonly SessionModelHiddenSource[];
    onBrowse: (scope: SessionModelBrowseScope) => void;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <View testID="model-picker-hidden-sources" style={styles.line}>
      <Icon name="eye-slash" size={12} color={theme.colors.text.tertiary} />
      <Text style={styles.meta}>{t('agentInput.model.hiddenHere')}</Text>
      {props.sources.map((source, index) => {
        const scope = sessionModelBrowseScope(source);
        return (
          <View key={source.connectionId} style={styles.linkSlot}>
            <Pressable
              testID={`model-picker-hidden-source:${source.connectionId}`}
              accessibilityRole="button"
              accessibilityLabel={t('agentInput.model.browseSource', {
                source: scope.label,
              })}
              hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
              onPress={() => props.onBrowse(scope)}
              style={({ pressed }) => (pressed ? styles.pressed : null)}
            >
              <Text style={styles.link}>{scope.label}</Text>
            </Pressable>
            {index < props.sources.length - 1 ? (
              <Text style={styles.meta}>,</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** One line under the pane header while a source is browsed: back · "Browsing <source>" · why it is not in the list. */
export function SessionModelSourceScopeBar(
  props: Readonly<{
    scope: SessionModelBrowseScope;
    onExit: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <View testID="model-picker-source-scope" style={styles.scopeBar}>
      <IconButton
        testID="model-picker-source-scope-back"
        iconName="caret-left"
        variant="plain"
        size={20}
        iconSize={14}
        accessibilityLabel={t('agentInput.model.allShownSources')}
        tooltip={t('agentInput.model.allShownSources')}
        onPress={props.onExit}
      />
      <Text style={styles.scopeText} numberOfLines={1}>
        {t('agentInput.model.browsing')}{' '}
        <Text style={styles.scopeName}>{props.scope.label}</Text>
      </Text>
      <Icon name="eye-slash" size={12} color={theme.colors.text.tertiary} />
      <Text style={styles.meta} numberOfLines={1}>
        {t('agentInput.model.hiddenFromMainPicker')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  line: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 4,
    rowGap: 2,
  },
  linkSlot: { flexDirection: 'row', alignItems: 'center' },
  meta: { fontSize: 11, color: theme.colors.text.tertiary },
  link: {
    fontSize: 11,
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  pressed: { opacity: motionTokens.press.opacitySubtle },
  scopeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    marginLeft: -4,
  },
  scopeText: {
    fontSize: 12,
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  scopeName: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
}));
