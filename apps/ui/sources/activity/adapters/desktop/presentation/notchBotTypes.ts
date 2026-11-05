import type { BotActivity } from '@/components/sessions/bots/botActivity';
import type { SessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

export type BotFaceSnapshot = SessionAddress & Readonly<{
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
    reply: Readonly<{ state: 'loading' | 'ready' | 'none' | 'hidden'; text: string | null }>;
    refreshing: boolean;
    reachable: boolean;
}>;
