import { z } from 'zod/mini';
import { readSessionChooserPage } from '@/components/sessions/selection/readSessionChooserPage';
import type { SessionChooserPage, SessionChooserTarget } from '@/components/sessions/selection/sessionChooserSource';
import { readCaptureSessionChooserTarget } from './readCaptureSessionChooserTarget';

const addressSchema = z.strictObject({ serverId: z.string().check(z.trim(), z.minLength(1)), sessionId: z.string().check(z.trim(), z.minLength(1)) });
const requestSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('page'), query: z.string(), offset: z.number().check(z.int(), z.minimum(0)), limit: z.number().check(z.int(), z.minimum(1)) }),
    z.strictObject({ kind: z.literal('target'), targetSession: z.optional(addressSchema) }),
]);

/** The main renderer serves snapshots from its existing owners, never a second Sync client. */
export async function readCaptureSessionChooser(input: unknown): Promise<SessionChooserPage | SessionChooserTarget> {
    const request = requestSchema.parse(input);
    if (request.kind === 'page') return readSessionChooserPage(request);
    return readCaptureSessionChooserTarget(request);
}
