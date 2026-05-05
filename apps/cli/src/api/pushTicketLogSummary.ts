function shouldOmitKey(key: string): boolean {
  return /(token|authorization|cookie|password)/i.test(key);
}

const EXPO_PUSH_TOKEN_PATTERN = /(?:Exponent|Expo)PushToken\[[^\]]+\]/g;

function redactStringValue(value: string): string {
  return value.replace(EXPO_PUSH_TOKEN_PATTERN, '[REDACTED]');
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (typeof value === 'string') return redactStringValue(value);
  if (!value || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (shouldOmitKey(k)) continue;
    const next = redactValue(v, depth + 1);
    // Avoid keeping empty objects around.
    if (next && typeof next === 'object' && !Array.isArray(next) && Object.keys(next).length === 0) continue;
    out[k] = next;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function summarizeExpoPushTicketErrorsForLog(tickets: ReadonlyArray<unknown>): Array<{ message?: string; details?: unknown }> {
  const out: Array<{ message?: string; details?: unknown }> = [];

  for (const ticket of tickets) {
    if (!isRecord(ticket)) continue;
    if (ticket.status !== 'error') continue;

    const message = typeof ticket.message === 'string' ? redactStringValue(ticket.message) : undefined;
    const details = ticket.details !== undefined ? redactValue(ticket.details, 0) : undefined;
    out.push(details !== undefined ? { message, details } : { message });
  }

  return out;
}
