import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveAccountActorAvatar } from '@/sync/domains/account/accountActorPresentation';
import {
  readDiscussionExternalSource,
  resolveDiscussionWorkflowAttribution,
} from './discussionTimelineProjection';

export type DiscussionSpeakerKind =
  | 'person'
  | 'agent'
  | 'workflow'
  | 'external';

/** Who speaks a Discussion message: a person, an Agent (by its Session), a Workflow Run, or an outside channel sender. */
export function resolveDiscussionSpeakerKind(
  message: Pick<DiscussionOpenedMessageV1, 'producerV1' | 'content'>,
): DiscussionSpeakerKind {
  if (message.producerV1?.kind === 'agent') return 'agent';
  if (resolveDiscussionWorkflowAttribution(message)) return 'workflow';
  return readDiscussionExternalSource(message) ? 'external' : 'person';
}

/**
 * A message's face, wherever a Discussion message is drawn (the thread, a Doc's margin). The asking person's
 * Account stamps an Agent answer and a Run's result, but neither is that person speaking: they wear the
 * Agent's own mark or the Run's (lab T2-A). An inbound channel message wears the channel mark, never a member's face.
 */
export const DiscussionSpeakerFace = React.memo(function DiscussionSpeakerFace(
  props: Readonly<{
    message: Pick<DiscussionOpenedMessageV1, 'producerV1' | 'content' | 'accountActor' | 'authorAccountId'>;
    serverId: string;
    viewerAccountId: string;
    /** The speaking Session's Agent, when the caller's Session projection can see it. */
    agentId: string | null;
    /** The face's box, and the mark drawn inside it for a speaker who is not a person. */
    size: number;
    markSize: number;
    testID?: (kind: DiscussionSpeakerKind) => string;
  }>,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const { message } = props;
  const kind = resolveDiscussionSpeakerKind(message);
  const testID = props.testID?.(kind);
  if (kind !== 'person') {
    return (
      <View
        testID={testID}
        style={{
          width: props.size,
          height: props.size,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {kind === 'agent' && props.agentId ? (
          <SessionAgentCatalogIdentityIcon
            agentId={props.agentId}
            machineId={null}
            serverId={props.serverId}
            size={props.markSize}
          />
        ) : kind === 'workflow' ? (
          <Icon
            name="tree-structure"
            size={props.markSize}
            color={theme.colors.text.secondary}
          />
        ) : kind === 'external' ? (
          <Icon
            name="chats-circle"
            size={props.markSize}
            color={theme.colors.text.secondary}
          />
        ) : (
          <AgentIcon agentId={null} size={props.markSize} />
        )}
      </View>
    );
  }
  const actor = message.accountActor;
  const faceAccountId = message.authorAccountId;
  if (!faceAccountId) return null;
  const avatar = resolveAccountActorAvatar(
    { serverId: props.serverId, accountId: faceAccountId },
    actor?.accountId === faceAccountId ? { ...actor, serverId: props.serverId } : null,
    { serverId: props.serverId, accountId: props.viewerAccountId },
  );
  return (
    <View testID={testID}>
      <Avatar
        id={avatar.id}
        imageUrl={avatar.imageUrl ?? null}
        size={props.size}
      />
    </View>
  );
});
