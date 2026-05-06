import { z } from 'zod';
import {
    DirectSessionsProviderIdSchema,
    DirectSessionsSourceSchema,
} from '@happier-dev/protocol';
import type { CodexBackendMode } from '@happier-dev/agents';

const DirectSessionLinkSchema = z.object({
    directSessionV1: z.object({
        v: z.literal(1),
        providerId: DirectSessionsProviderIdSchema,
        machineId: z.string().min(1),
        remoteSessionId: z.string().min(1),
        source: DirectSessionsSourceSchema,
        lastKnownActivityAtMs: z.number().int().min(0).optional(),
        codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
    }).passthrough(),
}).passthrough();

export type DirectSessionLink = z.infer<typeof DirectSessionLinkSchema>['directSessionV1'] & {
    codexBackendMode?: CodexBackendMode;
};

export function readDirectSessionLink(metadata: unknown): DirectSessionLink | null {
    const parsed = DirectSessionLinkSchema.safeParse(metadata ?? {});
    if (!parsed.success) return null;
    return parsed.data.directSessionV1;
}
