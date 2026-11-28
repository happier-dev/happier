import { SupporterCodeV1Schema } from "@happier-dev/protocol";
import { z } from "zod";

import type { Fastify } from "@/app/api/types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

export const supporterProofSchema = z.object({ code: SupporterCodeV1Schema.optional() });
export type SupporterProof = Readonly<{ accountId: string | null; code: string | null }>;

export async function readSupporterProof(
    authenticate: () => Promise<unknown>,
    accountId: () => string | undefined,
    code: string | undefined,
): Promise<SupporterProof | null> {
    if (code) return { accountId: null, code };
    await authenticate();
    const id = accountId();
    return id ? { accountId: id, code: null } : null;
}

/** A code can address only a detached Cloud record. An attached record requires its own session. */
export async function findPerkRecord(tx: Tx, proof: SupporterProof) {
    if (proof.accountId) return tx.supporterRecord.findUnique({ where: { accountId: proof.accountId } });
    if (proof.code) return tx.supporterRecord.findFirst({ where: { code: proof.code, accountId: null } });
    return null;
}

const profilePatch = supporterProofSchema.extend({
    publicName: z.string().transform((value) => value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim())
        .pipe(z.string().min(1).max(48)).nullable().optional(),
    publicLink: z.url({ protocol: /^https$/ }).max(191).nullable().optional(),
    githubLogin: z.null().optional(),
}).strict();

const publicEntry = z.object({
    number: z.number().int().positive(),
    name: z.string(),
    link: z.url({ protocol: /^https$/ }).optional(),
    since: z.number().int(),
});

/** Register Cloud-only profile edits and the allow-listed snapshot used by the wall publisher. */
export function registerSupporterPerkRoutes(app: Fastify, env: NodeJS.ProcessEnv): void {
    app.patch("/v1/supporter/profile", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, "supporter.profile") },
        schema: { body: profilePatch, response: {
            200: z.object({ ok: z.literal(true) }),
            404: z.object({ error: z.literal("not_found") }),
        } },
    }, async (request, reply) => {
        const { code, ...patch } = request.body;
        const proof = await readSupporterProof(() => app.authenticate(request, reply), () => request.userId, code);
        if (!proof || reply.sent) return;
        const updated = await inTx(async (tx) => {
            const row = await findPerkRecord(tx, proof);
            if (!row || row.number === null || row.revokedAt !== null) return false;
            const data = {
                ...(patch.publicName !== undefined && patch.publicName !== row.publicName ? { publicName: patch.publicName } : {}),
                ...(patch.publicLink !== undefined && patch.publicLink !== row.publicLink ? { publicLink: patch.publicLink } : {}),
                ...(patch.githubLogin === null && row.githubLogin !== null ? { githubLogin: null } : {}),
            };
            if (Object.keys(data).length) await tx.supporterRecord.update({ where: { id: row.id }, data });
            return true;
        });
        return updated ? reply.send({ ok: true }) : reply.code(404).send({ error: "not_found" });
    });

    app.get("/v1/supporters/public", {
        schema: {
            response: { 200: z.object({ total: z.number().int().nonnegative(), entries: z.array(publicEntry), githubLabels: z.array(z.string()) }) },
        },
    }, async (_request, reply) => {
        const active = { number: { not: null }, revokedAt: null };
        const [total, rows] = await Promise.all([
            db.supporterRecord.count({ where: active }),
            db.supporterRecord.findMany({
                where: { ...active, OR: [{ publicName: { not: null } }, { githubLogin: { not: null } }] },
                orderBy: { number: "asc" },
                select: { number: true, publicName: true, publicLink: true, grantedAt: true, githubLogin: true },
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
