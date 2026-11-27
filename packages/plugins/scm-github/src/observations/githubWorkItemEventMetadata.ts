type JsonRecord = Readonly<Record<string, unknown>>;

export type GithubWorkItemEventMetadata = Readonly<{
  labels?: readonly string[];
  assignees?: readonly string[];
}>;

function readName(value: unknown, key: 'name' | 'login'): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const name = (value as JsonRecord)[key];
  return typeof name === 'string' && name.trim() ? name : undefined;
}

export function readGithubEventLabelName(value: unknown): string | undefined {
  return readName(value, 'name');
}

function readNames(value: unknown, key: 'name' | 'login'): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const entry of value) {
    const name = readName(entry, key);
    if (name === undefined) return undefined;
    names.push(name);
  }
  return Object.freeze(names);
}

/** GitHub's repository Events can supply the same snapshot on the surrounding payload. */
export function readGithubWorkItemEventMetadata(item: JsonRecord, payload?: JsonRecord): GithubWorkItemEventMetadata {
  const labels = readNames(item.labels, 'name') ?? readNames(payload?.labels, 'name');
  const assignees = readNames(item.assignees, 'login') ?? readNames(payload?.assignees, 'login');
  return {
    ...(labels === undefined ? {} : { labels }),
    ...(assignees === undefined ? {} : { assignees }),
  };
}
