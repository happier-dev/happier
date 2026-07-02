export type KimiAcpPythonSelector = 'auto' | 'poll';

const HAPPIER_KIMI_ACP_SELECTOR_ENV = 'HAPPIER_KIMI_ACP_SELECTOR';

type KimiSessionRuntimePreferences = Readonly<{
  environmentVariables?: Readonly<Record<string, string>>;
}>;

export function normalizeKimiAcpPythonSelector(raw: unknown): KimiAcpPythonSelector | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value === 'auto' || value === 'poll' ? value : null;
}

function buildKimiAcpSelectorEnvironment(selector: KimiAcpPythonSelector): KimiSessionRuntimePreferences {
  return {
    environmentVariables: {
      [HAPPIER_KIMI_ACP_SELECTOR_ENV]: selector,
    },
  };
}

export function resolveKimiSpawnExtrasFromSettings(
  settings: Readonly<Record<string, unknown>>,
): KimiSessionRuntimePreferences {
  const selector = normalizeKimiAcpPythonSelector(settings.kimiAcpPythonSelector);
  return selector === 'poll' ? buildKimiAcpSelectorEnvironment(selector) : {};
}

function readExplicitKimiAcpPythonSelectorFromEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
): KimiAcpPythonSelector | null {
  return normalizeKimiAcpPythonSelector(processEnv[HAPPIER_KIMI_ACP_SELECTOR_ENV]);
}

export function resolveKimiSessionRuntimePreferences(params: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  processEnv: Readonly<Record<string, string | undefined>>;
}>): KimiSessionRuntimePreferences {
  const explicitKimiAcpPythonSelector = readExplicitKimiAcpPythonSelectorFromEnv(params.processEnv);
  if (explicitKimiAcpPythonSelector) {
    return buildKimiAcpSelectorEnvironment(explicitKimiAcpPythonSelector);
  }

  return resolveKimiSpawnExtrasFromSettings(params.settings);
}
