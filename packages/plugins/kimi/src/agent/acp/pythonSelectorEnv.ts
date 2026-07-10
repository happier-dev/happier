import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  normalizeKimiAcpPythonSelector,
  type KimiAcpPythonSelector,
} from '../preferences/pythonSelector.js';

export { normalizeKimiAcpPythonSelector };
export type { KimiAcpPythonSelector };

const SITE_CUSTOMIZE = `import selectors

# Force asyncio SelectorEventLoop to use poll() instead of epoll().
selectors.DefaultSelector = selectors.PollSelector
`;

const SHIM_DIR_PREFIX = 'kimi-acp-poll-selector-';

export function resolveKimiAcpPythonSelectorChildEnv(params: Readonly<{
  selector?: unknown;
  env?: Readonly<Record<string, string | undefined>>;
  inheritedEnv?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  shimBaseDir?: string;
}>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.env ?? {})) {
    if (typeof value === 'string') env[key] = value;
  }

  const selector = normalizeKimiAcpPythonSelector(params.selector) ?? 'auto';
  const platform = params.platform ?? process.platform;
  if (selector !== 'poll' || platform !== 'linux') {
    return env;
  }

  const shimBaseDir = params.shimBaseDir ?? tmpdir();
  mkdirSync(shimBaseDir, { recursive: true, mode: 0o700 });
  const shimDir = mkdtempSync(join(shimBaseDir, SHIM_DIR_PREFIX));
  chmodSync(shimDir, 0o700);
  writeFileSync(join(shimDir, 'sitecustomize.py'), SITE_CUSTOMIZE, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });

  const envHasPythonPath = Object.prototype.hasOwnProperty.call(env, 'PYTHONPATH');
  const envPythonPath = typeof env.PYTHONPATH === 'string' && env.PYTHONPATH.trim().length > 0
    ? env.PYTHONPATH
    : null;
  const inheritedPythonPath =
    !envHasPythonPath && typeof params.inheritedEnv?.PYTHONPATH === 'string' && params.inheritedEnv.PYTHONPATH.trim().length > 0
      ? params.inheritedEnv.PYTHONPATH
      : null;
  const existingPythonPath = envPythonPath ?? inheritedPythonPath;
  env.PYTHONPATH = existingPythonPath ? `${shimDir}${delimiter}${existingPythonPath}` : shimDir;
  return env;
}
