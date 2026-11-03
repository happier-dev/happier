import { z } from 'zod';
import type { Server } from 'socket.io';

// Internal Socket.IO server-side event. Older servers ignore this additive wake;
// the existing Redis stream reader retains released API heartbeat producers.
export const PRESENCE_DEADLINE_EVENT = 'happier:presence-deadline:v1';
export const PresenceDeadlineNotificationSchema = z.object({
    kind: z.enum(['machine', 'session']),
    accountId: z.string().min(1),
    id: z.string().min(1),
    activeAt: z.number().finite(),
}).strict();
export type PresenceDeadlineNotification = z.infer<typeof PresenceDeadlineNotificationSchema>;

/** Every API replica receives recovery enrollment through its existing adapter. */
export function registerPresenceDeadlineNotifications(io: Pick<Server, 'on' | 'off'>,
    schedule: (observation: PresenceDeadlineNotification) => void): () => void {
    const receive = (value: unknown): void => {
        const parsed = PresenceDeadlineNotificationSchema.safeParse(value);
        if (parsed.success) schedule(parsed.data);
    };
    io.on(PRESENCE_DEADLINE_EVENT, receive);
    return () => { io.off(PRESENCE_DEADLINE_EVENT, receive); };
}
