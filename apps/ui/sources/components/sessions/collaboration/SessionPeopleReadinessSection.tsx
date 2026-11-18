import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { presentSessionReadiness } from '@/components/sessions/model/sessionReadinessPresentation';
import { useSessionReadiness } from '@/components/sessions/model/useSessionReadiness';
import { SessionReadinessChecklist } from '@/components/sessions/readiness/SessionReadinessChecklist';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * Whether asking this Session can work now (C7 configured vs ready), in the People pane where people
 * mention it in conversations. The pane being open is the demand: one status read, no polling. It
 * speaks only when asking can't work now: one amber cause with its repair, or who can fix it. Ready,
 * still reading or an unreadable status say nothing, because none of them asks anything of the person.
 */
export const SessionPeopleReadinessSection = React.memo(function SessionPeopleReadinessSection(props: Readonly<{
  scope: ServerAccountScope;
  sessionId: string;
}>) {
  const serverIds = React.useMemo(() => [props.scope.serverId], [props.scope.serverId]);
  const bindings = useServerCredentialAccountScopeBindings(serverIds);
  const binding = [...bindings.values()][0] ?? null;
  // Only the exact Account this pane reads as; another Account's binding never answers for it.
  if (!binding || !areServerAccountScopesEqual(binding.scope, props.scope)) return null;
  return <SessionPeopleReadinessRows accountLifetime={binding} sessionId={props.sessionId} />;
});

function SessionPeopleReadinessRows(
  props: Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    sessionId: string;
  }>,
) {
  const { theme } = useUnistyles();
  const state = useSessionReadiness({
    accountLifetime: props.accountLifetime,
    sessionId: props.sessionId,
    enabled: true,
  });
  const presentation = presentSessionReadiness({
    readiness: state.readiness,
    repair: state.repair,
    demanded: true,
    loading: state.loading,
    unavailableReason: state.unavailableReason,
  });
  const { refresh } = state;
  const checkAgain = React.useCallback(
    () => fireAndForget(refresh(), { tag: 'SessionPeopleReadiness.refresh' }),
    [refresh],
  );
  if (!state.readiness || presentation.tone !== 'attention') return null;
  const checklist = (
    <SessionReadinessChecklist
      readiness={state.readiness}
      presentation={presentation}
      scope={props.accountLifetime.scope}
      sessionId={props.sessionId}
    />
  );
  return (
    <View testID="session-people-readiness" style={styles.section}>
      <Item
        testID="session-people-readiness-row"
        density="compact"
        showDivider={false}
        showChevron={false}
        icon={
          <Icon name="robot" size={18} color={theme.colors.text.secondary} />
        }
        title={presentation.title}
        subtitle={presentation.cause ?? undefined}
        subtitleLines={2}
        subtitleStyle={styles.attention}
        accessibilityLiveRegion="polite"
        bottomElement={checklist}
        bottomElementInset="text"
        bottomElementOutsidePressable
        onPress={state.loading ? undefined : checkAgain}
        accessibilityHint={t('session.collaboration.readiness.check')}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { paddingTop: theme.space.s12 },
  attention: { color: theme.colors.state.warning.textForeground },
}));
