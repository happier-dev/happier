import type { AgentType } from '@/sync/domains/models/modelOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { normalizePermissionModeForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import {
    readSessionConfigOptionsState,
    readSessionModelsState,
    readSessionModesState,
} from '@/sync/domains/sessionControl/readSessionControlMetadata';
import { getBuiltInAcpConfig, parsePermissionIntentAlias, resolveProviderNativePermissionModeForAgent } from '@happier-dev/agents';
import { computeSessionModePickerControl } from '@/sync/domains/sessionControl/sessionModeControl';
import { t } from '@/text';

export type EffectivePermissionModeDescription = Readonly<{
    effectiveMode: PermissionMode;
    /** Provider-reported approval policy, independent of the selected permission intent. */
    nativeModeLabel?: string;
    reasons: EffectivePermissionModeReason[];
    notes: string[];
}>;

export type EffectivePermissionModeReasonCode =
    | 'plan_not_supported_for_provider'
    | 'mode_mapped_for_provider'
    | 'read_only_enforced_by_tool_gating'
    | 'approval_setting_controls_auto_approval'
    | 'read_only_best_effort'
    | 'mcp_sandbox_restrictions_apply_on_spawn'
    | 'native_mode_overrides_permissions'
    | 'native_mode_pending'
    | 'applies_on_next_message';

export type EffectivePermissionModeReason = Readonly<{
    code: EffectivePermissionModeReasonCode;
    params?: Readonly<Record<string, string>>;
}>;

function noteForReason(reason: EffectivePermissionModeReason): string {
    switch (reason.code) {
        case 'native_mode_overrides_permissions':
            return t('agentInput.permissionMode.nativeModeOverrides', { mode: reason.params?.mode ?? '' });
        case 'native_mode_pending':
            return t('agentInput.mode.pendingSwitching', { from: reason.params?.from ?? '', to: reason.params?.to ?? '' });
        case 'plan_not_supported_for_provider':
            return 'Plan mode is not a permission for this provider; fallback to Read-only. Tip: use the separate “Mode” control when it is available.';
        case 'mode_mapped_for_provider':
            return `Mapped to ${reason.params?.providerMode ?? 'default'} for this provider.`;
        case 'read_only_enforced_by_tool_gating':
            return 'Read-only is enforced by Happy via tool gating (write actions are denied).';
        case 'approval_setting_controls_auto_approval':
            return 'This setting controls tool auto-approval; sandbox limits may not change for the running session.';
        case 'read_only_best_effort':
            return 'Read-only is best effort on this provider (mapped to Default).';
        case 'mcp_sandbox_restrictions_apply_on_spawn':
            return 'This session uses MCP-style sandboxing: changing permissions mid-session updates approval behavior, but sandbox/environment restrictions apply at session start.';
        case 'applies_on_next_message':
            return 'Applies to the next message you send.';
        default:
            return '';
    }
}

export function describeEffectivePermissionMode(_params: {
    agentType: AgentType;
    selectedMode: PermissionMode;
    metadata: Metadata | null;
    applyTiming: 'immediate' | 'next_prompt';
}): EffectivePermissionModeDescription {
    const agentId = resolveAgentIdFromFlavor(_params.agentType) ?? DEFAULT_AGENT_ID;
    const core = getAgentCore(agentId);
    const group = core.permissions.modeGroup;
    const hasAcpSessionMetadata = Boolean(
        readSessionModesState(_params.metadata) ||
        readSessionModelsState(_params.metadata) ||
        readSessionConfigOptionsState(_params.metadata),
    );

    const selected = (parsePermissionIntentAlias(_params.selectedMode) ?? 'default') as PermissionMode;
    const normalized = normalizePermissionModeForAgentType(selected, _params.agentType);
    const reasons: EffectivePermissionModeReason[] = [];
    const permissionMapping = getBuiltInAcpConfig(agentId)?.permissionModeMapping;
    const nativePolicy = permissionMapping
        ? computeSessionModePickerControl({ agentId, metadata: _params.metadata })
        : null;

    const effectiveMode = permissionMapping?.[selected] ? selected : normalized;

    if (nativePolicy?.isExplicitOverride && nativePolicy.requestedModeId) {
        reasons.push({ code: 'native_mode_overrides_permissions', params: { mode: nativePolicy.requestedModeName ?? nativePolicy.requestedModeId } });
        if (nativePolicy.isPending) {
            reasons.push({ code: 'native_mode_pending', params: { from: nativePolicy.currentModeName, to: nativePolicy.requestedModeName ?? nativePolicy.requestedModeId } });
        }
        return {
            effectiveMode,
            nativeModeLabel: nativePolicy.currentModeName,
            reasons,
            notes: reasons.map(noteForReason).filter(Boolean),
        };
    }

    if (selected === 'plan' && !permissionMapping?.[selected]) {
        reasons.push({ code: 'plan_not_supported_for_provider' });
    }

    const providerNative = permissionMapping?.[effectiveMode] ?? resolveProviderNativePermissionModeForAgent({ agentId, mode: effectiveMode });
    if (providerNative !== effectiveMode) {
        reasons.push({ code: 'mode_mapped_for_provider', params: { providerMode: providerNative } });
    }

    if (group === 'codexLike' && !permissionMapping) {
        if (effectiveMode === 'read-only') {
            reasons.push({ code: 'read_only_enforced_by_tool_gating' });
        } else if (effectiveMode === 'safe-yolo' || effectiveMode === 'yolo') {
            reasons.push({ code: 'approval_setting_controls_auto_approval' });
        }
    }

    if (effectiveMode === 'read-only' && providerNative !== 'read-only' && !permissionMapping) {
        reasons.push({ code: 'read_only_best_effort' });
    }

    if (core.sessionModes.kind === 'acpPolicyPresets' && !hasAcpSessionMetadata) {
        reasons.push({ code: 'mcp_sandbox_restrictions_apply_on_spawn' });
    }

    if (_params.applyTiming === 'next_prompt') {
        reasons.push({ code: 'applies_on_next_message' });
    }

    const notes = reasons.map(noteForReason).filter(Boolean);
    return { effectiveMode, ...(nativePolicy ? { nativeModeLabel: nativePolicy.currentModeName } : {}), reasons, notes };
}
