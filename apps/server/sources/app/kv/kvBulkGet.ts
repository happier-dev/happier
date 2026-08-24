import { db } from "@/storage/db";
import * as privacyKit from "privacy-kit";
import { isPublicAccountScopedKvKey } from "./reservedAccountScopedKvRow";

export interface KVBulkGetResult {
    values: Array<{
        key: string;
        value: string;
        version: number;
    }>;
}

/**
 * Get multiple key-value pairs for the authenticated user.
 * Only returns existing keys with non-null values; missing or deleted keys are omitted.
 */
export async function kvBulkGet(
    ctx: { uid: string },
    keys: string[]
): Promise<KVBulkGetResult> {
    const publicKeys = keys.filter(isPublicAccountScopedKvKey);
    if (publicKeys.length === 0) return { values: [] };

    const results = await db.userKVStore.findMany({
        where: {
            accountId: ctx.uid,
            key: {
                in: publicKeys
            },
            value: {
                not: null  // Exclude deleted entries
            }
        }
    });

    return {
        values: results
            .filter(r => r.value !== null)  // Extra safety check
            .map(r => ({
                key: r.key,
                value: privacyKit.encodeBase64(r.value!),
                version: r.version
            }))
    };
}
