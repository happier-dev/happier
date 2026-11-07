import * as React from 'react';
import { SessionTemplateSection } from '@/components/sessions/bots/templates/SessionTemplateSection';
import { View } from 'react-native';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';

import {
  SessionRoleValueRow,
  isSessionRoleSnapshotCopiedAcrossOwners,
} from '@/components/roles/session/sessionRole';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { NavigationPlacementPinButton } from '@/components/ui/navigation/NavigationPlacementPinButton';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { RIGHT_SIDEBAR_BUILTIN_TABS } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { resolveNavigationPlacements } from '@/sync/domains/settings/mobileSurfacePinning';
import { SessionTriggerHistoryScope } from '@/components/workflows/triggers/SessionTriggerHistoryScope';
import { SessionTriggersSection } from '@/components/workflows/triggers/SessionTriggersSection';
import { SessionWritesHereSection } from '@/components/workflows/triggers/SessionWritesHereSection';
import { useSessionTriggers } from '@/components/workflows/triggers/useSessionTriggers';
import { projectScheduledWorkflowRows } from '@/components/workflows/triggers/scheduledWorkflowRows';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { SessionContextSection } from './context/SessionContextSection';
import { SessionContextLayersScope } from './context/SessionContextLayersScope';
import { SessionInstructionsSection } from './instructions/SessionInstructionsSection';
import { SessionMemorySection } from './memory/SessionMemorySection';
import { SessionNotesSection } from './roles/SessionNotesSection';
import { SessionRolesSection } from './roles/SessionRolesSection';
import { SessionVoiceSection } from './voice/SessionVoiceSection';
import {
  WorkSectionPlacementProvider,
  WorkSectionSetupDisclosureProvider,
} from './WorkSection';
import { useSessionSetupDisclosure } from './useSessionSetupDisclosure';
import { useSessionSkillCount } from '@/sync/domains/capabilities/session/useSessionCapabilities';

const skillsNavigationItems = RIGHT_SIDEBAR_BUILTIN_TABS.filter(tab => tab.id === 'skills');

function SessionSkillsRow(props: Readonly<{ sessionId: string; serverId: string; onPress?: () => void }>) {
  const count = useSessionSkillCount(props.sessionId, props.serverId);
  const { preferences } = useNavigationSurfacePlacement('sessionRail');
  const pinned = resolveNavigationPlacements(skillsNavigationItems, preferences).effectivePlacements.skills === 'pinned';
  return <Item testID="session-setup-skills" title={t('capabilities.skills.title')}
    detail={count === null ? '—' : String(count)} icon={<Icon name="lightbulb" />} onPress={props.onPress}
    rightElementOutsidePressable keepChevronWithRightElement
    rightElement={<NavigationPlacementPinButton surfaceId="sessionRail" entryId="skills" pinned={pinned}
      label={t(pinned ? 'bots.unpin' : 'bots.pin')} preferences={preferences} testID="session-setup-skills.pin" />} />;
}

/** Where `/session/[id]/triggers` brings the person: the Triggers section of the Session's Info page. */
export const SESSION_SETUP_TRIGGERS_ANCHOR_ID = 'session-setup-triggers';

/**
 * How this agent is set up (calm-shell lab csinfo I2, P2 R06): the Session's Info answers it in the
 * order you'd ask — Role · Instructions · Memory · Context · Voice · Roles · Notes. Habits (what
 * starts from this session and what writes into it) is its own section, {@link SessionHabitsSection}.
 * The Work pane keeps only what's happening.
 *
 * The sections are the same components the Work pane used to host, moved with their owners; on this
 * page they take the configuration-page section anatomy through `WorkSectionPlacementProvider`.
 */
export const SessionSetupSections = React.memo(function SessionSetupSections(
  props: Readonly<{
    session: Session;
    serverId: string;
    onOpenSkills?: () => void;
  }>,
) {
  const { session, serverId } = props;
  const inheritedFrom =
    readSessionRolesV1(readSessionOwnerMetadataView(session))?.inheritedFrom ??
    '';
  const inheritedLead = useSessionViewShellSession(inheritedFrom, serverId);
  const accountScope = useActiveServerAccountScope();
  const accountId =
    accountScope &&
    areServerProfileIdentifiersEquivalent(accountScope.serverId, serverId)
      ? accountScope.accountId
      : null;
  const copiedAtSpawn = isSessionRoleSnapshotCopiedAcrossOwners(
    session,
    inheritedLead,
    accountId,
  );
  // A Bot reads Instructions · Memory · Voice · Triggers (plan 65, D44), so the Context it inherits
  // follows its Triggers; an ordinary Session keeps Context beside the Memory it reads (lab `c-mem O`).
  const isBot = readSessionBotV1(session.metadata?.bot)?.kind === 'bot';
  const context = (
    <SessionContextSection session={session} serverId={serverId} />
  );
  const disclosure = useSessionSetupDisclosure();
  return (
    <>
    <ItemGroup
      testID="session-setup"
      title={t('sessionPages.info.setupTitle')}
      description={t('sessionPages.info.setupDescription')}
    >
      {/* The role leads, as one value row that opens its picker. */}
      <SessionRoleValueRow
        sessionId={session.id}
        serverId={serverId}
        testID="session-setup-role-value"
        icon={<Icon name="person" />}
      />
      <SessionContextLayersScope session={session} serverId={serverId}>
        <WorkSectionPlacementProvider value="setup">
          <WorkSectionSetupDisclosureProvider value={disclosure}>
            <SessionInstructionsSection session={session} serverId={serverId} />
            <SessionMemorySection session={session} serverId={serverId} />
            <SessionSkillsRow sessionId={session.id} serverId={serverId} onPress={props.onOpenSkills} />
            {isBot ? null : context}
            <SessionVoiceSection session={session} serverId={serverId} />
            {isBot ? context : null}
            <SessionRolesSection
              sessionId={session.id}
              serverId={serverId}
              copiedAtSpawn={copiedAtSpawn}
            />
            <SessionNotesSection sessionId={session.id} serverId={serverId} />
          </WorkSectionSetupDisclosureProvider>
        </WorkSectionPlacementProvider>
      </SessionContextLayersScope>
    </ItemGroup>
    {/* Template follows Setup as its own section (r2 Info Template row). */}
    <SessionTemplateSection session={session} serverId={serverId} />
    </>
  );
});

/**
 * Habits (lab csinfo I2): what starts from this session, then what writes into it, as one section,
 * closing on the way to every automation of the session. `?trigger=` deep links land on its anchor.
 */
type SessionHabitsSectionProps = Readonly<{
    sessionId: string;
    serverId: string;
    onOpenAllAutomations?: () => void;
}>;

export const SessionHabitsSection = React.memo(function SessionHabitsSection(props: SessionHabitsSectionProps) {
  const scope = useActiveServerAccountScope(props.serverId);
  return scope && areServerProfileIdentifiersEquivalent(scope.serverId, props.serverId)
    ? <SessionHabitsContent {...props} /> : null;
});

function SessionHabitsContent(props: SessionHabitsSectionProps) {
  const read = useSessionTriggers(props.sessionId);
  const destination = useWorkflowRunWindow(`destination:${props.sessionId}`);
  // Scheduled and Starts here share the Session's admitted trigger projection.
  const scheduledRows = React.useMemo(() => projectScheduledWorkflowRows(read.sets, props.sessionId)
    .filter(row => row.set.scopeSessionId !== props.sessionId), [read.sets, props.sessionId]);
  const scheduled = React.useMemo(() => ({
    available: true, rows: scheduledRows, status: read.status, retry: read.retry, serverId: props.serverId,
  }), [scheduledRows, read.status, read.retry, props.serverId]);
  const writesHereKeys = React.useMemo(() => new Set(scheduledRows.map(row => row.key)), [scheduledRows]);
  const retry = React.useCallback(() => {
    read.retry();
    if (destination.loadMoreFailed) destination.loadMore();
    else destination.retry();
  }, [read.retry, destination.loadMoreFailed, destination.loadMore, destination.retry]);
  const status = read.status === 'failed' || destination.status === 'failed' || destination.loadMoreFailed
    ? 'failed' : read.status === 'loading' || destination.status === 'loading' ? 'loading' : 'ready';
  return (
    <WorkSectionPlacementProvider value="page">
      <SessionTriggerHistoryScope>
        <View nativeID={SESSION_SETUP_TRIGGERS_ANCHOR_ID} collapsable={false}>
          <SessionTriggersSection sessionId={props.sessionId} serverId={props.serverId}
            read={{ ...read, status, retry }} excludedTriggerKeys={writesHereKeys}
            hasRetainedContent={scheduledRows.length > 0 || destination.runIds.length > 0}>
            <SessionWritesHereSection sessionId={props.sessionId} serverId={props.serverId}
              scheduled={scheduled} read={destination} />
            {props.onOpenAllAutomations ? (
              <Item
                testID="session-habits-all-automations"
                title={t('sessionPages.info.allAutomations')}
                onPress={props.onOpenAllAutomations}
              />
            ) : null}
          </SessionTriggersSection>
        </View>
      </SessionTriggerHistoryScope>
    </WorkSectionPlacementProvider>
  );
}
