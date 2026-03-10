export function resolveOpenCodeServerBasicAuthHeaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const password = typeof env.OPENCODE_SERVER_PASSWORD === 'string' ? env.OPENCODE_SERVER_PASSWORD : '';
  if (!password) return null;
  const username = typeof env.OPENCODE_SERVER_USERNAME === 'string' && env.OPENCODE_SERVER_USERNAME.trim().length > 0
    ? env.OPENCODE_SERVER_USERNAME.trim()
    : 'opencode';
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

export function resolveOpenCodeServerAuthHeadersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const authHeader = resolveOpenCodeServerBasicAuthHeaderFromEnv(env);
  return authHeader ? { Authorization: authHeader } : {};
}
