import type { Readable } from 'node:stream';

import { SENSITIVE_CLI_VALUE_FLAG_DEFINITIONS } from '@/auth/cliApiToken';

const AUTH_SECRET_FLAGS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  SENSITIVE_CLI_VALUE_FLAG_DEFINITIONS.flatMap(entry => 'stdinField' in entry ? [[entry.stdinField, entry.flag]] : []),
));

export class AuthSecretsStdinError extends Error {}

export async function expandAuthSecretsFromStdin(
  args: readonly string[],
  input: Readable = process.stdin,
): Promise<string[]> {
  const occurrences = args.filter((arg) => arg === '--secrets-json-stdin').length;
  if (occurrences === 0) return [...args];
  if (occurrences !== 1) throw new AuthSecretsStdinError('Use --secrets-json-stdin only once.');

  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AuthSecretsStdinError('Auth secrets stdin must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthSecretsStdinError('Auth secrets stdin must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || !record.secrets || typeof record.secrets !== 'object' || Array.isArray(record.secrets)
    || Object.keys(record).some((key) => key !== 'v' && key !== 'secrets')) {
    throw new AuthSecretsStdinError('Auth secrets stdin must be {"v":1,"secrets":{...}}.');
  }

  const output = args.filter((arg) => arg !== '--secrets-json-stdin');
  for (const [key, secret] of Object.entries(record.secrets as Record<string, unknown>)) {
    const flag = AUTH_SECRET_FLAGS[key];
    if (!flag || typeof secret !== 'string' || secret.length === 0) {
      throw new AuthSecretsStdinError(`Invalid auth secret field: ${key}.`);
    }
    if (output.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) {
      throw new AuthSecretsStdinError(`Do not combine ${flag} with its stdin secret field.`);
    }
    output.push(flag, secret);
  }
  return output;
}
