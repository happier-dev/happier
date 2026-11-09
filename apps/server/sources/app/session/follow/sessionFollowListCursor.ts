import { z } from 'zod/mini';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { decryptString, encryptString } from '@/modules/encrypt';

const sealedCursorSchema = z.strictObject({ t: z.literal('sealed_v1'), c: z.string().check(z.minLength(1)) });

/** Candidate positions may name unreadable sources; only the server opens them. */
export function sealSessionFollowListCursor(scope: string, cursor: string): string {
    return JSON.stringify({ t: 'sealed_v1', c: encodeBase64(encryptString(['follow-list', 'v1', scope], cursor)) });
}

/** Only the server's sealed continuation may reveal a candidate position. */
export function openSessionFollowListCursor(scope: string, cursor?: string): string | undefined {
    if (cursor === undefined) return undefined;
    const sealed = sealedCursorSchema.parse(JSON.parse(cursor));
    return decryptString(['follow-list', 'v1', scope], decodeBase64(sealed.c));
}
