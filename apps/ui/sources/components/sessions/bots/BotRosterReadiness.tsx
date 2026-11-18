import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { presentSessionReadiness } from '@/components/sessions/model/sessionReadinessPresentation';
import { useSessionReadiness } from '@/components/sessions/model/useSessionReadiness';
import { SessionReadinessChecklist } from '@/components/sessions/readiness/SessionReadinessChecklist';
import { CollectionRowFooter } from '@/components/ui/lists/collection/CollectionRowContent';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * A quiet Bot's readiness under its roster row, once the person asked the roster to check
 * (the roster's one "Idle Bots not checked for readiness · Check" line). A ready Bot says nothing; one that is
 * not ready says its state, its one cause and the prerequisites. Nothing is read before that ask,
 * so opening the roster never wakes a machine.
 */
export const BotRosterReadiness = React.memo(function BotRosterReadiness(props: Readonly<{
  accountLifetime: ServerAccountScopeLifetime;
  sessionId: string;
}>) {
  const state = useSessionReadiness({ accountLifetime: props.accountLifetime, sessionId: props.sessionId, enabled: true });
  const presentation = presentSessionReadiness({
    readiness: state.readiness,
    repair: state.repair,
    demanded: true,
    loading: state.loading,
    unavailableReason: state.unavailableReason,
  });
  const { refresh } = state;
  const retry = React.useCallback(() => fireAndForget(refresh(), { tag: 'BotRosterReadiness.retry' }), [refresh]);
  const failed = !state.readiness && !state.loading && state.unavailableReason !== null;
  const ready = presentation.tone === 'ready';
  return (
    <CollectionRowFooter testID={`bots-roster.readiness:${props.sessionId}`}>
      {ready ? null : (
        <View style={styles.line} accessibilityLiveRegion="polite">
          <Text
            variant="meta"
            numberOfLines={2}
            style={[styles.text, presentation.tone === 'attention' ? styles.attention : null]}
          >
            {joinHappierFacts(presentation.title, presentation.cause)}
          </Text>
          {failed ? (
            <TextLinkButton
              testID={`bots-roster.readiness-check:${props.sessionId}`}
              size="meta"
              label={t('common.retry')}
              onPress={retry}
            />
          ) : null}
        </View>
      )}
      {state.readiness && !ready ? (
        <SessionReadinessChecklist
          readiness={state.readiness}
          presentation={presentation}
          scope={props.accountLifetime.scope}
          sessionId={props.sessionId}
          testID={`bots-roster.readiness-checklist:${props.sessionId}`}
        />
      ) : null}
    </CollectionRowFooter>
  );
});

const styles = StyleSheet.create((theme) => ({
  line: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  text: { flex: 1, minWidth: 0, color: theme.colors.text.secondary },
  attention: { color: theme.colors.state.warning.textForeground },
}));
