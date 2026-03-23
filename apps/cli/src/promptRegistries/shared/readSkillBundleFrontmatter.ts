export function readSkillBundleFrontmatter(markdown: string): Readonly<{
  name?: string;
  description?: string;
}> {
  const normalized = String(markdown ?? '');
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return {};

  const lines = match[1].split('\n');
  const out: { name?: string; description?: string } = {};
  for (const line of lines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!value) continue;
    if (key === 'name') out.name = value;
    if (key === 'description') out.description = value;
  }
  return out;
}
