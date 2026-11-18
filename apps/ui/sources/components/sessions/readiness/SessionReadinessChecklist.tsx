import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import type {
  SessionReadinessRepairV1,
  SessionReadinessV1,
} from '@happier-dev/protocol/sessions/control/sessionReadinessV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  presentSessionReadinessChecklist,
  type SessionReadinessCheck,
  type SessionReadinessPresentation,
} from '@/components/sessions/model/sessionReadinessPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { useMachineDisplayNamesById, useSessionSelector } from '@/sync/store/hooks';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { readMachineAdministrationTargetRouteParams } from '@/sync/domains/machines/administration/targetSelection';
import { useOpenDiscussion } from '@/components/discussions/useOpenDiscussion';
import { seedDiscussionDraft } from '@/components/discussions/useDiscussionDraft';
import { buildDiscussionAccountMentionPayload } from '@/components/discussions/discussionComposerDocument';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

const GLYPH_SIZE_PX = 14;

/**
 * Both repairs need a person to finish them (a sign-in terminal, an OAuth or device step), so the
 * button presents the exact continuation in its owning sign-in surface.
 */
export function useOpenSessionReadinessRepair(scope: ServerAccountScope) {
  const router = useRouter();
  return React.useCallback(
    (repair: SessionReadinessRepairV1) => {
      if (repair.actionId === 'machines.agents.signIn.start') {
        router.push({
          pathname: '/(app)/settings/agents/[agentId]',
          params: {
            agentId: repair.input.agentId,
            machineId: repair.input.machineId,
            serverIdentityId: resolvePortableServerIdentityForRoutingId(scope.serverId) ?? undefined,
          },
        } as never);
        return;
      }
      void presentConnectSheet({ scope, service: repair.input.account.service,
        account: repair.input.account, intent: 'reconnect',
        initialMachineTarget: readMachineAdministrationTargetRouteParams({ machineId: repair.input.machineId,
          serverIdentityId: resolvePortableServerIdentityForRoutingId(scope.serverId) ?? undefined }),
      });
    },
    [router, scope.serverId, scope.accountId],
  );
}

function CheckRow(props: Readonly<{ check: SessionReadinessCheck }>) {
  const { theme } = useUnistyles();
  const { check } = props;
  const glyph = check.state === 'ok' ? 'check' : check.state === 'bad' ? 'x' : 'minus';
  return (
    <View
      style={styles.check}
      testID={`session-readiness-check.${check.id}`}
      accessible
      accessibilityLabel={`${check.title}, ${check.detail}`}
    >
      <View style={styles.glyph}>
        <Icon
          name={glyph}
          size={GLYPH_SIZE_PX}
          color={check.state === 'unknown' ? theme.colors.text.tertiary : theme.colors.text.secondary}
        />
      </View>
      <View style={styles.checkText}>
        <Text variant="body" numberOfLines={1} style={styles.title}>{check.title}</Text>
        <Text
          variant="meta"
          numberOfLines={2}
          style={check.state === 'bad' ? styles.attention : styles.detail}
        >
          {check.detail}
        </Text>
      </View>
    </View>
  );
}

/**
 * The prerequisites behind a not-ready Bot (lab K3-R), one row each, then the next step: the owner's
 * exact repair when this person may run it, otherwise who can fix it. Shared by the People pane and
 * the Bots roster so both say the same thing.
 */
export const SessionReadinessChecklist = React.memo(function SessionReadinessChecklist(props: Readonly<{
  readiness: SessionReadinessV1;
  presentation: SessionReadinessPresentation;
  /** The viewer's exact Account on the Bot's Home, and the Bot asked about. */
  scope: ServerAccountScope;
  sessionId: string;
  testID?: string;
}>) {
  const machineId = props.readiness.machine && 'machineId' in props.readiness.machine
    ? props.readiness.machine.machineId
    : null;
  const machineIds = React.useMemo(() => (machineId ? [machineId] : []), [machineId]);
  const machineNames = useMachineDisplayNamesById(machineIds);
  const checks = presentSessionReadinessChecklist(props.readiness, {
    machineName: machineId ? (machineNames[machineId] ?? null) : null,
  });
  const owner = useSessionSelector(props.sessionId, props.scope.serverId, useShallow((session) => {
    const profile = session?.ownerProfile;
    const name = profile ? formatAccountDisplayName({
      name: [profile.firstName, profile.lastName].filter(Boolean).join(' ') || null,
      username: profile.username,
    }) : null;
    return { accountId: profile?.id ?? null, name, botName: session ? getSessionName(session, props.scope.serverId) : null };
  }));
  const openRepair = useOpenSessionReadinessRepair(props.scope);
  const { repair, guidance, cause } = props.presentation;
  // Someone else's Bot: name who can fix it, and offer to ask them in a Discussion about this Bot.
  const ownerName = owner.accountId && owner.accountId !== props.scope.accountId ? owner.name : null;
  const fixLine = guidance && ownerName
    ? t('session.collaboration.readiness.ownerNamed', { name: ownerName })
    : guidance;
  const prepareNewDraft = React.useCallback((draftId: string) => {
    if (!ownerName || !owner.accountId) return;
    const reference = buildDiscussionAccountMentionPayload(owner.accountId, ownerName);
    const mention = formatInlineReferenceTokenV1(reference);
    const reason = joinHappierFacts(owner.botName, cause);
    seedDiscussionDraft({
      scope: props.scope,
      address: { kind: 'newDiscussion', draftId },
      title: t('session.collaboration.readiness.askTitle', { bot: owner.botName ?? t('session.collaboration.readiness.facts.agent') }),
      text: `${mention} ${t('session.collaboration.readiness.askBody', { reason })}`,
      mentions: [{ ...reference, start: 0, end: mention.length, tokenText: mention }],
    });
  }, [cause, owner.accountId, owner.botName, ownerName, props.scope]);
  const anchor = React.useMemo(() => ({ kind: 'session' as const, sessionId: props.sessionId }), [props.sessionId]);
  const { openNewDiscussion } = useOpenDiscussion({ address: props.scope, anchor, sourceSurface: 'collaboration', prepareNewDraft });
  const askOwner = React.useCallback(() => {
    if (ownerName && owner.accountId) openNewDiscussion();
  }, [openNewDiscussion, owner.accountId, ownerName]);
  const offerAsk = Boolean(guidance && ownerName);
  if (checks.length === 0) return null;
  return (
    <View style={styles.root} testID={props.testID ?? 'session-readiness-checklist'}>
      {checks.map((check) => <CheckRow key={check.id} check={check} />)}
      {repair || fixLine ? (
        <View style={styles.fix}>
          {fixLine ? (
            <Text variant="meta" style={[styles.detail, styles.fixText]}>{fixLine}</Text>
          ) : <View style={styles.fixText} />}
          {repair ? (
            <RoundButton
              testID="session-readiness-repair"
              size="small"
              display="secondary"
              title={repair.label}
              onPress={() => openRepair(repair.repair)}
            />
          ) : offerAsk && ownerName ? (
            <RoundButton
              testID="session-readiness-ask-owner"
              size="small"
              display="secondary"
              title={t('session.collaboration.readiness.askOwner', { name: ownerName })}
              onPress={askOwner}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.space.s8,
    paddingTop: theme.space.s4,
  },
  check: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
  },
  glyph: {
    paddingTop: theme.space.s2,
  },
  checkText: {
    flex: 1,
    minWidth: 0,
  },
  title: { color: theme.colors.text.primary },
  detail: { color: theme.colors.text.secondary },
  attention: { color: theme.colors.state.warning.textForeground },
  fix: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    paddingTop: theme.space.s4,
  },
  fixText: { flex: 1, minWidth: 0 },
}));
