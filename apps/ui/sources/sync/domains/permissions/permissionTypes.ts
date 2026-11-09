import type { PermissionMode } from '@happier-dev/agents/permissions';
import { PERMISSION_MODES } from '@happier-dev/agents/permissions';
import { PERMISSION_INTENTS } from '@happier-dev/agents';

export type { PermissionMode } from '@happier-dev/agents/permissions';

// We keep the user-facing intents consistent across agents. Providers that cannot enforce
// certain intents (e.g. Claude "read-only") are handled via effective-policy mapping.
export const PERMISSION_MODE_OPTIONS = PERMISSION_INTENTS.filter((mode) => mode !== 'plan');

export function isPermissionMode(value: unknown): value is PermissionMode {
    return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function normalizeProfileDefaultPermissionMode(mode: PermissionMode | null | undefined): PermissionMode {
    if (!mode) return 'default';
    return mode;
}

// NOTE: Model IDs can be provider-defined (especially for ACP agents advertising models dynamically).
// Keep the runtime representation flexible and validate known models separately where needed.
export type ModelMode = string;

export function isModelMode(value: unknown): value is ModelMode {
    return typeof value === 'string' && value.trim().length > 0;
}
