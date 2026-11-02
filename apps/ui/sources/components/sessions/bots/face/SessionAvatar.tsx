import * as React from 'react';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { getSessionAvatarId } from '@/utils/sessions/sessionUtils';

import type { BotFaceMood } from './botFaceGeometry';
import { SessionBotFace } from './SessionBotFace';
import { readSessionBotFaceFacts } from './sessionBotFaceFacts';

/**
 * A Session's picture wherever a surface holds the Session itself: a Bot draws its face, any other Session its
 * generic avatar. The one place that choice is made for Session-holding surfaces (Voice, Session info, notices,
 * Habit destinations); list rows make it in `SessionListIdentity`, DTO surfaces carry `readSessionBotFaceFacts`.
 */
export const SessionAvatar = React.memo(function SessionAvatar(
  props: Readonly<{
    session: Parameters<typeof getSessionAvatarId>[0];
    serverId: string | null | undefined;
    size: number;
    /** Not live: greys a generic avatar. A Bot keeps its colour; its state is its mouth (lab R6 shell). */
    monochrome?: boolean;
    flavor?: string | null;
    mood?: BotFaceMood;
  }>,
) {
  const { session, serverId } = props;
  const facts = React.useMemo(() => readSessionBotFaceFacts(session, serverId ?? null), [session, serverId]);
  return facts ? (
    <SessionBotFace facts={facts} size={props.size} mood={props.mood} />
  ) : (
    <Avatar id={getSessionAvatarId(session, serverId)} size={props.size} monochrome={props.monochrome} flavor={props.flavor} hasUnreadMessages={false} />
  );
});
