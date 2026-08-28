function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

/** Reads both GraphQL transport errors and mutation payload errors. */
export function readGitlabGraphqlMutationErrors(body: unknown, field: string): readonly string[] {
  const root = record(body);
  if (root === null) return [];
  const messages: string[] = [];
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      const message = typeof entry === 'string' ? entry : record(entry)?.message;
      if (typeof message === 'string' && message.trim() !== '') messages.push(message.trim());
    }
  };
  collect(root.errors);
  collect(record(record(root.data)?.[field])?.errors);
  return messages;
}
