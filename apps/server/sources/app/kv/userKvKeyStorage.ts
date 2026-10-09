import type { DbProvider } from '@/storage/prisma';

/**
 * MySQL's full utf8mb4 Account/key unique index has 3,072 bytes with the
 * supported InnoDB DYNAMIC row format and default 16-KiB pages. accountId
 * retains its existing VARCHAR(191); each utf8mb4 character reserves four
 * bytes. Profile's retained ID schema is unbounded, so storage admission,
 * rather than truncation or a replacement identity, owns this physical limit.
 */
export const MYSQL_USER_KV_KEY_MAX_CHARACTERS = (3_072 / 4) - 191;

export class UserKvKeyTooLongError extends Error {
    readonly code = 'kv-key-too-long' as const;
    readonly maximumCharacters = MYSQL_USER_KV_KEY_MAX_CHARACTERS;

    constructor() {
        super('UserKVStore key exceeds MySQL indexed storage capacity');
        this.name = 'UserKvKeyTooLongError';
    }
}

export function assertUserKvKeyStorageAdmission(key: string, provider: DbProvider): void {
    if (provider !== 'mysql' || key.length <= MYSQL_USER_KV_KEY_MAX_CHARACTERS) return;
    // MySQL VARCHAR counts Unicode characters, not JavaScript UTF-16 units.
    // Stop at the physical boundary without allocating a copy of a large key.
    let characters = 0;
    for (const _character of key) {
        if (++characters > MYSQL_USER_KV_KEY_MAX_CHARACTERS) throw new UserKvKeyTooLongError();
    }
}
