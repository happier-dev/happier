import type { BotActivity } from '@/components/sessions/bots/botActivity';
import type { SharedActivityEntry, SharedActivityProjection } from '@/activity/delivery/sharedActivityProjection';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

export type PetCompanionTrayItem = SharedActivityEntry & Readonly<{
    actions: Readonly<{ open: true; dismiss: true; quickReply: true }>;
}>;

export type PetCompanionActivityModel = Readonly<{
    state: BotActivity;
    address: SessionAddress | null;
    sessionId: string | null;
    trayItems: readonly PetCompanionTrayItem[];
}>;

export type BuildPetCompanionActivityModelInput = Readonly<{
    projection: SharedActivityProjection;
    dismissedTrayItemKeys?: ReadonlySet<string> | readonly string[];
}>;
