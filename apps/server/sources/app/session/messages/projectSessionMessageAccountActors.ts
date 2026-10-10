import {
    ACCOUNT_DISPLAY_PROFILE_SELECT,
    projectAccountDisplayProfileV1,
} from "@/app/account/profile/accountDisplayProfile";
import { warn } from "@/utils/logging/log";
import { inTx } from "@/storage/inTx";
import {
    SessionMessageAccountActorV1Schema,
    deriveSessionMessageAuthorAccountIdV1,
    type SessionMessageAccountActorV1,
} from "@happier-dev/protocol";

/**
 * The transcript/Pending columns this projector reads. `authorAccountId` is the
 * derived relational query projection; it is consistency-checked here and never
 * treated as the actor authority.
 */
export type SessionMessageAccountActorSourceRow = Readonly<{
    messageRole: unknown;
    inputAdmissionReceipt: unknown;
    authorAccountId?: string | null;
}>;

type AccountDisplayProfileReader = Readonly<{
    account: {
        findMany: (args: {
            where: { id: { in: string[] } };
            select: typeof ACCOUNT_DISPLAY_PROFILE_SELECT;
        }) => Promise<readonly {
            id: string;
            firstName: string | null;
            lastName: string | null;
            username: string | null;
            avatar: unknown;
        }[]>;
    };
}>;

/**
 * Projects sanitized Account actors for already-authorized domain rows whose
 * canonical writer directly stamped an authenticated Account id.
 *
 * Session transcript/Pending rows must continue through the receipt-checking
 * projector below. Discussion rows do not carry Session input receipts: their
 * server mutation owner authenticates and stamps `authorAccountId` directly.
 * Keeping the profile lookup here gives both domains one disclosure/fallback
 * policy without pretending the two authorship proofs are interchangeable.
 */
export async function projectAuthenticatedAccountActorsById(
    reader: AccountDisplayProfileReader,
    accountIds: readonly (string | null)[],
): Promise<(SessionMessageAccountActorV1 | null)[]> {
    const validAccountIds = accountIds.map((value) => {
        const parsed = SessionMessageAccountActorV1Schema.shape.accountId.safeParse(value);
        return parsed.success ? parsed.data : null;
    });
    const uniqueAccountIds = [...new Set(validAccountIds.filter((id): id is string => id !== null))];
    if (uniqueAccountIds.length === 0) return validAccountIds.map(() => null);

    const accounts = await reader.account.findMany({
        where: { id: { in: uniqueAccountIds } },
        select: ACCOUNT_DISPLAY_PROFILE_SELECT,
    });
    const profilesByAccountId = new Map(
        accounts.map((account) => [account.id, projectAccountDisplayProfileV1(account)] as const),
    );
    return validAccountIds.map((accountId) => accountId === null
        ? null
        : SessionMessageAccountActorV1Schema.parse({
            v: 1,
            accountId,
            profile: profilesByAccountId.get(accountId) ?? null,
        }));
}

/**
 * Resolves the sanitized authenticated-reader actor for already-authorized rows.
 *
 * The immutable admission receipt is the only actor authority: the derived
 * `authorAccountId` column may lag (pre-backfill) or be nulled by Account
 * deletion, and a non-null disagreement is an input-admission fault that fails
 * closed rather than disclosing a guessed identity.
 *
 * Profiles are batch-loaded once per call from the unique valid actor ids, so a
 * page with repeated authors performs one bounded lookup. Actor resolution
 * deliberately does not require the historical actor to still hold Session,
 * Team, or Group access.
 */
export async function projectSessionMessageAccountActors(
    reader: AccountDisplayProfileReader,
    rows: readonly SessionMessageAccountActorSourceRow[],
): Promise<(SessionMessageAccountActorV1 | null)[]> {
    const actorAccountIds = rows.map((row) => {
        const actorAccountId = deriveSessionMessageAuthorAccountIdV1({
            messageRole: row.messageRole,
            inputAdmissionReceipt: row.inputAdmissionReceipt,
        });
        if (actorAccountId === null) return null;
        if (row.authorAccountId != null && row.authorAccountId !== actorAccountId) {
            warn({
                event: "session_message_author_projection_conflict",
            }, "Session message author projection disagrees with its admission receipt");
            return null;
        }
        return actorAccountId;
    });

    return projectAuthenticatedAccountActorsById(reader, actorAccountIds);
}

/**
 * Publisher-side convenience over the batch projector for one just-written row.
 *
 * Realtime and page projection therefore resolve identical actor semantics from
 * the same owner instead of diverging per event builder.
 */
export async function resolveSessionMessageAccountActor(
    row: SessionMessageAccountActorSourceRow,
): Promise<SessionMessageAccountActorV1 | null> {
    // Publication follows commit: a later SQLite writer must not hold the
    // profile read ahead of the notification. Keep the existing batch projector
    // and open the storage-owned read snapshot only when an actor needs a profile.
    const [actor] = await projectSessionMessageAccountActors({
        account: { findMany: (args) => inTx((tx) => tx.account.findMany(args), { readOnly: true }) },
    }, [row]);
    return actor ?? null;
}
