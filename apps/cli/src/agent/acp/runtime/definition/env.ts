export function withAcpLaunchEnvDefaults(
  env: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(env ?? {}),
    NODE_ENV: env?.NODE_ENV ?? 'production',
    DEBUG: env?.DEBUG ?? '',
  });
}

export function redactAcpLaunchEnv(
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const redacted: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    redacted[key] = '[redacted]';
  }
  return Object.freeze(redacted);
}
