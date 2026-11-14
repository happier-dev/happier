import { t } from '@/text';
import type { TranslationKey } from '@/text';
import type { AgentType } from '../models/modelOptions';
import type { PermissionMode } from './permissionTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import { PERMISSION_MODE_OPTIONS } from './permissionTypes';
import { getAgentSessionModeDescriptor, normalizePermissionModeForSessionDescriptor, type AgentSessionModeDescriptor } from '@happier-dev/agents';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { parsePermissionIntentAlias } from '@happier-dev/agents/permissions';
import { isPermissionModeGrantedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { PermissionIntent } from '@happier-dev/agents/permissions';

export type PermissionModeOption = Readonly<{
    value: PermissionMode;
    label: string;
    description: string;
    icon: string;
}>;

const PERMISSION_MODE_KEY_SEGMENT: Record<PermissionMode, string> = {
    default: 'default',
    acceptEdits: 'acceptEdits',
    bypassPermissions: 'bypassPermissions',
    plan: 'plan',
    'read-only': 'readOnly',
    'safe-yolo': 'safeYolo',
    yolo: 'yolo',
};

const BADGE_KEY_SEGMENT: Partial<Record<PermissionMode, string>> = {
    'read-only': 'badgeReadOnly',
    'safe-yolo': 'badgeSafeYolo',
    yolo: 'badgeYolo',
};

function getAgentPermissionModeCore(agentType: AgentType) {
    const agentId = resolveAgentIdFromFlavor(agentType);
    return agentId ? getAgentCore(agentId) : null;
}

function getAgentPermissionModeI18nPrefix(agentType: AgentType): string | null {
    return getAgentPermissionModeCore(agentType)?.permissionModeI18nPrefix ?? null;
}

export function getPermissionModeTitleForAgentType(agentType: AgentType): string {
    const prefix = getAgentPermissionModeI18nPrefix(agentType);
    if (!prefix) return t('settingsSession.permissions.title');
    return t(`${prefix}.title` as TranslationKey);
}

export function getPermissionModeLabelForAgentType(agentType: AgentType, mode: PermissionMode): string {
    const prefix = getAgentPermissionModeI18nPrefix(agentType);
    if (!prefix) {
        const normalized = (parsePermissionIntentAlias(mode) ?? 'default') as PermissionMode;
        return normalized === 'default' ? t('common.default') : normalized;
    }
    const seg = PERMISSION_MODE_KEY_SEGMENT[mode] ?? 'default';
    return t(`${prefix}.${seg}` as TranslationKey);
}

// The offered modes state what the agent may do without asking. A mode with no consequence line
// yields '' and the pickers omit the line instead of repeating the label.
const DESCRIBED_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set(PERMISSION_MODE_OPTIONS);

function getPermissionModeDescriptionForAgentType(agentType: AgentType, mode: PermissionMode): string {
    const prefix = getAgentPermissionModeI18nPrefix(agentType);
    if (!prefix || !DESCRIBED_PERMISSION_MODES.has(mode)) return '';
    return t(`${prefix}.${PERMISSION_MODE_KEY_SEGMENT[mode]}Description` as TranslationKey);
}

export function getPermissionModesForAgentType(agentType: AgentType): readonly PermissionMode[] {
    return getAgentPermissionModeCore(agentType) ? PERMISSION_MODE_OPTIONS : [];
}

export function getPermissionModeOptionsForAgentType(agentType: AgentType, _presentation: 'menu' | 'settings' = 'menu'): readonly (PermissionModeOption & { value: PermissionIntent })[] {
    if (!getAgentPermissionModeCore(agentType)) return [];
    const label = (mode: PermissionMode) => getPermissionModeLabelForAgentType(agentType, mode);

    return [
        { value: 'default', label: label('default'), description: getPermissionModeDescriptionForAgentType(agentType, 'default'), icon: 'shield' },
        { value: 'read-only', label: label('read-only'), description: getPermissionModeDescriptionForAgentType(agentType, 'read-only'), icon: 'eye' },
        { value: 'safe-yolo', label: label('safe-yolo'), description: getPermissionModeDescriptionForAgentType(agentType, 'safe-yolo'), icon: 'shield-check' },
        { value: 'yolo', label: label('yolo'), description: getPermissionModeDescriptionForAgentType(agentType, 'yolo'), icon: 'lightning' },
    ];
}

export function getPermissionModeOptionsForSession(agentType: AgentType, metadata: Metadata | null): readonly PermissionModeOption[] {
    // ACP session modes (e.g. OpenCode plan/build) are surfaced via a separate UI control.
    // Permission modes represent approval/sandbox intent only.
    return getPermissionModeOptionsForAgentType(agentType);
}

export function normalizePermissionModeForAgentType(
    mode: PermissionMode,
    agentType: AgentType,
    descriptor?: AgentSessionModeDescriptor | null,
): PermissionMode {
    const agentId = resolveAgentIdFromFlavor(agentType);
    return normalizePermissionModeForSessionDescriptor({
        mode,
        descriptor: descriptor === undefined && agentId ? getAgentSessionModeDescriptor(agentId) : descriptor,
    });
}

export function getPermissionModeBadgeLabelForAgentType(agentType: AgentType, mode: PermissionMode): string {
    const core = getAgentPermissionModeCore(agentType);
    if (!core) return '';
    const normalized = normalizePermissionModeForAgentType(mode, agentType);
    if (normalized === 'default') return '';

    const seg = BADGE_KEY_SEGMENT[normalized === 'plan' ? 'read-only' : normalized];
    if (!seg) return '';

    return t(`${core.permissionModeI18nPrefix}.${seg}` as TranslationKey);
}

/**
 * Narrows the agent's mode options to an allowed subset (an embed grant's `permissionModes`), in the
 * catalogue's order; it never adds a mode. `null` means no narrowing.
 */
export function restrictPermissionModeOptions<T extends Readonly<{ value: PermissionMode }>>(
    options: readonly T[],
    allowed: readonly PermissionMode[] | null | undefined,
): readonly T[] {
    if (!allowed) return options;
    const constraints = { models: null, permissionModes: [...allowed] };
    return options.filter((option) => isPermissionModeGrantedV1(constraints, option.value));
}
