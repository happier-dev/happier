import { withoutWorkspaceSourceRuntime } from './tsxImportHook';
import type { UiWebMode } from './uiWebTypes';
import { applyExpoNodeHeapEnv } from '../../../../../scripts/expo/expoNodeHeapEnv.mjs';

const UI_WEB_EXPO_HEAP_ENV_KEY = 'HAPPIER_E2E_UI_WEB_MAX_OLD_SPACE_SIZE_MB';
const UI_WEB_EXPO_DEFAULT_MAX_OLD_SPACE_SIZE_MB = 8192;

export function readPositiveEnvInt(raw: unknown, fallback: number): number {
  const parsed = Number.parseInt((raw ?? '').toString().trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveUiWebMode(env: NodeJS.ProcessEnv): UiWebMode {
  const raw = String(env.HAPPIER_E2E_UI_WEB_MODE ?? '').trim().toLowerCase();
  return raw === 'metro' ? 'metro' : 'export';
}

export function resolveUiWebEntryProbeTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_ENTRY_PROBE_TIMEOUT_MS, 30_000);
}

export function resolveUiWebExportFallbackToMetro(env: NodeJS.ProcessEnv): boolean {
  const raw = String(env.HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO ?? '1').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

export function buildUiWebExpoProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The suite needs the workspace loader. Expo owns its own config plugin loading.
  return applyExpoNodeHeapEnv(withoutWorkspaceSourceRuntime(env), {
    envKey: UI_WEB_EXPO_HEAP_ENV_KEY,
    defaultSizeMb: UI_WEB_EXPO_DEFAULT_MAX_OLD_SPACE_SIZE_MB,
  });
}

export function resolveUiWebExportSuiteTimeoutMs(env: NodeJS.ProcessEnv): number {
  const floorTimeoutMs = 1_800_000;
  const exportTimeoutMs = readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS, 0);
  const hardTimeoutMs = readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_EXPORT_HARD_TIMEOUT_MS, 0);
  return Math.max(floorTimeoutMs, exportTimeoutMs, hardTimeoutMs);
}
