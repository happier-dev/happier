import { z } from 'zod';

export const DEFAULT_WINDOWS_TERMINAL_WINDOW_NAME = 'happier';

const WINDOWS_TERMINAL_DEFAULTED_WINDOW_SELECTORS = new Set(['-1', 'last', '0']);

export function normalizeWindowsTerminalWindowName(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return DEFAULT_WINDOWS_TERMINAL_WINDOW_NAME;
  const normalizedSelector = trimmed.toLowerCase();
  if (normalizedSelector === 'new') return 'new';
  if (WINDOWS_TERMINAL_DEFAULTED_WINDOW_SELECTORS.has(normalizedSelector)) {
    return DEFAULT_WINDOWS_TERMINAL_WINDOW_NAME;
  }
  return trimmed;
}

export const WindowsTerminalWindowNameSchema = z
  .string()
  .transform((value) => normalizeWindowsTerminalWindowName(value));
