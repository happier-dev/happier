import { resolveUiWebExportFallbackToMetro, resolveUiWebMode } from './uiWebEnv';
import {
  resolveUiWebBaseUrlTimeoutMs,
  resolveUiWebMetroBeforeAllTimeoutMs,
  resolveUiWebMetroStatusTimeoutMs,
  resolveUiWebScriptFetchTotalTimeoutMs,
  startUiWebMetro,
} from './uiWebMetro';
import {
  resolveUiWebExportBeforeAllTimeoutMs,
  resolveUiWebExportBuildTimeoutMs,
  startUiWebExport,
} from './uiWebExport';

export type { StartedUiWeb } from './uiWebTypes';

export {
  resolveUiWebBaseUrlTimeoutMs,
  resolveUiWebMetroStatusTimeoutMs,
  resolveUiWebScriptFetchTotalTimeoutMs,
  resolveUiWebExportBuildTimeoutMs,
};

export function resolveUiWebBeforeAllTimeoutMs(env: NodeJS.ProcessEnv): number {
  if (resolveUiWebMode(env) === 'metro') {
    return resolveUiWebMetroBeforeAllTimeoutMs(env);
  }
  if (!resolveUiWebExportFallbackToMetro(env)) {
    return resolveUiWebExportBeforeAllTimeoutMs(env);
  }
  return resolveUiWebExportBeforeAllTimeoutMs(env) + resolveUiWebMetroBeforeAllTimeoutMs(env);
}

export async function startUiWeb(params: {
  testDir: string;
  env: NodeJS.ProcessEnv;
  port?: number;
}) {
  if (resolveUiWebMode(params.env) === 'metro') {
    return await startUiWebMetro(params);
  }
  try {
    return await startUiWebExport(params);
  } catch (error) {
    if (!resolveUiWebExportFallbackToMetro(params.env)) {
      throw error;
    }
    return await startUiWebMetro(params);
  }
}
