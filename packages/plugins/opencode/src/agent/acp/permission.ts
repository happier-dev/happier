function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAction(value: unknown): 'allow' | 'deny' | 'ask' {
  if (typeof value !== 'string') return 'ask';
  const lower = value.trim().toLowerCase();
  if (lower === 'allow' || lower === 'deny' || lower === 'ask') return lower;

  if (
    lower === 'prompt'
    || lower === 'confirm'
    || lower === 'ask-user'
    || lower === 'ask_user'
    || lower === 'askuser'
  ) {
    return 'ask';
  }
  if (lower === 'reject' || lower === 'block' || lower === 'disallow') return 'deny';
  if (lower === 'approve' || lower === 'permit' || lower === 'allowed') return 'allow';

  return 'ask';
}

function normalizeNode(value: unknown): Readonly<{ value: unknown; changed: boolean }> {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((entry) => {
      const normalized = normalizeNode(entry);
      changed = changed || normalized.changed;
      return normalized.value;
    });
    return { value: changed ? out : value, changed };
  }

  if (!isRecord(value)) {
    return { value, changed: false };
  }

  let changed = false;
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === 'ruleset' && Array.isArray(child)) {
      const rules = child.map((rule) => {
        if (!isRecord(rule)) return rule;
        const action = normalizeAction('action' in rule ? rule.action : undefined);
        const current = typeof rule.action === 'string' ? rule.action.trim().toLowerCase() : null;
        if (current === action) return rule;
        changed = true;
        return { ...rule, action };
      });
      entries.push([key, changed ? rules : child]);
      continue;
    }

    const normalized = normalizeNode(child);
    changed = changed || normalized.changed;
    entries.push([key, normalized.value]);
  }

  return { value: changed ? Object.fromEntries(entries) : value, changed };
}

export function normalizeOpenCodeAcpPermissionRulesetMessage(message: unknown): unknown | null {
  const normalized = normalizeNode(message);
  return normalized.changed ? normalized.value : null;
}
