import { DaemonMcpServersPreviewResponseSchema } from '@happier-dev/protocol/mcp/servers/previewV1';

/** Released Action presentation is a projection of the canonical machine producer. */
export function projectSpawnMcpServersPreviewInventory(raw: unknown, limit?: number) {
  const preview = DaemonMcpServersPreviewResponseSchema.parse(raw);
  const entries = preview.ok ? [...preview.builtIn, ...preview.managed, ...preview.detected] : [];
  const items = entries.map(entry => ({ value: entry.key, label: entry.title ?? entry.name,
    selected: entry.selected, selectable: entry.selectable, sourceKind: entry.sourceKind,
    authMode: entry.authMode, availability: entry.availability }));
  // This is the released options-list bound, not a limit on generic capabilities.
  const bounded = typeof limit === 'number' && Number.isFinite(limit) && Math.floor(limit) > 0 ? Math.min(Math.floor(limit), 200) : null;
  return { ok: preview.ok, items: bounded ? items.slice(0, bounded) : items, preview };
}
