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
  const jsonFlag = '--secrets-json-stdin';
  const recoveryKeyFlag = '--recovery-key-stdin';
  const jsonCount = args.filter((arg) => arg === jsonFlag).length;
  const recoveryKeyCount = args.filter((arg) => arg === recoveryKeyFlag).length;
  if (!jsonCount && !recoveryKeyCount) return [...args];
  if (jsonCount + recoveryKeyCount !== 1) throw new AuthSecretsStdinError('Use one auth secrets stdin option.');
  if (recoveryKeyCount) {
    if (args.some((arg) => arg === '--recovery-key' || arg.startsWith('--recovery-key='))) {
      throw new AuthSecretsStdinError('Do not combine --recovery-key with --recovery-key-stdin.');
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
  }

  const entered = Buffer.concat(chunks).toString('utf8');
  if (recoveryKeyCount) {
    return [...args.filter((arg) => arg !== recoveryKeyFlag), '--recovery-key', entered];
  }

  let value: unknown;
  try {
    value = JSON.parse(entered);
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
