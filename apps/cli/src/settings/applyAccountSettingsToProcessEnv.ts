import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { parseExplicitSpawnEnvKeysFromProcessEnv } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';

type AccountSettingsEnvInput = Readonly<Record<string, unknown> & {
  scmIncludeCoAuthoredBy?: boolean;
  actionsSettingsV1?: unknown;
  backendCliSourcePreferenceById?: unknown;
  backendCliSourcePreferenceByTargetKey?: unknown;
}>;

const accountSettingsEnvironmentFields = [
  ['backendCliSourcePreferences', 'HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON'],
  ['scmIncludeCoAuthoredBy', 'HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY'],
  ['actionsSettings', 'HAPPIER_ACTIONS_SETTINGS_V1'],
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
  return accountSettingsEnvironmentFields.flatMap(([field, key]) => (
    typeof environment[key] === 'string' && environment[key] !== projection?.[field] ? [key] : []
  ));
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
      actionsSettings: inheritedValue('HAPPIER_ACTIONS_SETTINGS_V1'),
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

  const currentActionsEnvValue = typeof environment.HAPPIER_ACTIONS_SETTINGS_V1 === 'string'
    ? environment.HAPPIER_ACTIONS_SETTINGS_V1
    : null;
  if (projection.actionsSettings !== null && currentActionsEnvValue !== projection.actionsSettings) {
    projection.actionsSettings = null;
  }
  if (!explicitKeys?.includes('HAPPIER_ACTIONS_SETTINGS_V1')
    && (currentActionsEnvValue === null || projection.actionsSettings !== null)) {
    const rawActions = params.settings.actionsSettingsV1;
    const parsed = rawActions && typeof rawActions === 'object' ? rawActions : null;
    if (parsed) {
      try {
        const serialized = JSON.stringify(parsed);
        environment.HAPPIER_ACTIONS_SETTINGS_V1 = serialized;
        projection.actionsSettings = serialized;
      } catch {
        // ignore
      }
    } else if (projection.actionsSettings !== null) {
      delete environment.HAPPIER_ACTIONS_SETTINGS_V1;
      projection.actionsSettings = null;
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
