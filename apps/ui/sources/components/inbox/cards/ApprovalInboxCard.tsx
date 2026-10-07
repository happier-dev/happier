import * as React from 'react';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { useUnistyles } from 'react-native-unistyles';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import {
  useMachine,
  useServerScopedMachine,
  useSession,
  useSessionListRenderableWithServerScope,
} from '@/sync/domains/state/storage';
import { useSessionListHomeObservations } from '@/sync/store/hooks';
import { readDisplayMachineIdForSession, readDisplayMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { Icon } from '@/components/ui/icons/Icon';
import { readApprovalSessionEndpointLabels } from '@/components/approvals/approvalEndpointLabels';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import {
  buildSessionContextFacts,
  projectSessionContextPresentation,
} from '@/sync/domains/session/presentation/sessionContextPresentation';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { WorkspacePathDisplayModeV1 } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { Item } from '@/components/ui/lists/Item';

export const ApprovalInboxCard = React.memo((props: Readonly<{
  artifact: DecryptedArtifact;
  onPress: () => void;
  /** Supplied by the Inbox's one shared audience observer; never subscribe per approval card. */
  audienceScope?: ServerAccountScope;
  /** Account workspace facts supplied once by the shared Inbox model source. */
  workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
  workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
  /** Testable awareness-projection time. */
  nowMs?: number;
  showDivider?: boolean;
  density?: 'comfortable' | 'cozy' | 'compact' | 'tight';
}>): React.ReactElement => {
  const { theme } = useUnistyles();

  const title = props.artifact.header?.title ?? props.artifact.title ?? t('approvals.untitled');
  const actionIdRaw = typeof props.artifact.header?.actionId === 'string' ? String(props.artifact.header.actionId).trim() : '';
  const qualifiedActionId = typeof props.artifact.header?.qualifiedActionId === 'string'
    ? props.artifact.header.qualifiedActionId.trim()
    : '';
  const sessionId = typeof props.artifact.header?.sessionId === 'string' ? props.artifact.header.sessionId.trim() : '';
  const serverId = typeof props.artifact.header?.serverId === 'string'
    ? props.artifact.header.serverId.trim()
    : '';
  const homeObservations = useSessionListHomeObservations();
  const legacySession = useSession(serverId ? '' : sessionId);
  const scopedSession = useSessionListRenderableWithServerScope(serverId || null, serverId ? sessionId : '');
  const session = serverId ? scopedSession : legacySession;
  const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
  const legacyDisplayTarget = serverId ? null : readDisplayMachineTargetForSession({ sessionId, metadata: ownerMetadata });
  const machineId = serverId
    ? readDisplayMachineIdForSession({ sessionId: null, metadata: ownerMetadata })
    : legacyDisplayTarget?.machineId ?? '';
  const legacyMachine = useMachine(serverId ? '' : machineId);
  const scopedMachine = useServerScopedMachine(serverId || null, serverId ? machineId : '');
  const machine = serverId ? scopedMachine : legacyMachine;
  const awareness = session ? projectUiSessionAwareness(session, props.nowMs ?? Date.now()) : null;
  const workspacePresentation = session && ownerMetadata && (!serverId || awareness?.workspace)
    ? resolveSessionWorkspaceDisplayPresentation({
        serverId: serverId || null,
        metadata: ownerMetadata,
        machineTarget: legacyDisplayTarget,
        workspaceRefs: props.workspaceRefs,
        workspacePathDisplayModeV1: props.workspacePathDisplayModeV1,
      })
    : null;
  const context = serverId && session
    ? projectSessionContextPresentation(buildSessionContextFacts({
        address: { serverId, sessionId },
        serverProfile: getServerProfileById(serverId),
        awareness,
        viewer: session.viewer,
        audienceContext: session.access?.audienceContext,
        audienceScope: props.audienceScope,
        workspaceLabel: workspacePresentation?.displayTitle ?? null,
        homeDir: ownerMetadata?.homeDir ?? null,
        // The same exact-Home currentness Session rows and Activity show, so an Inbox card from a
        // Home Happier can no longer reach reads identically (Lane 07.4 §12).
        homeObservation: homeObservations[serverId] ?? null,
        nowMs: props.nowMs ?? Date.now(),
      }))
    : null;

  const actionTitle = React.useMemo(() => {
    if (!actionIdRaw) return null;
    try {
      return getActionSpec(actionIdRaw as ActionId).title;
    } catch {
      return actionIdRaw;
    }
  }, [actionIdRaw]);

  const sessionTitle = session && (!serverId || context?.mayShowDecryptedContent === true)
    ? getSessionName(session, serverId)
    : null;
  const scopedEndpoint = serverId
    ? readApprovalSessionEndpointLabels({ session, machine, machineId })
    : null;
  const machineLabel = scopedEndpoint?.machineLabel ?? getMachineDisplayName(machine);
  const actionAccessibilityLabel = qualifiedActionId
    ? `${String(title)} · ${qualifiedActionId}`
    : actionTitle
      ? `${String(title)} · ${actionTitle}`
      : String(title);
  const accessibilityLabel = [actionAccessibilityLabel, sessionTitle, context?.accessibilityContext, machineLabel]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' · ');
  const subtitle = [
    actionTitle ?? qualifiedActionId,
    sessionTitle,
    context?.contextLine,
    machineLabel,
    serverId ? null : workspacePresentation?.displayTitle,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join('\n');

  return (
    <Item
      testID={`inbox.approval.${props.artifact.id}`}
      title={title}
      subtitle={subtitle || undefined}
      subtitleLines={5}
      icon={<Icon name="warning-circle" size={18} color={theme.colors.status.error} />}
      accessibilityLabel={accessibilityLabel}
      onPress={props.onPress}
      showDivider={props.showDivider}
      density={props.density}
    />
  );
});

ApprovalInboxCard.displayName = 'ApprovalInboxCard';
