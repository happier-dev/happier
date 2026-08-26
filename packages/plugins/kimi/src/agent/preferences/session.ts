import {
  HAPPIER_KIMI_ACP_SELECTOR_ENV,
  normalizeKimiAcpPythonSelector,
  type KimiAcpPythonSelector,
} from './pythonSelector.js';

type KimiSessionRuntimePreferences = Readonly<{
  environmentVariables?: Readonly<Record<string, string>>;
}>;

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
  environment: Readonly<Record<string, string | undefined>>;
}>): KimiSessionRuntimePreferences {
  const explicitKimiAcpPythonSelector = readExplicitKimiAcpPythonSelectorFromEnv(params.environment);
  if (explicitKimiAcpPythonSelector) {
    return buildKimiAcpSelectorEnvironment(explicitKimiAcpPythonSelector);
  }

  return resolveKimiSpawnExtrasFromSettings(params.settings);
}
