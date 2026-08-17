import { asRecord, normalizeString } from './openCodeParsing.js';

export function normalizeOpenCodeSkills(value: unknown): Array<{
  name: string;
  displayName: string;
  description?: string;
  path?: string;
  origin: 'opencode_native';
  enabled: true;
}> {
  if (!Array.isArray(value)) return [];
  const skills = [];
  for (const raw of value) {
    const record = asRecord(raw);
    const name = normalizeString(record?.name);
    if (!name) continue;
    const description = normalizeString(record?.description);
    const path = normalizeString(record?.location);
    skills.push({
      name,
      displayName: name,
      ...(description ? { description } : {}),
      ...(path ? { path } : {}),
      origin: 'opencode_native' as const,
      enabled: true as const,
    });
  }
  return skills;
}
