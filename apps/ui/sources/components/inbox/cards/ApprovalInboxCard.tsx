import * as React from 'react';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';

import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useSession, useSessionListRenderableWithServerScope } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveApprovalHomeServerId } from '@/components/approvals/approvalHomeServerId';
import { resolveApprovalRequestTitle } from '@/components/approvals/approvalRequestTitle';
import {
  describeUnnamedApprovalSession,
  resolveApprovalHomeName,
} from '@/components/approvals/approvalRequesterLabels';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { InboxWorkRow } from '../InboxWorkRow';
import { InboxRelativeTime } from '../InboxRelativeTime';
import { RoundButton } from '@/components/ui/buttons/RoundButton';

export const ApprovalInboxCard = React.memo((props: Readonly<{
  artifact: DecryptedArtifact;
  onPress: () => void;
  /** Testable awareness-projection time. */
  nowMs?: number;
  showDivider?: boolean;
  /** The Inbox spans several Homes, so a row names the Home its session lives on. */
  showHome?: boolean;
  /** The request whose detail is open beside the list. */
  selected?: boolean;
  density?: 'comfortable' | 'cozy' | 'compact' | 'tight';
  /**
   * The rail popover's inline answer (lab `inbox-I2`): one bordered action that opens the request.
   * An approval is never decided from a row; the page shows what would run first.
   */
  inlineActionLabel?: string;
}>): React.ReactElement => {
  const { theme } = useUnistyles();

  const storedTitle = props.artifact.header?.title ?? props.artifact.title ?? t('approvals.untitled');
  const actionIdRaw = typeof props.artifact.header?.actionId === 'string' ? String(props.artifact.header.actionId).trim() : '';
  const qualifiedActionId = typeof props.artifact.header?.qualifiedActionId === 'string'
    ? props.artifact.header.qualifiedActionId.trim()
    : '';
  const sessionId = typeof props.artifact.header?.sessionId === 'string' ? props.artifact.header.sessionId.trim() : '';
  // This device's profile for the Home that asked (the request may record another device's id).
  const serverId = resolveApprovalHomeServerId(props.artifact.header);
  const legacySession = useSession(serverId ? '' : sessionId);
  const scopedSession = useSessionListRenderableWithServerScope(serverId || null, serverId ? sessionId : '');
  const session = serverId ? scopedSession : legacySession;
  const nowMs = React.useMemo(() => props.nowMs ?? Date.now(), [props.nowMs, session]);

  // The one title rule shared with the approval page.
  const { title, actionTitle } = React.useMemo(() => resolveApprovalRequestTitle({
    storedTitle: String(storedTitle),
    actionId: actionIdRaw,
    qualifiedActionId,
    sessionIds: [sessionId],
  }), [actionIdRaw, qualifiedActionId, sessionId, storedTitle]);

  // A locked session's cached name stays private, as on every other approval surface.
  const encryption = session && serverId ? projectUiSessionAwareness(session, nowMs).encryption : null;
  const sessionTitle = session && (!serverId || (encryption !== null && encryption !== 'unknown' && isSessionAwarenessContentReadableV1(encryption)))
    ? getSessionName(session, serverId)
    : null;
  // What tells this request from its siblings, on one line like every other Inbox row: the Action's
  // name when the title does not already say it, the session that asked (by name, or by where it
  // lives when this device does not have it; never its id, its Home's address or its folder path),
  // the Home only when the Inbox spans several, and when it was asked. Every row here needs an
  // approval, so those words are the line only when nothing else is known; a screen reader always
  // hears them.
  const isFact = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim().length > 0;
  const homeName = resolveApprovalHomeName(serverId);
  const askingSession = sessionTitle ?? (sessionId ? describeUnnamedApprovalSession(homeName) : null);
  const distinguishingFacts = [
    actionTitle && actionTitle !== title ? actionTitle : null,
    askingSession,
    props.showHome === true && sessionTitle ? homeName : null,
  ].filter(isFact);
  const needsApproval = t('inbox.work.rows.approvalNeeded');
  const accessibilityLabel = joinHappierFacts(...[title, needsApproval, ...distinguishingFacts].filter(isFact));

  return (
    <InboxWorkRow
      testID={`inbox.approval.${props.artifact.id}`}
      title={title}
      facts={distinguishingFacts.length > 0 ? distinguishingFacts : [needsApproval]}
      time={props.artifact.createdAt > 0 ? <InboxRelativeTime timestamp={props.artifact.createdAt} nowMs={props.nowMs} /> : null}
      // The same leading column as the session and run rows it sits between.
      mark={<Icon name="shield-check" size={18} color={theme.colors.text.secondary} />}
      accessibilityLabel={accessibilityLabel}
      onPress={props.onPress}
      trailingAccessory={props.inlineActionLabel ? (
        <RoundButton
          testID={`inbox.approval.${props.artifact.id}.review`}
          size="small"
          display="secondary"
          title={props.inlineActionLabel}
          onPress={props.onPress}
        />
      ) : undefined}
      selected={props.selected === true}
    />
  );
});

ApprovalInboxCard.displayName = 'ApprovalInboxCard';
