import type { UiWebMode } from './uiWebTypes';

export function readPositiveEnvInt(raw: unknown, fallback: number): number {
  const parsed = Number.parseInt((raw ?? '').toString().trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveUiWebMode(env: NodeJS.ProcessEnv): UiWebMode {
  const raw = String(env.HAPPIER_E2E_UI_WEB_MODE ?? '').trim().toLowerCase();
  return raw === 'metro' ? 'metro' : 'export';
}

export function resolveUiWebExportFallbackToMetro(env: NodeJS.ProcessEnv): boolean {
  const raw = String(env.HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO ?? '1').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}
