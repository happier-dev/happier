import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { NonBlankOpaqueIdentifierSchema } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { AgentId } from '@happier-dev/agents';
import {
    ConnectedServiceMaterializationIdentityV1Schema,
    type AgentNativeResumeIdentityV1,
} from '@happier-dev/protocol';
import {
    ConnectedAccountServiceKeyIngressSchema,
    ConnectedServiceProfileIdSchema,
} from '@happier-dev/protocol/connect/connected-service-bindings';
import { z } from 'zod/mini';

import {
    readProtectedLocalStateFile,
    removeProtectedLocalStateFile,
    writeProtectedLocalStateFileAtomic,
} from '@/utils/fs/protectedLocalState';

/**
 * Domain-separated so neither Session IDs nor Agent IDs appear in a filename.
 */
const AGENT_NATIVE_RESUME_RECORD_FINGERPRINT_DOMAIN = 'happier.local-agent-native-resume.v1';

function buildAgentNativeResumeRecordFingerprint(
    happierSessionId: string,
    agentId: string,
): string {
    return createHash('sha256')
        .update(AGENT_NATIVE_RESUME_RECORD_FINGERPRINT_DOMAIN)
        .update('\u0000')
        .update(happierSessionId)
        .update('\u0000')
        .update(agentId)
        .digest('hex');
}

const LocalAgentNativeResumeAuthSchema = lazyZodSchema(() => z.strictObject({
    profilesByServiceId: z.record(ConnectedAccountServiceKeyIngressSchema, ConnectedServiceProfileIdSchema),
    materializationIdentity: z.optional(ConnectedServiceMaterializationIdentityV1Schema),
}));

export type LocalAgentNativeResumeAuth = z.infer<typeof LocalAgentNativeResumeAuthSchema>;

/**
 * Machine-local record of an INACTIVE Agent's native conversation.
 *
 * Device-local because a vendor session belongs to the machine that ran it: an
 * id recorded here cannot be resumed anywhere else, so a server copy would be
 * unusable everywhere it could be read (`REQ-PRIVACY-01`). It is scope, not
 * secrecy.
 *
 * It carries the conversation, its transcript boundary, and the non-secret
 * connected account and state home associated with that conversation.
 * There is no continuity proof and no id/proof atomicity obligation (`AM-24`):
 * whether a recorded id still resumes is answered by resuming it, which fails
 * loudly in both Agents that support native resume. No model, Provider ref,
 * AgentState, PID, permission, cursor, request, or transcript content is
 * retained.
 */
const StoredLocalAgentResumeRecordV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),

    // Scoping. The filename is a hash, so these two are the only proof the file
    // belongs to the requested pair; the reader rejects a mismatch below.
    happierSessionId: z.string().check(z.trim(), z.minLength(1)),
    agentId: z.string().check(z.trim(), z.minLength(1)),

    // What to resume: the Agent's own conversation id, in its catalog's terms.
    vendorResumeId: lazyZodSchema(() => NonBlankOpaqueIdentifierSchema.check(z.maxLength(512))),

    /**
     * Transcript head at this Agent's departure — the boundary its own
     * conversation already covers, so a later return replays only what happened
     * while it was away (`AM-26`).
     *
     * REQUIRED. No record written before this field existed parses at all;
     * an optional bound would add a second meaning
     * with no producer. A record that fails to parse degrades to a fresh target
     * with the FULL replay — one switch per (Session, Agent), self-healing on
     * the next departure.
     *
     * Stored rather than derived: the divider carries the equivalent number
     * inside SEALED content and `fromAgentId` is not server-queryable, while
     * this record is already read on return.
     */
    departureSeqInclusive: z.number().check(z.int(), z.nonnegative()),
    auth: z.optional(LocalAgentNativeResumeAuthSchema),
}));

type StoredLocalAgentResumeRecordV1 = z.infer<typeof StoredLocalAgentResumeRecordV1Schema>;

export type LocalAgentNativeResumeRecordKey = Readonly<{
    happierSessionId: string;
    agentId: AgentId;
}>;

/** The conversation and its continuity metadata, read as one value. */
export type LocalAgentNativeResumeRecordV1 = Readonly<{
    identity: AgentNativeResumeIdentityV1;
    departureSeqInclusive: number;
    auth?: LocalAgentNativeResumeAuth;
}>;

export function createLocalSessionHandoffMetadataStore(params: Readonly<{
    activeServerDir: string;
}>) {
    const agentNativeResumeDir = join(params.activeServerDir, 'session-handoff', 'agent-native-resume');

    const resolveAgentNativeResumeRecordPath = (key: LocalAgentNativeResumeRecordKey): string =>
        join(
            agentNativeResumeDir,
            `${buildAgentNativeResumeRecordFingerprint(key.happierSessionId.trim(), key.agentId)}.json`,
        );

    const readAgentNativeResumeRecordFile = async (
        key: LocalAgentNativeResumeRecordKey,
        requireConclusiveAbsence: boolean,
    ): Promise<StoredLocalAgentResumeRecordV1 | null> => {
        const unreadable = () => {
            if (requireConclusiveAbsence) throw new Error('Cannot establish whether a native return record exists');
            return null;
        };
        const happierSessionId = key.happierSessionId.trim();
        if (!happierSessionId) return unreadable();

        const raw = await readProtectedLocalStateFile(
            resolveAgentNativeResumeRecordPath(key),
        ).catch((error: unknown) => {
            if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return null;
            return unreadable();
        });
        if (raw === null) return null;

        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(raw);
        } catch {
            return unreadable();
        }

        const parsed = createStoredReadSchema(StoredLocalAgentResumeRecordV1Schema).safeParse(parsedJson);
        if (!parsed.success) return unreadable();

        // The filename is a hash, so the plaintext keys are the only thing that
        // proves this record belongs to the requested Session and Agent. A
        // mismatch means a stale or tampered file, never a usable native session.
        if (
            parsed.data.happierSessionId !== happierSessionId
            || parsed.data.agentId !== key.agentId
        ) {
            return unreadable();
        }

        return parsed.data;
    };

    return {
        resolveAgentNativeResumeRecordPath,

        /**
         * Returns the inactive Agent's recorded conversation and the transcript
         * boundary it covers, or `null` when the record is absent, corrupt,
         * predates the current shape, or does not belong to this Session+Agent.
         * Every `null` degrades to a fresh target plus the full bounded context.
         */
        async readAgentNativeResumeRecord(
            key: LocalAgentNativeResumeRecordKey,
            options?: Readonly<{ requireConclusiveAbsence?: boolean }>,
        ): Promise<LocalAgentNativeResumeRecordV1 | null> {
            const record = await readAgentNativeResumeRecordFile(key, options?.requireConclusiveAbsence === true);
            if (!record) return null;
            return {
                identity: { v: 1, vendorResumeId: record.vendorResumeId },
                departureSeqInclusive: record.departureSeqInclusive,
                ...(record.auth ? { auth: record.auth } : {}),
            };
        },

        /**
         * Overwrites the outgoing record, or removes it when `identity` is
         * `null`.
         *
         * Returns nothing on purpose. There is no caller decision to make: the
         * record only decides whether a FUTURE return is native, and both
         * callers of the previous boolean discarded it. The write is
         * tmp+rename and every read `safeParse`s, so a partial file already
         * reads as absent — a read-back could only restate that.
         */
        async writeAgentNativeResumeRecord(input: LocalAgentNativeResumeRecordKey & Readonly<{
            identity: AgentNativeResumeIdentityV1 | null;
            departureSeqInclusive: number;
            auth?: LocalAgentNativeResumeAuth;
        }>): Promise<void> {
            const happierSessionId = input.happierSessionId.trim();
            if (!happierSessionId) return;
            const path = resolveAgentNativeResumeRecordPath(input);

            if (!input.identity) {
                await removeProtectedLocalStateFile(path).catch(() => {});
                return;
            }

            const candidate = StoredLocalAgentResumeRecordV1Schema.safeParse({
                v: 1,
                happierSessionId,
                agentId: input.agentId,
                vendorResumeId: input.identity.vendorResumeId,
                departureSeqInclusive: input.departureSeqInclusive,
                auth: input.auth,
            });
            if (!candidate.success) return;

            await writeProtectedLocalStateFileAtomic(path, JSON.stringify(candidate.data))
                .catch(() => {});
        },
    };
}
