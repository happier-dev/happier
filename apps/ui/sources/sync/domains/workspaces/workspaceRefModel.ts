import { z } from 'zod';

export const WorkspaceRefV1Schema = z.object({
    id: z.string().min(1),
    serverId: z.string().min(1),
    machineId: z.string().min(1),
    rootPath: z.string().min(1),
    label: z.string().min(1).nullable().optional(),
    createdAtMs: z.number(),
    lastOpenedAtMs: z.number().nullable().optional(),
});

export type WorkspaceRefV1 = z.infer<typeof WorkspaceRefV1Schema>;
