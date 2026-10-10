import { t } from '@/text';
import type { TranslationKey } from '@/text';
import type { AgentType } from '../models/modelOptions';
import type { PermissionMode } from './permissionTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import { CLAUDE_PERMISSION_MODES, CODEX_LIKE_PERMISSION_MODES, normalizePermissionModeForGroup } from './permissionTypes';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { parsePermissionIntentAlias } from '@happier-dev/agents/permissions';
import { isPermissionModeGrantedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';

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

const BADGE_KEY_SEGMENT_CLAUDE: Partial<Record<PermissionMode, string>> = {
    'read-only': 'badgeReadOnly',
    'safe-yolo': 'badgeSafeYolo',
    yolo: 'badgeYolo',
};

const BADGE_KEY_SEGMENT_CODEX_LIKE: Partial<Record<PermissionMode, string>> = {
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

function getPermissionModeDescriptionForAgentType(agentType: AgentType, mode: PermissionMode): string {
    const prefix = getAgentPermissionModeI18nPrefix(agentType);
    if (!prefix) return '';
    const seg = PERMISSION_MODE_KEY_SEGMENT[mode] ?? 'default';
    return t(`${prefix}.${seg}` as TranslationKey);
}

export function getPermissionModesForAgentType(agentType: AgentType): readonly PermissionMode[] {
    const group = getAgentPermissionModeCore(agentType)?.permissions.modeGroup;
    if (!group) return [];
    return group === 'codexLike' ? CODEX_LIKE_PERMISSION_MODES : CLAUDE_PERMISSION_MODES;
}

export function getPermissionModeOptionsForAgentType(agentType: AgentType, presentation: 'menu' | 'settings' = 'menu'): readonly PermissionModeOption[] {
    const group = getAgentPermissionModeCore(agentType)?.permissions.modeGroup;
    if (!group) return [];
    const label = (mode: PermissionMode) => presentation === 'settings'
        ? t(`settingsSession.permissions.modeLabels.${PERMISSION_MODE_KEY_SEGMENT[mode]}` as TranslationKey)
        : getPermissionModeLabelForAgentType(agentType, mode);

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

export function normalizePermissionModeForAgentType(mode: PermissionMode, agentType: AgentType): PermissionMode {
    const normalized = (parsePermissionIntentAlias(mode) ?? 'default') as PermissionMode;
    const core = getAgentPermissionModeCore(agentType);
    return core ? normalizePermissionModeForGroup(normalized, core.permissions.modeGroup) : normalized;
}

export function getPermissionModeBadgeLabelForAgentType(agentType: AgentType, mode: PermissionMode): string {
    const core = getAgentPermissionModeCore(agentType);
    if (!core) return '';
    const group = core.permissions.modeGroup;
    const normalized = normalizePermissionModeForAgentType(mode, agentType);
    if (normalized === 'default') return '';

    const seg = group === 'codexLike'
        ? BADGE_KEY_SEGMENT_CODEX_LIKE[normalized]
        : BADGE_KEY_SEGMENT_CLAUDE[normalized];
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
