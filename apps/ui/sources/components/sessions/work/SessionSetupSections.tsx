import * as React from 'react';
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
import { SessionTriggerHistoryScope } from '@/components/workflows/triggers/SessionTriggerHistoryScope';
import { SessionTriggersSection } from '@/components/workflows/triggers/SessionTriggersSection';
import { SessionWritesHereSection } from '@/components/workflows/triggers/SessionWritesHereSection';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { SessionContextSection } from './context/SessionContextSection';
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
      <WorkSectionPlacementProvider value="setup">
        <WorkSectionSetupDisclosureProvider value={disclosure}>
          <SessionInstructionsSection session={session} serverId={serverId} />
          <SessionMemorySection session={session} serverId={serverId} />
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
    </ItemGroup>
  );
});

/**
 * Habits (lab csinfo I2): what starts from this session, then what writes into it, as one section,
 * closing on the way to every automation of the session. `?trigger=` deep links land on its anchor.
 */
export const SessionHabitsSection = React.memo(function SessionHabitsSection(
  props: Readonly<{
    sessionId: string;
    serverId: string;
    onOpenAllAutomations?: () => void;
  }>,
) {
  return (
    <WorkSectionPlacementProvider value="page">
      <SessionTriggerHistoryScope>
        <View nativeID={SESSION_SETUP_TRIGGERS_ANCHOR_ID} collapsable={false}>
          <SessionTriggersSection sessionId={props.sessionId} serverId={props.serverId}>
            <SessionWritesHereSection sessionId={props.sessionId} serverId={props.serverId} />
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
});
