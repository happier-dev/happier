import type { AgentType } from '@/sync/modelOptions';
import type { PermissionMode } from '@/sync/permissionTypes';
import type { Metadata } from '@/sync/storageTypes';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog';
import { normalizePermissionModeForAgentType } from '@/sync/permissionModeOptions';
import { normalizePermissionModeForAgent, parsePermissionIntentAlias } from '@happier-dev/agents';

export type EffectivePermissionModeDescription = Readonly<{
    effectiveMode: PermissionMode;
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
    | 'applies_on_next_message';

export type EffectivePermissionModeReason = Readonly<{
    code: EffectivePermissionModeReasonCode;
    params?: Readonly<Record<string, string>>;
}>;

function noteForReason(reason: EffectivePermissionModeReason): string {
    switch (reason.code) {
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
        _params.metadata?.acpSessionModesV1 ||
        _params.metadata?.acpSessionModelsV1 ||
        _params.metadata?.acpConfigOptionsV1,
    );

    // Keep legacy "plan" for display so we can fail-closed in Codex-like providers.
    const selected = (parsePermissionIntentAlias(_params.selectedMode) ?? 'default') as PermissionMode;
    const normalized = selected === 'plan' ? 'plan' : normalizePermissionModeForAgentType(selected, _params.agentType);
    const reasons: EffectivePermissionModeReason[] = [];

    let effectiveMode: PermissionMode = normalized;

    if (group === 'codexLike' && normalized === 'plan') {
        effectiveMode = 'read-only';
        reasons.push({ code: 'plan_not_supported_for_provider' });
    }

    const providerNative = normalizePermissionModeForAgent({ agentId, mode: effectiveMode });
    if (providerNative !== effectiveMode) {
        reasons.push({ code: 'mode_mapped_for_provider', params: { providerMode: providerNative } });
    }

    if (group === 'codexLike') {
        if (effectiveMode === 'read-only') {
            reasons.push({ code: 'read_only_enforced_by_tool_gating' });
        } else if (effectiveMode === 'safe-yolo' || effectiveMode === 'yolo') {
            reasons.push({ code: 'approval_setting_controls_auto_approval' });
        }
    }

    if (effectiveMode === 'read-only' && providerNative !== 'read-only') {
        reasons.push({ code: 'read_only_best_effort' });
    }

    if (core.sessionModes.kind === 'acpPolicyPresets' && !hasAcpSessionMetadata) {
        reasons.push({ code: 'mcp_sandbox_restrictions_apply_on_spawn' });
    }

    if (_params.applyTiming === 'next_prompt') {
        reasons.push({ code: 'applies_on_next_message' });
    }

    const notes = reasons.map(noteForReason).filter(Boolean);
    return { effectiveMode, reasons, notes };
}
