type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

/**
 * Apply a Claude-style `updatedPermissions` payload to a session allowlist.
 *
 * This is best-effort: we only apply `addRules` updates with `behavior: 'allow'`.
 */
export function applyUpdatedPermissionsToAllowlist(allowedIdentifiers: Set<string>, updatedPermissions: unknown): void {
  if (!Array.isArray(updatedPermissions) || updatedPermissions.length === 0) return;

  for (const update of updatedPermissions) {
    const rec = asRecord(update);
    if (!rec) continue;
    if (rec.type !== 'addRules' || rec.behavior !== 'allow') continue;

    const rules = asStringArray(rec.rules) ?? (Array.isArray(rec.rules) ? (rec.rules as unknown[]) : null);
    if (!rules || rules.length === 0) continue;

    // Rules can be either string identifiers (rare) or objects like `{ toolName, ruleContent }`.
    for (const rule of rules) {
      if (typeof rule === 'string') {
        const trimmed = rule.trim();
        if (trimmed) allowedIdentifiers.add(trimmed);
        continue;
      }

      const ruleRec = asRecord(rule);
      if (!ruleRec) continue;

      const toolName = typeof ruleRec.toolName === 'string' ? ruleRec.toolName.trim() : '';
      if (!toolName) continue;

      const ruleContent = typeof ruleRec.ruleContent === 'string' ? ruleRec.ruleContent.trim() : '';
      if (ruleContent) {
        allowedIdentifiers.add(`${toolName}(${ruleContent})`);
      } else {
        allowedIdentifiers.add(toolName);
      }
    }
  }
}

export function applyAllowedToolsToAllowlist(allowedIdentifiers: Set<string>, allowedTools: unknown): void {
  const list = asStringArray(allowedTools);
  if (!list || list.length === 0) return;
  for (const item of list) {
    const trimmed = item.trim();
    if (trimmed) allowedIdentifiers.add(trimmed);
  }
}

export function seedAllowlistFromCompletedRequests(allowedIdentifiers: Set<string>, completedRequests: unknown): void {
  const rec = asRecord(completedRequests);
  if (!rec) return;

  for (const value of Object.values(rec)) {
    const entry = asRecord(value);
    if (!entry) continue;
    if (entry.status !== 'approved') continue;

    applyUpdatedPermissionsToAllowlist(allowedIdentifiers, entry.updatedPermissions);
    applyAllowedToolsToAllowlist(allowedIdentifiers, entry.allowedTools ?? entry.allowTools);
  }
}
