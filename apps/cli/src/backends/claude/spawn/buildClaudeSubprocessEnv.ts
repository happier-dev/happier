import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR,
  parseExplicitSpawnEnvKeysFromProcessEnv,
} from '@/daemon/spawn/spawnExplicitEnvKeysMarker';
import { isValidEnvVarKey } from '@/terminal/runtime/envVarSanitization';
import { isAllowedExactEnvKey } from '@/utils/env/isAllowedExactEnvKey';
import { isWindowsSystemEnvKey } from '@/utils/env/windowsSystemEnv';

import { resolveClaudeConfigDirEnvOverlay } from '../utils/resolveClaudeConfigDirEnvOverlay';
import { isolateClaudeRuntimeAuthEnv } from './isolateClaudeRuntimeAuthEnv';
import { resolveClaudeExternalSandboxEnv } from './resolveClaudeExternalSandboxEnv';
import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv';

export function prepareClaudeSubprocessEnv(params: Readonly<{
  baseEnv: NodeJS.ProcessEnv;
  envOverlay?: Readonly<NodeJS.ProcessEnv>;
}>): NodeJS.ProcessEnv {
  const env = stripNestedSessionDetectionEnv({ ...params.baseEnv, ...params.envOverlay });
  if (typeof params.envOverlay?.CLAUDE_CODE_ENTRYPOINT === 'string') {
    env.CLAUDE_CODE_ENTRYPOINT = params.envOverlay.CLAUDE_CODE_ENTRYPOINT;
  }
  delete env[HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR];
  return isolateClaudeRuntimeAuthEnv(env);
}

export function buildClaudeSubprocessEnv(params?: Readonly<{
  baseEnv?: NodeJS.ProcessEnv;
  envOverlay?: Readonly<Record<string, string>>;
}>): Record<string, string> {
  const baseEnv = params?.baseEnv ?? process.env;
  const explicitSpawnEnvKeys = new Set(parseExplicitSpawnEnvKeysFromProcessEnv(baseEnv));
  const allowExact = new Set<string>([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TERM',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SSH_AUTH_SOCK',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    '__CF_USER_TEXT_ENCODING',
    'HAPPIER_E2E_FAKE_CLAUDE_LOG',
    'HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID',
    'HAPPY_E2E_FAKE_CLAUDE_LOG',
    'HAPPY_E2E_FAKE_CLAUDE_SESSION_ID',
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
    HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  ]);

  const allowPrefixes = [
    'XDG_',
    'CLAUDE_',
    'ANTHROPIC_',
    'FORCE_COLOR',
    'NO_COLOR',
    'COLORTERM',
    'TERM_',
    'HAPPIER_E2E_',
    'HAPPY_E2E_',
  ];

  const out: Record<string, string> = Object.create(null);
  const denyExact = new Set<string>([
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'CLAUDE_CODE_OAUTH_SCOPES',
  ]);

  for (const [key, value] of Object.entries(baseEnv)) {
    const windowsSystemKey = isWindowsSystemEnvKey(key);
    // Windows defines system names such as ProgramFiles(x86), which are not
    // valid POSIX shell assignment names. Do not widen explicit env validation.
    if (!windowsSystemKey && !isValidEnvVarKey(key)) continue;
    if (denyExact.has(key)) continue;
    if (typeof value !== 'string') continue;
    if (windowsSystemKey || explicitSpawnEnvKeys.has(key) || isAllowedExactEnvKey(key, allowExact) || allowPrefixes.some((prefix) => key.startsWith(prefix))) {
      out[key] = value;
    }
  }

  delete out[HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR];
  const env = prepareClaudeSubprocessEnv({
    baseEnv: out,
    envOverlay: {
      ...resolveClaudeExternalSandboxEnv(baseEnv),
      ...resolveClaudeConfigDirEnvOverlay(baseEnv),
      ...(params?.envOverlay ?? {}),
    },
  });
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
