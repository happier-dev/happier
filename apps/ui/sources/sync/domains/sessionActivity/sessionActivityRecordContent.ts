import type { SessionSystemRecordContent } from '@happier-dev/protocol';

import { sync } from '@/sync/sync';

/**
 * The one place the `activity` namespace's content envelope is opened.
 *
 * Every durable activity record — `workflow_run.v1`, `background_task.v1` — is stored as the same
 * provider-agnostic envelope: `{ t:'plain', v }` or `{ t:'encrypted', c }`. Reading it is four lines
 * and a decision about failure, and both of those are exactly the kind of thing that drifts when
 * each record family writes its own copy: one reader remembers to fail soft on a missing session
 * key, the next one throws into a render.
 *
 * The payload comes back as `unknown` on purpose. Validation belongs to whichever record family
 * owns the schema, so this module never grows a table of schemas and a record can never be parsed
 * as the wrong kind here.
 */
export async function openSessionActivityRecordPayload(params: Readonly<{
    sessionId: string;
    content: SessionSystemRecordContent;
}>): Promise<unknown> {
    if (params.content.t !== 'encrypted') return params.content.v;

    // Fail soft, never throw: a client without this session's key must render the compact,
    // metadata-derived view rather than crash or invent detail it cannot read.
    const sessionEncryption = sync.encryption.getSessionEncryption(params.sessionId);
    if (!sessionEncryption) return null;
    const decrypted = await sessionEncryption.decryptRaw(params.content.c);
    return decrypted ?? null;
}
