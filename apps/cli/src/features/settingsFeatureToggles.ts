type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as RecordLike;
}

function shallowCloneRecord(value: unknown): RecordLike {
  const record = asRecord(value);
  if (!record) return {};
  return { ...record };
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

export function ensureExperimentalSettingsFeatureToggleEnabled<TSettings extends object>(params: Readonly<{
  settings: TSettings;
  featureId: string;
}>): TSettings {
  const root = shallowCloneRecord(params.settings);

  if (root.experiments !== true) {
    root.experiments = true;
  }

  const existingFeatureToggles = asRecord(root.featureToggles);
  root.featureToggles = {
    ...(existingFeatureToggles ?? {}),
    [params.featureId]: true,
  };

  return root as unknown as TSettings;
}
