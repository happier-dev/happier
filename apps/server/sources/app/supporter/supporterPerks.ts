import { SupporterCodeV1Schema } from "@happier-dev/protocol";
import { z } from "zod/mini";

import type { Fastify } from "@/app/api/types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { isActiveSupporterRecord } from "@/app/billing/supporterRecords";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

export const supporterProofSchema = z.strictObject({ code: z.optional(SupporterCodeV1Schema) });
export const supporterRecordProofSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("account"), accountId: z.string().check(z.minLength(1)) }),
    z.strictObject({ kind: z.literal("code"), code: SupporterCodeV1Schema }),
]);
export type SupporterProof = z.infer<typeof supporterRecordProofSchema>;

export const supporterGitHubAttemptSchema = z.strictObject({
    proof: supporterRecordProofSchema,
    recordId: z.nullable(z.string().check(z.minLength(1))),
    publishGitHubLogin: z.boolean(),
});
export type SupporterGitHubAttempt = z.infer<typeof supporterGitHubAttemptSchema>;

export async function readSupporterProof(
    authenticate: () => Promise<unknown>,
    accountId: () => string | undefined,
    code: string | undefined,
): Promise<SupporterProof | null> {
    if (code) return { kind: "code", code };
    await authenticate();
    const id = accountId();
    return id ? { kind: "account", accountId: id } : null;
}

export const SUPPORTER_PROFILE_SELECT = {
    publicName: true,
    publicLink: true,
    githubLogin: true,
} as const;

export function toSupporterProfile({ publicName, publicLink, githubLogin }: Readonly<Record<keyof typeof SUPPORTER_PROFILE_SELECT, string | null>>) {
    return { publicName, publicLink, githubLogin };
}

/** The session owns its attached record. A body code can address a detached record only. */
export async function readProvenSupporterRecord(tx: Tx, proof: SupporterProof) {
    const record = await tx.supporterRecord.findUnique({
        where: proof.kind === "account" ? { accountId: proof.accountId } : { code: proof.code },
        select: {
            id: true, accountId: true, number: true, kind: true,
            grantedAt: true, recurringActive: true, revokedAt: true,
            ...SUPPORTER_PROFILE_SELECT,
        },
    });
    if (proof.kind === "code" && record?.accountId != null) return { status: "refused" as const };
    return { status: "allowed" as const, record };
}

const httpsLinkSchema = z.url({ protocol: /^https$/ });
const profilePatchSchema = z.safeExtend(supporterProofSchema, {
    publicName: z.optional(z.nullable(z.pipe(
        z.string(),
        z.pipe(
            z.transform((value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()),
            z.string().check(z.minLength(1), z.maxLength(48)),
        ),
    ))),
    publicLink: z.optional(z.nullable(httpsLinkSchema.check(z.maxLength(191)))),
    githubLogin: z.optional(z.null()),
});

const publicEntrySchema = z.strictObject({
    number: z.int().check(z.positive()),
    name: z.string(),
    link: z.optional(httpsLinkSchema),
    since: z.int(),
});

/** Cloud owns consented supporter display fields and the public snapshot used by the wall publisher. */
export function registerSupporterPerkRoutes(app: Fastify, env: NodeJS.ProcessEnv): void {
    app.patch("/v1/supporter/profile", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, "supporter.profile") },
        schema: { body: profilePatchSchema, response: {
            200: z.strictObject({ ok: z.literal(true) }),
            404: z.strictObject({ error: z.literal("not_found") }),
        } },
    }, async (request, reply) => {
        const { code, ...patch } = request.body as z.infer<typeof profilePatchSchema>;
        const proof = await readSupporterProof(() => app.authenticate(request, reply), () => request.userId, code);
        if (!proof || reply.sent) return;
        const updated = await inTx(async (tx) => {
            const result = await readProvenSupporterRecord(tx, proof);
            if (result.status === "refused" || !result.record || !isActiveSupporterRecord(result.record)) return false;
            const { record } = result;
            const data = {
                ...(patch.publicName !== undefined && patch.publicName !== record.publicName ? { publicName: patch.publicName } : {}),
                ...(patch.publicLink !== undefined && patch.publicLink !== record.publicLink ? { publicLink: patch.publicLink } : {}),
                ...(patch.githubLogin === null && record.githubLogin !== null ? { githubLogin: null } : {}),
            };
            if (Object.keys(data).length === 0) return true;
            const mutation = await tx.supporterRecord.updateMany({
                where: { id: record.id, accountId: record.accountId, revokedAt: null },
                data,
            });
            return mutation.count === 1;
        });
        return updated ? reply.send({ ok: true }) : reply.code(404).send({ error: "not_found" });
    });

    app.get("/v1/supporters/public", {
        schema: { response: { 200: z.strictObject({
            total: z.int().check(z.nonnegative()),
            entries: z.array(publicEntrySchema),
            githubLabels: z.array(z.string()),
        }) } },
    }, async (_request, reply) => {
        const active = { number: { not: null }, revokedAt: null } as const;
        const [total, rows] = await Promise.all([
            db.supporterRecord.count({ where: active }),
            db.supporterRecord.findMany({
                where: { ...active, OR: [{ publicName: { not: null } }, { githubLogin: { not: null } }] },
                orderBy: { number: "asc" },
                select: { number: true, grantedAt: true, ...SUPPORTER_PROFILE_SELECT },
            }),
        ]);
        return reply.send({
            total,
            entries: rows.flatMap((row) => row.number && row.publicName && row.grantedAt ? [{
                number: row.number,
                name: row.publicName,
                ...(row.publicLink ? { link: row.publicLink } : {}),
                since: row.grantedAt.getUTCFullYear(),
            }] : []),
            githubLabels: [...new Set(rows.flatMap(({ githubLogin }) => githubLogin ? [githubLogin] : []))].sort(),
        });
    });
}

/** Erasure retains the permanent number and withdraws all the Account's optional public disclosures. */
export async function eraseAccountSupporterProfileInTx(tx: Tx, accountId: string): Promise<void> {
    await tx.supporterRecord.updateMany({
        where: { accountId },
        data: { accountId: null, publicName: null, publicLink: null, githubLogin: null },
    });
}
