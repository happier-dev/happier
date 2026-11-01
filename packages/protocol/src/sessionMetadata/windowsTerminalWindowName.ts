import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const DEFAULT_WINDOWS_TERMINAL_WINDOW_NAME = 'happier';

const WINDOWS_TERMINAL_RESERVED_WINDOW_NAMES = new Set(['new', '-1', 'last', '0']);

export function normalizeWindowsTerminalWindowName(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return DEFAULT_WINDOWS_TERMINAL_WINDOW_NAME;
  if (WINDOWS_TERMINAL_RESERVED_WINDOW_NAMES.has(trimmed.toLowerCase())) {
    return DEFAULT_WINDOWS_TERMINAL_WINDOW_NAME;
  }
  return trimmed;
}

export const WindowsTerminalWindowNameSchema = lazySchema(() => z
  .unknown()
  .optional()
  .transform((value) => normalizeWindowsTerminalWindowName(value)));
