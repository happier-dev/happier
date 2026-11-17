import type {
    OpenNewSessionRequest,
    OpenNewSessionOptions,
} from '@happier-dev/plugin-sdk/ui';
import { defineProtocolArray, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { openSessionInputAuthoringV1, projectSessionInputLifecycleFailureV1 } from '@happier-dev/plugin-sdk/sessions';
import { TriageSourceFailureV1Schema } from '@happier-dev/triage-protocol/v1';

/**
 * The one path to "put this on the host's New Session screen and open it".
 *
 * It calls the dedicated semantic New Session opener. Input selection remains
 * a no-invoke draft/Action-input operation and cannot navigate as a side
 * effect. After this request, the screen's canonical snapshot owns every edit
 * and the send, so Triage never
 * holds a competing draft and never learns what the reader did with it.
 *
 * Attachments travel as the AUTHOR half only — `{ attachmentLocalId, value }`,
 * exactly what a live composer transaction carries. The qualified identity, the
 * type label, the cardinality upsert and the instance id are minted by the New
 * Session composer at its own mount, which is the only place they exist.
 *
 * The module owns no state and makes no decision: it does not build the seed,
 * resolve a prompt, choose a directory, or interpret what the reader does next.
 */

export type TriageNewSessionSeedV1 = Readonly<OpenNewSessionRequest>;

export const TriageNewSessionFailureV1Schema = defineProtocolObject({
    codes: defineProtocolArray(defineProtocolString()), requestId: defineProtocolString().optional(),
}, { policy: 'closed' });
export type TriageNewSessionFailureV1 = ReturnType<typeof TriageNewSessionFailureV1Schema.parse>;

/** Keep public diagnostic identifiers, never arbitrary error messages or details. */
export function projectTriageNewSessionFailureV1(error: unknown): TriageNewSessionFailureV1 | undefined {
    const generic = projectSessionInputLifecycleFailureV1(error);
    if (generic !== undefined) return generic;
    const source = TriageSourceFailureV1Schema.safeParse(error);
    return source.success ? { codes: [source.data.code],
        ...(source.data.requestId === undefined ? {} : { requestId: source.data.requestId }) } : undefined;
}

export type TriageNewSessionSeedHostV1 = Readonly<{
    version(): Readonly<{ methods: readonly string[] }>;
    openNewSession?(
        request: TriageNewSessionSeedV1,
        options?: OpenNewSessionOptions,
    ): Promise<void>;
}>;

export type TriageNewSessionSeedResultV1 =
    /** The host wrote the seed and opened its own New Session screen. */
    | Readonly<{ status: 'seeded' }>
    /** This mount installs no New Session navigation capability. */
    | Readonly<{ status: 'unsupported' }>
    /** The person declined or dismissed the host's preparation confirmation. */
    | Readonly<{ status: 'cancelled' }>
    /** The screen could not be opened, or the host refused the seed. */
    | Readonly<{ status: 'unavailable'; failure?: TriageNewSessionFailureV1 }>;

export async function requestTriageNewSessionSeed(
    host: TriageNewSessionSeedHostV1,
    seed: TriageNewSessionSeedV1,
    options?: OpenNewSessionOptions,
): Promise<TriageNewSessionSeedResultV1> {
    return openSessionInputAuthoringV1({ host, seed, options, projectFailure: projectTriageNewSessionFailureV1 });
}
