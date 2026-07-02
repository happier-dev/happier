export const HAPPIER_AUGGIE_ALLOW_INDEXING_ENV = 'HAPPIER_AUGGIE_ALLOW_INDEXING';

export function readAuggieAllowIndexingFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = typeof env[HAPPIER_AUGGIE_ALLOW_INDEXING_ENV] === 'string'
    ? env[HAPPIER_AUGGIE_ALLOW_INDEXING_ENV].trim().toLowerCase()
    : '';
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
