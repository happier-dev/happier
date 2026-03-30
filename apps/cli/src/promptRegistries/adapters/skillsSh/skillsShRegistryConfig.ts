function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readUrlEnv(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw.replace(/\/+$/, '') : fallback;
}

export function readSkillsShBaseUrl(): string {
  return readUrlEnv('HAPPIER_SKILLS_SH_BASE_URL', 'https://skills.sh');
}

export function readSkillsShGitHubBaseUrl(): string {
  return readUrlEnv('HAPPIER_SKILLS_SH_GITHUB_BASE_URL', 'https://github.com');
}

export function readSkillsShFeaturedLimit(): number {
  return readPositiveIntegerEnv('HAPPIER_SKILLS_SH_FEATURED_LIMIT', 100);
}

export function readSkillsShSearchLimit(): number {
  return readPositiveIntegerEnv('HAPPIER_SKILLS_SH_SEARCH_LIMIT', 25);
}
