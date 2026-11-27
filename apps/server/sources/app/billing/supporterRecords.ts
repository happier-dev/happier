import { randomBytes } from "node:crypto";

import {
    SupporterCodeV1Schema,
    SupporterKindV1Schema,
    type SupporterKindV1,
    type SupporterRecordFactsV1,
} from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";

/**
 * Owner of `SupporterRecord`, the one supporter fact (plans-and-support PROGRAM, State).
 *
 * On Happier Cloud the only writer is billing reconciliation; on other servers it is the
 * Account's own `PUT /v1/account/supporter`. `supporter.active` = a record with `number` set and
 * `revokedAt` null. A lapse never revokes; a refund leaving nothing paid does, and a later paid
 * purchase clears it with the same number.
 */

type SupporterRecordRow = Readonly<{
    code: string;
    number: number | null;
    kind: string | null;
    grantedAt: Date | null;
    recurringActive: boolean;
    revokedAt: Date | null;
}>;

export const SUPPORTER_RECORD_SELECT = {
    code: true,
    number: true,
    kind: true,
    grantedAt: true,
    recurringActive: true,
    revokedAt: true,
} as const;

export function isActiveSupporterRecord<T extends { number: number | null; revokedAt: Date | null }>(
    record: T | null,
): record is T & { number: number; revokedAt: null } {
    return record !== null && record.number !== null && record.revokedAt === null;
}

/** 128 random bits, 32 lowercase hex characters (`SupporterCodeV1Schema`). */
export function generateSupporterCode(): string {
    return randomBytes(16).toString("hex");
}

export function isSupporterCode(value: string): boolean {
    return SupporterCodeV1Schema.safeParse(value).success;
}

/** A store restore moves the number while the destination owns the resulting record. */
export async function transferSupporterRecordInTx(tx: Tx, from: string, to: string): Promise<boolean> {
    const sourceWhere = isSupporterCode(from) ? { code: from } : { accountId: from };
    const toCode = isSupporterCode(to);
    const targetWhere = toCode ? { code: to } : { accountId: to };
    const [source, target] = await Promise.all([
        tx.supporterRecord.findUnique({ where: sourceWhere, select: { id: true, number: true, kind: true } }),
        tx.supporterRecord.findUnique({ where: targetWhere, select: { id: true, number: true, code: true } }),
    ]);
    if (!source || source.number === null || source.kind === "github_sponsor" || (target && target.number !== null)) return false;
    if (!toCode && !await tx.account.findUnique({ where: { id: to }, select: { id: true } })) return false;
    if (target) await tx.supporterRecord.delete({ where: { id: target.id } });
    await tx.supporterRecord.update({
        where: { id: source.id },
        data: {
            accountId: toCode ? null : to,
            code: toCode ? to : target?.code ?? generateSupporterCode(),
            publicName: null, publicLink: null, githubLogin: null,
        },
    });
    return true;
}

export function toSupporterFactsV1(record: SupporterRecordRow): SupporterRecordFactsV1 {
    const kind = SupporterKindV1Schema.safeParse(record.kind);
    return {
        number: record.number,
        kind: kind.success ? kind.data : null,
        grantedAt: record.grantedAt?.getTime() ?? null,
        recurringActive: record.recurringActive,
        revokedAt: record.revokedAt?.getTime() ?? null,
    };
}

/** Next permanent number. A concurrent first payment conflicts on the unique index; the caller retries once. */
async function allocateSupporterNumberInTx(tx: Tx): Promise<number> {
    const max = await tx.supporterRecord.aggregate({ _max: { number: true } });
    return (max._max.number ?? 0) + 1;
}

export type SupporterPurchaseFacts = Readonly<{
    /** A paid purchase or a live paid subscription exists (a paid plan includes the Supporter pack). */
    earned: boolean;
    /** At least one refunded purchase and no paid purchase left. */
    revoked: boolean;
    recurringActive: boolean;
    kind: SupporterKindV1;
    /** When support started, from the provider's earliest purchase. */
    firstPurchaseAt: Date | null;
}>;

/**
 * Applies reconciled provider facts to the record for one `ref` (Cloud only). Creates the record
 * on first sight of a purchase, assigns its number then, and derives `revokedAt` from the facts.
 * Returns whether anything was written.
 */
export async function applySupporterPurchaseFactsInTx(tx: Tx, params: Readonly<{
    /** Set when `ref` is a local Account; the record is then keyed by Account. */
    accountId: string | null;
    /** Set when `ref` is a supporter code carried from another server. */
    code: string | null;
    facts: SupporterPurchaseFacts;
    now: Date;
}>): Promise<Readonly<{ changed: boolean; revokedNow: boolean }>> {
    const existing = params.accountId
        ? await tx.supporterRecord.findUnique({ where: { accountId: params.accountId }, select: { id: true, ...SUPPORTER_RECORD_SELECT } })
        : await tx.supporterRecord.findUnique({ where: { code: params.code ?? "" }, select: { id: true, ...SUPPORTER_RECORD_SELECT } });
    const { facts } = params;
    // A refunded purchase was still a purchase: it reserves the number, shown again if paid later.
    const purchased = facts.earned || facts.revoked;
    if (!existing && !purchased) return { changed: false, revokedNow: false };
    // An empty provider read cannot restore a refunded purchase. Keep its revocation until
    // there is positive purchase evidence again.
    let revokedAt = existing?.revokedAt ?? null;
    if (facts.revoked) revokedAt ??= params.now;
    else if (facts.earned) revokedAt = null;
    const grantedAt = facts.firstPurchaseAt ?? params.now;

    if (!existing) {
        await tx.supporterRecord.create({
            data: {
                code: params.code ?? generateSupporterCode(),
                accountId: params.accountId,
                number: await allocateSupporterNumberInTx(tx),
                kind: facts.kind,
                grantedAt,
                recurringActive: facts.recurringActive,
                revokedAt,
            },
        });
        return { changed: true, revokedNow: revokedAt !== null };
    }

    const data: {
        number?: number;
        kind?: string;
        grantedAt?: Date;
        recurringActive?: boolean;
        revokedAt?: Date | null;
    } = {};
    if (purchased && existing.number === null) data.number = await allocateSupporterNumberInTx(tx);
    if (purchased && existing.kind !== facts.kind) data.kind = facts.kind;
    if (purchased && existing.grantedAt === null) data.grantedAt = grantedAt;
    if (existing.recurringActive !== facts.recurringActive) data.recurringActive = facts.recurringActive;
    if ((existing.revokedAt?.getTime() ?? null) !== (revokedAt?.getTime() ?? null)) data.revokedAt = revokedAt;
    if (Object.keys(data).length === 0) return { changed: false, revokedNow: false };

    await tx.supporterRecord.update({ where: { id: existing.id }, data });
    return { changed: true, revokedNow: existing.revokedAt === null && revokedAt !== null };
}

/**
 * Self-hosted write from the Account's own app: a freshly minted code (pending) or the facts the app
 * read from Happier Cloud's lookup for that code. Touches the supporter row only, never the plan.
 */
export async function writeAccountSupporterRecordInTx(tx: Tx, params: Readonly<{
    accountId: string;
    code: string;
    facts: SupporterRecordFactsV1 | null;
}>): Promise<Readonly<{ changed: boolean }>> {
    const existing = await tx.supporterRecord.findUnique({ where: { accountId: params.accountId }, select: { id: true, ...SUPPORTER_RECORD_SELECT } });
    // A code without facts is pending; re-sending the stored code keeps what it already settled.
    if (!params.facts && existing?.code === params.code) return { changed: false };
    const facts = params.facts;
    const next = {
        code: params.code,
        number: facts?.number ?? null,
        kind: facts?.kind ?? null,
        grantedAt: facts?.grantedAt != null ? new Date(facts.grantedAt) : null,
        recurringActive: facts?.recurringActive ?? false,
        revokedAt: facts?.revokedAt != null ? new Date(facts.revokedAt) : null,
    };
    if (existing && sameSupporterRow(existing, next)) return { changed: false };
    if (existing) {
        await tx.supporterRecord.update({ where: { id: existing.id }, data: next });
    } else {
        await tx.supporterRecord.create({ data: { ...next, accountId: params.accountId } });
    }
    return { changed: true };
}

function sameSupporterRow(left: SupporterRecordRow, right: SupporterRecordRow): boolean {
    return left.code === right.code
        && left.number === right.number
        && left.kind === right.kind
        && (left.grantedAt?.getTime() ?? null) === (right.grantedAt?.getTime() ?? null)
        && left.recurringActive === right.recurringActive
        && (left.revokedAt?.getTime() ?? null) === (right.revokedAt?.getTime() ?? null);
}
