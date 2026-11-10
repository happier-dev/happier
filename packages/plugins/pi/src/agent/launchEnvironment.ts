import { PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES } from './auth/services/qualifiedPurposes.js';
import { PI_THINKING_LEVEL_ENV } from '../protocol/thinking.js';
import {
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  PI_REQUEST_AUTH_PRODUCER_VERSION_ENV,
} from './auth/services/requestAuth/index.js';
import { resolveSessionFileStoreLaunchEnvironment } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from './sessionFileStoreDescriptor.js';

export const PI_PROVIDER_SECRET_ENV_KEY = 'HAPPIER_PI_PROVIDER_API_KEY';
export const PI_CONNECTED_ACCOUNT_MODEL_ENV = 'HAPPIER_PI_CONNECTED_ACCOUNT_MODEL';

export const PI_DIRECT_AUTH_ENV_KEYS = Object.freeze([
  ...PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES.flatMap((row): readonly string[] => 'environmentKeys' in row.native ? row.native.environmentKeys : []),
  ...PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES.flatMap((row) => 'serviceAccount' in row.native ? [row.native.serviceAccount.environmentKey] : []),
  'OPENROUTER_API_KEY',
] as const);

const PI_INTERNAL_LAUNCH_ENV_KEYS = Object.freeze([
  PI_PROVIDER_SECRET_ENV_KEY,
  PI_CONNECTED_ACCOUNT_MODEL_ENV,
  PI_THINKING_LEVEL_ENV,
  'PI_OFFLINE',
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  PI_REQUEST_AUTH_PRODUCER_VERSION_ENV,
  'NODE_ENV',
  'DEBUG',
  'CI',
] as const);

const PI_ISOLATED_HOME_ENV_KEYS = Object.freeze([
  'HOME',
  'XDG_CONFIG_HOME',
  'USERPROFILE',
] as const);

const PI_MATERIALIZED_ENV_KEYS = Object.freeze([
  'PI_CODING_AGENT_DIR',
] as const);

export const PI_LAUNCH_ENV_KEYS = Object.freeze([
  ...PI_INTERNAL_LAUNCH_ENV_KEYS,
  ...PI_DIRECT_AUTH_ENV_KEYS,
  ...PI_ISOLATED_HOME_ENV_KEYS,
  ...PI_MATERIALIZED_ENV_KEYS,
] as const);

export type PiLaunchEnvironmentSelection = Readonly<{
  values: Readonly<Record<string, string>>;
  unset: readonly string[];
}>;

export function selectPiLaunchEnvironment(
  candidate: Readonly<Record<string, string | undefined>> | null | undefined,
): PiLaunchEnvironmentSelection {
  const values: Record<string, string> = {};
  const unset: string[] = [];
  const source = candidate ?? {};

  for (const key of PI_LAUNCH_ENV_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (typeof value === 'string') {
      values[key] = value;
    } else {
      unset.push(key);
    }
  }

  return Object.freeze({
    values: Object.freeze(values),
    unset: Object.freeze(unset),
  });
}

export function resolvePiSessionRuntimePreferences(params: Readonly<{
  settings?: Readonly<Record<string, unknown>>;
  environment: Readonly<Record<string, string | undefined>>;
}>): Readonly<{
  environmentVariables?: Readonly<Record<string, string>>;
  unsetEnvironmentVariables?: readonly string[];
}> {
  const selected = selectPiLaunchEnvironment(params.environment);
  const configuredAgentDir = resolveSessionFileStoreLaunchEnvironment({
    product: PI_SESSION_FILE_STORE_DESCRIPTOR_V1,
    settings: params.settings,
    env: params.environment,
  });
  const values = Object.freeze({ ...selected.values, ...configuredAgentDir });
  return Object.freeze({
    ...(Object.keys(values).length > 0
      ? { environmentVariables: values }
      : {}),
    ...(selected.unset.length > 0
      ? { unsetEnvironmentVariables: selected.unset }
      : {}),
  });
}
