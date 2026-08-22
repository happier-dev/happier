import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentId } from '@happier-dev/agents';
import type { AgentNativeResumeIdentityV1 } from '@happier-dev/protocol';
import { z } from 'zod';

import {
    readProtectedLocalStateFile,
    removeProtectedLocalStateFile,
    writeProtectedLocalStateFileAtomic,
} from '@/utils/fs/protectedLocalState';

type MetadataRecord = Record<string, unknown>;

function asMetadataRecord(value: unknown): MetadataRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as MetadataRecord;
}

function buildVendorResumeIdFingerprint(vendorResumeId: string): string {
    return createHash('sha256').update(vendorResumeId).digest('hex');
}

/**
 * Domain-separated so a Session+Agent record can never collide with the
 * vendor-resume overlay fingerprints stored beside it, and so neither Session
 * IDs nor Agent IDs appear in a filename.
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

type StoredLocalSessionHandoffMetadataRecord = Readonly<{
    vendorResumeId: string;
    exportMetadataOverlay: MetadataRecord;
    updatedAtMs: number;
}>;

/**
 * Machine-local record of an INACTIVE Agent's native conversation.
 *
 * Device-local because a vendor session belongs to the machine that ran it: an
 * id recorded here cannot be resumed anywhere else, so a server copy would be
 * unusable everywhere it could be read (`REQ-PRIVACY-01`). It is scope, not
 * secrecy.
 *
 * It carries two facts and nothing else: WHICH conversation to resume, and HOW
 * FAR that conversation had seen this Session's transcript when the Agent left.
 * There is no continuity proof and no id/proof atomicity obligation (`AM-24`):
 * whether a recorded id still resumes is answered by resuming it, which fails
 * loudly in both Agents that support native resume. No model, Provider ref,
 * AgentState, PID, permission, cursor, request, or transcript content is
 * retained.
 */
const StoredLocalAgentResumeRecordV1Schema = z.object({
    v: z.literal(1),

    // Scoping. The filename is a hash, so these two are the only proof the file
    // belongs to the requested pair; the reader rejects a mismatch below.
    happierSessionId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),

    // What to resume: the Agent's own conversation id, in its catalog's terms.
    vendorResumeId: z.string().trim().min(1).max(512),

    /**
     * Transcript head at this Agent's departure — the boundary its own
     * conversation already covers, so a later return replays only what happened
     * while it was away (`AM-26`).
     *
     * REQUIRED. The schema is `.strict()`, so no record written before this
     * field existed parses at all; an optional bound would add a second meaning
     * with no producer. A record that fails to parse degrades to a fresh target
     * with the FULL replay — one switch per (Session, Agent), self-healing on
     * the next departure.
     *
     * Stored rather than derived: the divider carries the equivalent number
     * inside SEALED content and `fromAgentId` is not server-queryable, while
     * this record is already read on return.
     */
    departureSeqInclusive: z.number().int().nonnegative(),
}).strict();

type StoredLocalAgentResumeRecordV1 = z.infer<typeof StoredLocalAgentResumeRecordV1Schema>;

export type LocalAgentNativeResumeRecordKey = Readonly<{
    happierSessionId: string;
    agentId: AgentId;
}>;

/** Both facts the record carries, read as one value. */
export type LocalAgentNativeResumeRecordV1 = Readonly<{
    identity: AgentNativeResumeIdentityV1;
    departureSeqInclusive: number;
}>;

export function createLocalSessionHandoffMetadataStore(params: Readonly<{
    activeServerDir: string;
}>) {
    const rootDir = join(params.activeServerDir, 'session-handoff', 'local-metadata');
    const agentNativeResumeDir = join(params.activeServerDir, 'session-handoff', 'agent-native-resume');

    const resolveRecordPath = (vendorResumeId: string): string =>
        join(rootDir, `${buildVendorResumeIdFingerprint(vendorResumeId)}.json`);

    const resolveAgentNativeResumeRecordPath = (key: LocalAgentNativeResumeRecordKey): string =>
        join(
            agentNativeResumeDir,
            `${buildAgentNativeResumeRecordFingerprint(key.happierSessionId.trim(), key.agentId)}.json`,
        );

    const readAgentNativeResumeRecordFile = async (
        key: LocalAgentNativeResumeRecordKey,
    ): Promise<StoredLocalAgentResumeRecordV1 | null> => {
        const happierSessionId = key.happierSessionId.trim();
        if (!happierSessionId) return null;

        const raw = await readProtectedLocalStateFile(
            resolveAgentNativeResumeRecordPath(key),
        ).catch(() => null);
        if (!raw) return null;

        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(raw);
        } catch {
            return null;
        }

        const parsed = StoredLocalAgentResumeRecordV1Schema.safeParse(parsedJson);
        if (!parsed.success) return null;

        // The filename is a hash, so the plaintext keys are the only thing that
        // proves this record belongs to the requested Session and Agent. A
        // mismatch means a stale or tampered file, never a usable native session.
        if (
            parsed.data.happierSessionId !== happierSessionId
            || parsed.data.agentId !== key.agentId
        ) {
            return null;
        }

        return parsed.data;
    };

    return {
        async loadByVendorResumeId(vendorResumeId: string): Promise<MetadataRecord | null> {
            const normalizedVendorResumeId = vendorResumeId.trim();
            if (!normalizedVendorResumeId) {
                return null;
            }

            const raw = await readFile(resolveRecordPath(normalizedVendorResumeId), 'utf8').catch(() => null);
            if (!raw) {
                return null;
            }

            try {
                const parsed = JSON.parse(raw) as StoredLocalSessionHandoffMetadataRecord;
                if (parsed.vendorResumeId !== normalizedVendorResumeId) {
                    return null;
                }
                return asMetadataRecord(parsed.exportMetadataOverlay);
            } catch {
                return null;
            }
        },

        async saveByVendorResumeId(input: Readonly<{
            vendorResumeId: string;
            exportMetadataOverlay: MetadataRecord;
        }>): Promise<void> {
            const normalizedVendorResumeId = input.vendorResumeId.trim();
            if (!normalizedVendorResumeId) {
                return;
            }

            await mkdir(rootDir, { recursive: true });
            await writeFile(
                resolveRecordPath(normalizedVendorResumeId),
                JSON.stringify({
                    vendorResumeId: normalizedVendorResumeId,
                    exportMetadataOverlay: input.exportMetadataOverlay,
                    updatedAtMs: Date.now(),
                } satisfies StoredLocalSessionHandoffMetadataRecord, null, 2),
                'utf8',
            );
        },

        resolveAgentNativeResumeRecordPath,

        /**
         * Returns the inactive Agent's recorded conversation and the transcript
         * boundary it covers, or `null` when the record is absent, corrupt,
         * predates the current shape, or does not belong to this Session+Agent.
         * Every `null` degrades to a fresh target plus the full bounded context.
         */
        async readAgentNativeResumeRecord(
            key: LocalAgentNativeResumeRecordKey,
        ): Promise<LocalAgentNativeResumeRecordV1 | null> {
            const record = await readAgentNativeResumeRecordFile(key);
            if (!record) return null;
            return {
                identity: { v: 1, vendorResumeId: record.vendorResumeId },
                departureSeqInclusive: record.departureSeqInclusive,
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
                vendorResumeId: input.identity.vendorResumeId.trim(),
                departureSeqInclusive: input.departureSeqInclusive,
            });
            if (!candidate.success) return;

            await writeProtectedLocalStateFileAtomic(path, JSON.stringify(candidate.data))
                .catch(() => {});
        },
    };
}
