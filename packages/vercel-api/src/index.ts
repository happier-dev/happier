export type VercelProjectChoice = Readonly<{ id: string; name: string }>;
type ProjectPage = Readonly<{ choices: readonly VercelProjectChoice[]; nextCursor?: string }>;

/** Both forms of continuation documented by the Vercel v10 projects endpoint. */
export function vercelProjectsPageUrl(input: Readonly<({ accountId: string } | { teamId: string }) & {
  search?: string;
  cursor?: string;
  limit?: number;
}>): URL | null {
  const url = new URL('https://api.vercel.com/v10/projects');
  const teamId = 'teamId' in input ? input.teamId : input.accountId.startsWith('team_') ? input.accountId : undefined;
  if (teamId) url.searchParams.set('teamId', teamId);
  if (input.search) url.searchParams.set('search', input.search);
  if (input.limit !== undefined) url.searchParams.set('limit', String(input.limit));
  if (input.cursor) {
    const divider = input.cursor.indexOf(':');
    if (divider < 0) return null;
    const kind = input.cursor.slice(0, divider);
    const value = input.cursor.slice(divider + 1);
    if ((kind !== 'until' && kind !== 'from') || !value) return null;
    url.searchParams.set(kind, value);
  }
  return url;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function decodeVercelProjectsPage(value: unknown, accountId: string): ProjectPage | null {
  const projects = record(value) ? value.projects : value;
  if (!Array.isArray(projects)) return null;
  const choices: VercelProjectChoice[] = [];
  for (const project of projects) {
    if (!record(project) || project.accountId !== accountId
      || typeof project.id !== 'string' || !project.id || /\s/u.test(project.id)
      || project.id === '.' || project.id === '..'
      || typeof project.name !== 'string' || !project.name.trim()) return null;
    choices.push({ id: project.id, name: project.name });
  }

  if (Array.isArray(value)) return { choices };
  const pagination = record(value) ? value.pagination : undefined;
  if (!record(pagination)) return null;
  const next = pagination.next;
  if (next === null) return { choices };
  if (typeof next === 'number' && Number.isSafeInteger(next)) return { choices, nextCursor: `until:${next}` };
  if (typeof next === 'string' && next.length > 0) return { choices, nextCursor: `from:${next}` };
  return null;
}
