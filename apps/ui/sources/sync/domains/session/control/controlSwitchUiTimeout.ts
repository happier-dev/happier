const DEFAULT_CONTROL_SWITCH_UI_TIMEOUT_MS = 20_000;
const MAX_CONTROL_SWITCH_UI_TIMEOUT_MS = 120_000;

export function readControlSwitchUiTimeoutMsFromEnv(): number {
  const raw = String(process.env.EXPO_PUBLIC_HAPPIER_CONTROL_SWITCH_UI_TIMEOUT_MS ?? '').trim();
  if (!raw) return DEFAULT_CONTROL_SWITCH_UI_TIMEOUT_MS;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_CONTROL_SWITCH_UI_TIMEOUT_MS;

  return Math.max(0, Math.min(MAX_CONTROL_SWITCH_UI_TIMEOUT_MS, parsed));
}

