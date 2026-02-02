import { db } from "@/storage/db";
import { Context } from "@/context";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";

export async function usernameUpdate(ctx: Context, username: string): Promise<void> {
    const userId = ctx.uid;

    // Check if username is already taken
    const existingUser = await db.account.findFirst({
        where: {
            username: username,
            NOT: { id: userId }
        }
    });
    if (existingUser) { // Should never happen
        throw new Error('Username is already taken');
    }

    await inTx(async (tx) => {
        await tx.account.update({
            where: { id: userId },
            data: { username: username }
        });

        const cursor = await markAccountChanged(tx, { accountId: userId, kind: 'account', entityId: 'self', hint: { username } });

        afterTx(tx, () => {
            const updatePayload = buildUpdateAccountUpdate(userId, { username: username }, cursor, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId, payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });
        });
    });
}
