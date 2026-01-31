export function parseGithubPullRequest(input) {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    return { number: Number(raw), owner: null, repo: null };
  }
  // https://github.com/<owner>/<repo>/pull/<num>
  const m = raw.match(/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<num>\d+)/);
  if (!m?.groups?.num) return null;
  return {
    number: Number(m.groups.num),
    owner: m.groups.owner ?? null,
    repo: m.groups.repo ?? null,
  };
}

export function sanitizeSlugPart(s) {
  return (s ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

