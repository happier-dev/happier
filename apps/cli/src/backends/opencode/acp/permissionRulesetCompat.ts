function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAction(value: unknown): 'allow' | 'deny' | 'ask' | null {
  if (typeof value !== 'string') return 'ask';
  const lower = value.trim().toLowerCase();
  if (lower === 'allow' || lower === 'deny' || lower === 'ask') return lower;

  // OpenCode has been observed to emit additional action strings in ACP permission payloads.
  // Fail-closed by coercing to "ask" unless we can safely map to a stricter intent.
  if (lower === 'prompt' || lower === 'confirm' || lower === 'ask-user' || lower === 'ask_user' || lower === 'askuser') {
    return 'ask';
  }
  if (lower === 'reject' || lower === 'block' || lower === 'disallow') {
    return 'deny';
  }
  if (lower === 'approve' || lower === 'permit' || lower === 'allowed') {
    return 'allow';
  }

  return 'ask';
}

function coerceRulesetActions(node: unknown): boolean {
  let changed = false;

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;

    for (const [key, child] of Object.entries(value)) {
      if (key === 'ruleset' && Array.isArray(child)) {
        for (const rule of child) {
          if (!isRecord(rule)) continue;
          const coerced = normalizeAction('action' in rule ? rule.action : undefined);
          const current = typeof rule.action === 'string' ? rule.action.trim().toLowerCase() : null;
          if (current !== coerced) {
            rule.action = coerced;
            changed = true;
          }
        }
      } else {
        visit(child);
      }
    }
  };

  visit(node);
  return changed;
}

/**
 * OpenCode ACP compatibility: coerce invalid permission ruleset action values to spec-compatible values.
 *
 * Some OpenCode versions emit additional action strings in permission payloads. The upstream ACP SDK
 * validates those messages strictly and rejects them, which can cause tool calls to fail.
 *
 * This normalizes any nested `ruleset[].action` to `allow|deny|ask` across JSON payloads
 * passed through this compat layer.
 */
export function normalizeOpenCodeAcpPermissionRulesetActions(jsonLine: string): string | null {
  const trimmed = jsonLine.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }

  if (!isRecord(parsed)) return trimmed;
  const changed = coerceRulesetActions(parsed);
  if (!changed) return trimmed;
  return JSON.stringify(parsed);
}
