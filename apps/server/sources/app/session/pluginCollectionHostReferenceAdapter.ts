import type { PluginCollectionHostReferenceAdapter } from "@/app/plugins/data/collections/hostReferences";
import { checkSessionAccess } from "@/app/share/accessControl";

const AVAILABLE = Object.freeze({ status: "available" as const });
const TOMBSTONE = Object.freeze({ status: "tombstone" as const });
const UNAVAILABLE = Object.freeze({ status: "unavailable" as const });

/**
 * Canonical Account-authorized Session identity/availability adapter for Data.
 *
 * Live references use the Session access owner, including current collaborator
 * access and publication policy. A deleted Session resolves only through its
 * Account-scoped change row after the Session foreign key has been cleared.
 * Neither result grants Session mutation authority or exposes private rows.
 */
export const sessionPluginCollectionHostReferenceAdapter = {
    hostKind: "session",
    async resolveInTx({ tx, accountId, targetId }) {
        const access = await checkSessionAccess(accountId, targetId, tx);
        if (access) return AVAILABLE;

        const change = await tx.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId,
                    kind: "session",
                    entityId: targetId,
                },
            },
            select: { sessionId: true },
        });
        return change?.sessionId === null ? TOMBSTONE : UNAVAILABLE;
    },
} satisfies PluginCollectionHostReferenceAdapter;

/**
 * Canonical Account-scoped Message identity adapter for Data. The Message
 * domain owns the Session join; a missing or other-Account row stays
 * unavailable so a Collection relation cannot become a Message oracle.
 */
export const messagePluginCollectionHostReferenceAdapter = {
    hostKind: "message",
    async resolveInTx({ tx, accountId, targetId }) {
        const message = await tx.sessionMessage.findFirst({
            where: {
                id: targetId,
                session: { is: { accountId } },
            },
            select: { id: true },
        });
        return message ? AVAILABLE : UNAVAILABLE;
    },
} satisfies PluginCollectionHostReferenceAdapter;
