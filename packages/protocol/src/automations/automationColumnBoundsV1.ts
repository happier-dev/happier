/**
 * Every client- or plugin-supplied Automation integer persists as a 32-bit
 * signed column on all three supported datasources: `AutomationTrigger.everyMs`
 * and `AutomationTrigger.sourceContractVersion` are declared `Int?` in
 * `apps/server/prisma/schema.prisma`, `prisma/mysql/schema.prisma` and
 * `prisma/sqlite/schema.prisma`. A wider value cannot be written on
 * Postgres/MySQL and cannot be read back on SQLite, so admission rejects it
 * with a typed validation error instead of letting it reach the database.
 *
 * Schedule admission, Event source-contract admission, and the interval
 * authoring surfaces all derive their ceiling from this one owner.
 */
export const AUTOMATION_INT_COLUMN_MAX = 2_147_483_647;
