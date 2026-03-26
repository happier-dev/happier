type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as RecordLike;
}

export function resolveExperimentalSettingsFeatureToggleEnabled(params: Readonly<{
  settings: unknown;
  featureId: string;
  defaultEnabled: boolean;
}>): boolean {
  const root = asRecord(params.settings);
  if (!root) return false;

  if (root.experiments !== true) return false;

  const featureToggles = asRecord(root.featureToggles);
  const explicit = featureToggles ? featureToggles[params.featureId] : undefined;
  if (typeof explicit === 'boolean') return explicit;

  return params.defaultEnabled === true;
}

export function ensureExperimentalSettingsFeatureToggleEnabled(params: Readonly<{
  settings: unknown;
  featureId: string;
}>): RecordLike {
  const root = JSON.parse(JSON.stringify(asRecord(params.settings) ?? {})) as RecordLike;
  if (root.experiments !== true) {
    root.experiments = true;
  }

  const featureToggles = asRecord(root.featureToggles) ?? {};
  featureToggles[params.featureId] = true;
  root.featureToggles = featureToggles;
  return root;
}
