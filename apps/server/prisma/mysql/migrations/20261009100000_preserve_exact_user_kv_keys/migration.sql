-- Retained Profile IDs have no protocol length bound. Preserve their canonical
-- encoded keys exactly, including case, within InnoDB's full 3,072-byte index:
-- (191 accountId characters + 577 key characters) * 4 utf8mb4 bytes = 3,072.
-- Existing rows, values, versions and the complete unique index are retained.
ALTER TABLE `UserKVStore`
    ROW_FORMAT=DYNAMIC,
    MODIFY COLUMN `key` VARCHAR(577) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
