import type { AgentType } from '@/sync/domains/models/modelOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { normalizePermissionModeForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import {
    readSessionConfigOptionsState,
    readSessionModelsState,
    readSessionModesState,
} from '@/sync/domains/sessionControl/readSessionControlMetadata';
import { parsePermissionIntentAlias, resolveProviderNativePermissionModeForAgent } from '@happier-dev/agents';
import { computeSessionModePickerControl } from '@/sync/domains/sessionControl/sessionModeControl';
import { t } from '@/text';

export type EffectivePermissionModeDescription = Readonly<{
    effectiveMode: PermissionMode;
    /** Provider-reported approval preset; host permission enforcement remains separate. */
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
            return reason.params?.from
                ? t('agentInput.mode.pendingSwitching', { from: reason.params.from, to: reason.params.to ?? '' })
                : t('agentInput.mode.badgePending', { name: reason.params?.to ?? '' });
        case 'plan_not_supported_for_provider':
            return 'Plan mode is not a permission for this provider; fallback to Read-only. Tip: use the separate “Mode” control when it is available.';
        case 'mode_mapped_for_provider':
            return `Mapped to ${reason.params?.providerMode ?? 'default'} for this provider.`;
        case 'read_only_enforced_by_tool_gating':
            return 'Happier denies host-mediated ACP filesystem writes in Read Only and Plan. Trusted provider-native or direct writes remain best effort under the provider’s own policy.';
        case 'approval_setting_controls_auto_approval':
            return 'This setting controls tool auto-approval; sandbox limits may not change for the running session.';
        case 'read_only_best_effort':
            return 'Trusted provider-native or direct writes remain best effort under this provider’s own policy.';
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
    const agentId = resolveAgentIdFromFlavor(_params.agentType);
    const core = agentId ? getAgentCore(agentId) : null;
    const hasAcpSessionMetadata = Boolean(
        readSessionModesState(_params.metadata) ||
        readSessionModelsState(_params.metadata) ||
        readSessionConfigOptionsState(_params.metadata),
    );

    const selected = parsePermissionIntentAlias(_params.selectedMode) ?? 'default';
    const normalized = normalizePermissionModeForAgentType(selected, _params.agentType);
    const reasons: EffectivePermissionModeReason[] = [];

    let effectiveMode: PermissionMode = normalized;

    if (!agentId || !core) {
        if (_params.applyTiming === 'next_prompt') {
            reasons.push({ code: 'applies_on_next_message' });
        }
        const notes = reasons.map(noteForReason).filter(Boolean);
        return { effectiveMode, reasons, notes };
    }

    const group = core.permissions.modeGroup;
    const permissionMapping = core.permissions.permissionModeMapping;
    const nativePolicy = permissionMapping
        ? computeSessionModePickerControl({ agentId, metadata: _params.metadata })
        : null;
    if (permissionMapping?.[selected]) effectiveMode = selected;
    if (nativePolicy?.isExplicitOverride && nativePolicy.requestedModeId) {
        reasons.push({ code: 'native_mode_overrides_permissions', params: { mode: nativePolicy.requestedModeName ?? nativePolicy.requestedModeId } });
        if (nativePolicy.isPending) {
            reasons.push({ code: 'native_mode_pending', params: {
                ...(nativePolicy.currentModeId !== null ? { from: nativePolicy.currentModeName } : {}),
                to: nativePolicy.requestedModeName ?? nativePolicy.requestedModeId,
            } });
        }
    }

    if (selected === 'plan' && !permissionMapping?.[selected]) {
        reasons.push({ code: 'plan_not_supported_for_provider' });
    }

    const providerNative = permissionMapping?.[parsePermissionIntentAlias(effectiveMode) ?? 'default'] ?? resolveProviderNativePermissionModeForAgent({ agentId, mode: _params.selectedMode });
    if (!nativePolicy?.isExplicitOverride && providerNative !== effectiveMode) {
        reasons.push({ code: 'mode_mapped_for_provider', params: { providerMode: providerNative } });
    }

    if (group === 'codexLike') {
        if (effectiveMode === 'read-only' || effectiveMode === 'plan') {
            reasons.push({ code: 'read_only_enforced_by_tool_gating' });
        } else if (effectiveMode === 'safe-yolo' || effectiveMode === 'yolo') {
            reasons.push({ code: 'approval_setting_controls_auto_approval' });
        }
    }

    if (effectiveMode === 'read-only' && providerNative !== 'read-only' && group !== 'codexLike') {
        reasons.push({ code: 'read_only_best_effort' });
    }

    if (core.sessionModes.kind === 'acpPolicyPresets' && !hasAcpSessionMetadata) {
        reasons.push({ code: 'mcp_sandbox_restrictions_apply_on_spawn' });
    }

    if (_params.applyTiming === 'next_prompt') {
        reasons.push({ code: 'applies_on_next_message' });
    }

    const notes = reasons.map(noteForReason).filter(Boolean);
    return { effectiveMode, ...(nativePolicy?.currentModeId != null ? { nativeModeLabel: nativePolicy.currentModeName } : {}), reasons, notes };
}
