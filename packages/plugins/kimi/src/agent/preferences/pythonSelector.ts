export type KimiAcpPythonSelector = 'auto' | 'poll';

export const HAPPIER_KIMI_ACP_SELECTOR_ENV = 'HAPPIER_KIMI_ACP_SELECTOR';

export function normalizeKimiAcpPythonSelector(raw: unknown): KimiAcpPythonSelector | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value === 'auto' || value === 'poll' ? value : null;
}
