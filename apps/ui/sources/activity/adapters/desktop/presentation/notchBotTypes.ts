import type { RecentActivityMessage } from '@/activity/attention/readRecentActivityMessages';
import type { BotActivity } from '@/components/sessions/bots/botActivity';
import type { SessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

export type BotFaceSnapshot = SessionAddress & Readonly<{
    /** The admitted Account of the face's Home: the shared open menu addresses a window with it. */
    accountId: string;
    face: SessionBotFaceFacts;
    name: string;
    activity: BotActivity;
    currentLine: string | null;
    meaningfulActivityAt: number;
    live: boolean;
    agentId: string | null;
    machineId: string | null;
}>;

export type NotchBotFaces = Readonly<{ faces: readonly BotFaceSnapshot[]; overflowCount: number }>;
export type PinnedDesktopOverlayConversation = SessionAddress & Readonly<{
    accountId: string;
    reply: Readonly<{ state: 'loading' | 'ready' | 'none' | 'hidden'; messages: readonly RecentActivityMessage[] }>;
    refreshing: boolean;
    reachable: boolean;
}>;
