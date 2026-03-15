export function parseGithubPullRequest(input) {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    return { number: Number(raw), owner: null, repo: null };
  }
  // owner/repo#<num> (common shorthand in CLI/issue trackers)
  const shorthand = raw.match(/^(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)#(?<num>\d+)$/);
  if (shorthand?.groups?.num) {
    return {
      number: Number(shorthand.groups.num),
      owner: shorthand.groups.owner ?? null,
      repo: shorthand.groups.repo ?? null,
    };
  }
  // owner/repo/pull/<num> (GitHub path form without scheme/host)
  const pathForm = raw.match(/^(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)\/pull\/(?<num>\d+)$/);
  if (pathForm?.groups?.num) {
    return {
      number: Number(pathForm.groups.num),
      owner: pathForm.groups.owner ?? null,
      repo: pathForm.groups.repo ?? null,
    };
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
