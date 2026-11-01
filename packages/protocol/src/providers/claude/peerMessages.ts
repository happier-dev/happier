/**
 * Claude native peer deliveries (subagent hand-backs, teammate and cross-session messages) reach
 * clients as sender-labelled `user` transcript rows with `origin.kind === 'peer'`. The label keeps
 * released clients readable; current clients read the sender and body back through this owner.
 */
export type ClaudePeerMessage = Readonly<{
  name: string | null;
  handback: boolean;
  text: string;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function formatClaudePeerMessageText(name: string | null, text: string): string {
  return `From ${name ?? 'Peer'}:\n\n${text}`;
}

export function readClaudePeerMessage(row: unknown): ClaudePeerMessage | null {
  const record = asRecord(row);
  if (!record || record.type !== 'user') return null;
  const origin = asRecord(record.origin);
  if (origin?.kind !== 'peer') return null;
  const content = asRecord(record.message)?.content;
  if (typeof content !== 'string') return null;
  const name = nonBlank(origin.name);
  const label = formatClaudePeerMessageText(name, '');
  return { name, handback: origin.handback === true, text: content.startsWith(label) ? content.slice(label.length) : content };
}
