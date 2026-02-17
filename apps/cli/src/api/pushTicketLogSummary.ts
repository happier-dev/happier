function shouldOmitKey(key: string): boolean {
  return /(token|authorization|cookie|password)/i.test(key);
}

function redactStringValue(value: string): string {
  if (value.includes('ExponentPushToken[')) return '[REDACTED]';
  return value;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (typeof value === 'string') return redactStringValue(value);
  if (!value || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (shouldOmitKey(k)) continue;
    const next = redactValue(v, depth + 1);
    // Avoid keeping empty objects around.
    if (next && typeof next === 'object' && !Array.isArray(next) && Object.keys(next as any).length === 0) continue;
    out[k] = next;
  }
  return out;
}

export function summarizeExpoPushTicketErrorsForLog(tickets: ReadonlyArray<unknown>): Array<{ message?: string; details?: unknown }> {
  const out: Array<{ message?: string; details?: unknown }> = [];

  for (const ticket of tickets) {
    if (!ticket || typeof ticket !== 'object') continue;
    const t = ticket as any;
    if (t.status !== 'error') continue;

    const message = typeof t.message === 'string' ? t.message : undefined;
    const details = t.details !== undefined ? redactValue(t.details, 0) : undefined;
    out.push(details !== undefined ? { message, details } : { message });
  }

  return out;
}

