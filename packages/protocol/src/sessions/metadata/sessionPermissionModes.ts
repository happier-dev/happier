import { z } from '../../zodRuntimePolicy.js';

export const SESSION_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'read-only',
  'safe-yolo',
  'yolo',
] as const;

export type SessionPermissionMode = (typeof SESSION_PERMISSION_MODES)[number];

/**
 * Provider-neutral permission names presented at user and Action input boundaries.
 * Persisted Session metadata retains its released spellings for compatibility.
 */
export const SESSION_PERMISSION_INTENT_INPUTS = [
  'read_only',
  'default',
  'auto',
  'yolo',
] as const;

export type SessionPermissionIntentInput = (typeof SESSION_PERMISSION_INTENT_INPUTS)[number];

const SESSION_PERMISSION_MODE_SET = new Set<string>(SESSION_PERMISSION_MODES);

function normalizeSessionPermissionModeToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Parse a user-provided compatibility token into a canonical Session mode.
 * Unknown input returns null so user boundaries can reject it explicitly.
 */
export function parseSessionPermissionModeAlias(raw: string): SessionPermissionMode | null {
  const normalized = normalizeSessionPermissionModeToken(raw);
  if (!normalized) return null;
  if (SESSION_PERMISSION_MODE_SET.has(normalized)) return normalized as SessionPermissionMode;

  switch (normalized) {
    case 'ask':
    case 'prompt':
    case 'normal':
      return 'default';

    case 'acceptedits':
    case 'accept-edits':
      return 'acceptEdits';

    case 'readonly':
    case 'read':
    case 'ro':
    case 'no-tools':
    case 'notools':
      return 'read-only';

    case 'safe':
    case 'safeyolo':
    case 'workspace-write':
    case 'workspacewrite':
    case 'workspace':
    case 'auto-edit':
    case 'auto':
      return 'safe-yolo';

    case 'full':
    case 'full-access':
    case 'bypass':
    case 'dontask':
    case 'dont-ask':
    case 'danger':
    case 'danger-full-access':
      return 'yolo';

    case 'bypasspermissions':
    case 'bypass-permissions':
      return 'bypassPermissions';

    default:
      return null;
  }
}

/** Strict, alias-aware schema for user and Action input boundaries. */
export function createSessionPermissionModeInputSchema(zod: typeof z) {
  return (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new zod.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(zod.transform((value) => typeof value === 'string'
      ? parseSessionPermissionModeAlias(value) ?? value
      : value), zod.enum(SESSION_PERMISSION_MODES));
}

export const SessionPermissionModeInputSchema = createSessionPermissionModeInputSchema(z);

/**
 * Parse behavior:
 * - Known values parse as-is.
 * - Unknown/invalid values parse as `'default'` (forward compatible; never throws).
 */
export function createSessionPermissionModeSchema(zod: typeof z) {
  return zod.catch(zod.enum(SESSION_PERMISSION_MODES), 'default');
}

export const SessionPermissionModeSchema = createSessionPermissionModeSchema(z);
