import { join } from 'node:path';

import { openSqliteDatabaseSync } from '@/utils/sqlite/sqliteSync';

/** The native API omits created_at_ms for imported items with no lifecycle times. */
export function readCodexNativeHistoryTimestamps(params: Readonly<{
  sqliteHome: string;
  threadId: string;
  items: readonly Readonly<{ turnId: string; itemId: string }>[];
}>): Map<string, number> {
  const dates = new Map<string, number>();
  if (params.items.length === 0) return dates;
  const database = openSqliteDatabaseSync(join(params.sqliteHome, 'thread_history_1.sqlite'), { readOnly: true });
  try {
    // Join only this page's identities to the native primary key; never scan transcript bodies.
    const rows = database.prepare(`
      SELECT history.turn_id, history.item_id, history.created_at_ms
      FROM json_each(?) AS requested
      JOIN thread_items AS history ON history.thread_id = ?
        AND history.turn_id = json_extract(requested.value, '$.turnId')
        AND history.item_id = json_extract(requested.value, '$.itemId')
    `).all(JSON.stringify(params.items), params.threadId);
    for (const row of rows) {
      const value = row as { turn_id: string; item_id: string; created_at_ms: unknown };
      if (typeof value.created_at_ms === 'number' && Number.isSafeInteger(value.created_at_ms) && value.created_at_ms > 0) {
        dates.set(JSON.stringify([value.turn_id, value.item_id]), value.created_at_ms);
      }
    }
    return dates;
  } finally { database.close(); }
}
