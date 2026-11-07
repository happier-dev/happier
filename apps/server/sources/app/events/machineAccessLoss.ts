import { z } from 'zod';
import type { Server } from 'socket.io';

export const MACHINE_ACCESS_LOSS_EVENT = 'happier:machine-access-loss:v1';
const machineAccessLossSchema = z.object({ accountId: z.string().min(1), machineId: z.string().min(1) }).strict();
export type MachineAccessLoss = z.infer<typeof machineAccessLossSchema>;

/** Reuse the authenticated server-side adapter path; this event is never accepted from a client socket. */
export function registerMachineAccessLossHandler(io: Pick<Server, 'on' | 'off'>, receive: (input: MachineAccessLoss) => void): () => void {
    const handler = (raw: unknown) => {
        const parsed = machineAccessLossSchema.safeParse(raw);
        if (parsed.success) receive(parsed.data);
    };
    io.on(MACHINE_ACCESS_LOSS_EVENT, handler);
    return () => { io.off(MACHINE_ACCESS_LOSS_EVENT, handler); };
}
