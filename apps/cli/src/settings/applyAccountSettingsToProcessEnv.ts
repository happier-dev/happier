import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { parseExplicitSpawnEnvKeysFromProcessEnv } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';

type AccountSettingsEnvInput = Readonly<Record<string, unknown> & {
  scmIncludeCoAuthoredBy?: boolean;
  backendCliSourcePreferenceById?: unknown;
  backendCliSourcePreferenceByTargetKey?: unknown;
}>;

const accountSettingsEnvironmentFields = [
  ['backendCliSourcePreferences', 'HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON'],
  ['scmIncludeCoAuthoredBy', 'HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY'],
] as const;

type AccountSettingsEnvironmentProjection = Record<typeof accountSettingsEnvironmentFields[number][0], string | null>;

// Ownership of a settings-managed value follows its environment, so another Session's
// explicit override cannot retire this Session's managed defaults.
let projectionByEnvironment = new WeakMap<NodeJS.ProcessEnv, AccountSettingsEnvironmentProjection>();

export function __resetApplyAccountSettingsToProcessEnvStateForTests(): void {
  projectionByEnvironment = new WeakMap();
}

export function readAccountSettingsEnvironmentOverrideKeys(environment: NodeJS.ProcessEnv): readonly string[] {
  const projection = projectionByEnvironment.get(environment);
  return [
    ...accountSettingsEnvironmentFields.flatMap(([field, key]) => (
      typeof environment[key] === 'string' && environment[key] !== projection?.[field] ? [key] : []
    )),
    ...(typeof environment.HAPPIER_ACTIONS_SETTINGS_V1 === 'string' ? ['HAPPIER_ACTIONS_SETTINGS_V1'] : []),
  ];
}

export function applyAccountSettingsToProcessEnv(params: Readonly<{
  settings: AccountSettingsEnvInput;
}>): void {
  const environment = sessionProcessEnvironment();
  const explicitKeys = parseExplicitSpawnEnvKeysFromProcessEnv(environment);
  let projection = projectionByEnvironment.get(environment);
  if (!projection) {
    // A daemon-admitted carrier identifies inherited Account defaults even across
    // the separate host process. Unmarked shell callers retain their explicit values.
    const inheritedValue = (key: string) => explicitKeys !== null && !explicitKeys.includes(key)
      ? environment[key] ?? null : null;
    projection = {
      backendCliSourcePreferences: inheritedValue('HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON'),
      scmIncludeCoAuthoredBy: inheritedValue('HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY'),
    };
    projectionByEnvironment.set(environment, projection);
  }
  const currentScmEnvValue = typeof environment.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY === 'string'
    ? environment.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY
    : null;
  if (projection.scmIncludeCoAuthoredBy !== null && currentScmEnvValue !== projection.scmIncludeCoAuthoredBy) {
    projection.scmIncludeCoAuthoredBy = null;
  }
  if (!explicitKeys?.includes('HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY')
    && (currentScmEnvValue === null || projection.scmIncludeCoAuthoredBy !== null)) {
    const raw = params.settings?.scmIncludeCoAuthoredBy;
    if (typeof raw === 'boolean') {
      const nextValue = raw ? '1' : '0';
      environment.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = nextValue;
      projection.scmIncludeCoAuthoredBy = nextValue;
    } else if (projection.scmIncludeCoAuthoredBy !== null) {
      delete environment.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
      projection.scmIncludeCoAuthoredBy = null;
    }
  }

  const rawPreferences = params.settings.backendCliSourcePreferenceByTargetKey ?? params.settings.backendCliSourcePreferenceById;
  const parsed =
    rawPreferences && typeof rawPreferences === 'object' && !Array.isArray(rawPreferences)
      ? Object.fromEntries(
          Object.entries(rawPreferences).filter(
            ([, value]) => value === 'system-first' || value === 'managed-first',
          ),
        )
      : null;
  const envAlreadySet = typeof environment.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON === 'string';
  const currentEnvValue = envAlreadySet ? environment.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON ?? null : null;
  if (projection.backendCliSourcePreferences !== null && currentEnvValue !== projection.backendCliSourcePreferences) {
    projection.backendCliSourcePreferences = null;
  }
  if (!explicitKeys?.includes('HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON')
    && (!envAlreadySet || projection.backendCliSourcePreferences !== null)) {
    if (parsed && Object.keys(parsed).length > 0) {
      try {
        const serialized = JSON.stringify(parsed);
        environment.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON = serialized;
        projection.backendCliSourcePreferences = serialized;
      } catch {
        // ignore
      }
    } else if (projection.backendCliSourcePreferences !== null) {
      delete environment.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
      projection.backendCliSourcePreferences = null;
    }
  }
}
