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
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * A quiet Bot's readiness under its roster row (lab K3-R): "Readiness not checked yet · Check" until the
 * person asks, then the state, its one cause and, short of ready, the prerequisites. Nothing is read
 * until Check, so opening the roster never wakes a machine.
 */
export const BotRosterReadiness = React.memo(function BotRosterReadiness(props: Readonly<{
  serverId: string;
  sessionId: string;
  /** Another row follows: the row's divider is drawn below this footer. */
  separator: boolean;
}>) {
  const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
  const bindings = useServerCredentialAccountScopeBindings(serverIds);
  const binding = bindings.get(props.serverId) ?? null;
  if (!binding) return null;
  return <BotRosterReadinessLine accountLifetime={binding} sessionId={props.sessionId} />;
});

function BotRosterReadinessLine(props: Readonly<{
  accountLifetime: ServerAccountScopeLifetime;
  sessionId: string;
}>) {
  const [demanded, setDemanded] = React.useState(false);
  const state = useSessionReadiness({ accountLifetime: props.accountLifetime, sessionId: props.sessionId, enabled: demanded });
  const presentation = presentSessionReadiness({
    readiness: state.readiness,
    repair: state.repair,
    demanded,
    loading: state.loading,
    unavailableReason: state.unavailableReason,
  });
  const { refresh } = state;
  const check = React.useCallback(() => {
    if (!demanded) setDemanded(true);
    else fireAndForget(refresh(), { tag: 'BotRosterReadiness.check' });
  }, [demanded, refresh]);
  const failed = demanded && !state.readiness && !state.loading && state.unavailableReason !== null;
  const offerCheck = !demanded || failed;
  return (
    <CollectionRowFooter testID={`bots-roster.readiness:${props.sessionId}`}>
      <View style={styles.line} accessibilityLiveRegion="polite">
        <Text
          variant="meta"
          numberOfLines={2}
          style={[styles.text, presentation.tone === 'attention' ? styles.attention : null]}
        >
          {!demanded ? t('session.collaboration.readiness.rosterNotChecked') : joinHappierFacts(presentation.title, presentation.cause)}
        </Text>
        {offerCheck ? (
          <TextLinkButton
            testID={`bots-roster.readiness-check:${props.sessionId}`}
            size="meta"
            label={failed ? t('common.retry') : t('session.collaboration.readiness.check')}
            onPress={check}
          />
        ) : null}
      </View>
      {state.readiness && presentation.tone !== 'ready' ? (
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
}

const styles = StyleSheet.create((theme) => ({
  line: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  text: { flex: 1, minWidth: 0, color: theme.colors.text.secondary },
  attention: { color: theme.colors.state.warning.foreground },
}));
