import { readFile } from 'node:fs/promises';

import { parseEnvToObject } from '../../utils/env/dotenv.mjs';
import { ensureEnvFileUpdated } from '../../utils/env/env_file.mjs';

export async function ensureStackRuntimeModePrefer({ envPath }) {
  const path = String(envPath ?? '').trim();
  if (!path) {
    return { ok: false, changed: false, reason: 'missing_env_path' };
  }

  let existing = '';
  try {
    existing = await readFile(path, 'utf-8');
  } catch {
    existing = '';
  }

  const parsed = existing ? parseEnvToObject(existing) : {};
  if (Object.prototype.hasOwnProperty.call(parsed, 'HAPPIER_STACK_RUNTIME_MODE')) {
    return { ok: true, changed: false, previous: parsed.HAPPIER_STACK_RUNTIME_MODE };
  }

  await ensureEnvFileUpdated({
    envPath: path,
    updates: [{ key: 'HAPPIER_STACK_RUNTIME_MODE', value: 'prefer' }],
  });

  return { ok: true, changed: true, previous: null };
}
