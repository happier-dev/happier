import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';

import { describeEffectivePermissionMode } from './describeEffectivePermissionMode';

function reasonCodes(res: ReturnType<typeof describeEffectivePermissionMode>): string[] {
    return res.reasons.map((r) => r.code);
}

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('describeEffectivePermissionMode', () => {
    it('does not describe generic Plan as an explicit native approval override', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'codebuddy', selectedMode: 'plan', applyTiming: 'next_prompt',
            metadata: buildMetadata({
                permissionMode: 'plan',
                sessionModesV1: {
                    v: 1, provider: 'codebuddy', updatedAt: 1, currentModeId: 'auto',
                    availableModes: [{ id: 'auto', name: 'Auto' }, { id: 'plan', name: 'Plan' }],
                },
            }),
        });
        expect(res.effectiveMode).toBe('plan');
        expect(reasonCodes(res)).not.toContain('native_mode_overrides_permissions');
        expect(reasonCodes(res)).not.toContain('native_mode_pending');
        expect(reasonCodes(res)).toContain('applies_on_next_message');
    });

    it.each(['codebuddy', 'devin', 'fx'] as const)('describes %s native policy without treating the permission selection as applied', (agentType) => {
        const res = describeEffectivePermissionMode({
            agentType,
            selectedMode: 'read-only',
            applyTiming: 'immediate',
            metadata: buildMetadata({
                sessionModesV1: {
                    v: 1, provider: agentType, updatedAt: 2, currentModeId: 'unrestricted',
                    availableModes: [{ id: 'unrestricted', name: 'Unrestricted' }],
                },
                sessionModeOverrideV1: { v: 1, updatedAt: 1, modeId: 'unrestricted' },
            }),
        });
        expect(res).toMatchObject({ effectiveMode: 'read-only', nativeModeLabel: 'Unrestricted' });
        expect(reasonCodes(res)).toContain('native_mode_overrides_permissions');
        expect(reasonCodes(res)).not.toContain('read_only_enforced_by_tool_gating');
    });

    it('keeps the reported policy visible while a native override is pending', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'codebuddy', selectedMode: 'read-only', applyTiming: 'immediate',
            metadata: buildMetadata({
                sessionModesV1: {
                    v: 1, provider: 'codebuddy', updatedAt: 1, currentModeId: 'dontAsk',
                    availableModes: [{ id: 'dontAsk', name: 'No prompts' }, { id: 'bypassPermissions', name: 'Bypass permissions' }],
                },
                sessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: 'bypassPermissions' },
            }),
        });
        expect(res).toMatchObject({ nativeModeLabel: 'No prompts' });
        expect(res.reasons).toContainEqual({ code: 'native_mode_pending', params: { from: 'No prompts', to: 'Bypass permissions' } });
    });

    it('uses a declared ACP plan mapping instead of claiming an unsupported permission fallback', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'codebuddy', selectedMode: 'plan', metadata: buildMetadata(), applyTiming: 'immediate',
        });
        expect(res.effectiveMode).toBe('plan');
        expect(reasonCodes(res)).not.toContain('plan_not_supported_for_provider');
        expect(res.reasons).not.toContainEqual({ code: 'mode_mapped_for_provider', params: { providerMode: 'dontAsk' } });
    });

    it('stops describing override precedence after an explicit clear', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'codebuddy', selectedMode: 'read-only', applyTiming: 'immediate',
            metadata: buildMetadata({
                sessionModesV1: {
                    v: 1, provider: 'codebuddy', updatedAt: 3, currentModeId: 'dontAsk',
                    availableModes: [{ id: 'dontAsk', name: 'No prompts' }],
                },
                sessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: '' },
            }),
        });
        expect(res).toMatchObject({ nativeModeLabel: 'No prompts' });
        expect(reasonCodes(res)).not.toContain('native_mode_overrides_permissions');
    });

    it.each(['codebuddy', 'opencode'] as const)('does not borrow an unrelated or behavioral native mode for %s permissions', (agentType) => {
        const res = describeEffectivePermissionMode({
            agentType, selectedMode: 'read-only', applyTiming: 'immediate',
            metadata: buildMetadata({
                sessionModesV1: {
                    v: 1, provider: 'opencode', updatedAt: 2, currentModeId: 'build',
                    availableModes: [{ id: 'build', name: 'Build' }],
                },
                sessionModeOverrideV1: { v: 1, updatedAt: 1, modeId: 'build' },
            }),
        });
        expect(res.nativeModeLabel).toBeUndefined();
        expect(reasonCodes(res)).not.toContain('native_mode_overrides_permissions');
    });

    it('fails closed to read-only for codex-like plan and emits reason codes', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'codex',
            selectedMode: 'plan',
            metadata: buildMetadata(),
            applyTiming: 'immediate',
        });

        expect(res.effectiveMode).toBe('read-only');
        expect(reasonCodes(res)).toContain('plan_not_supported_for_provider');
    });

    it('maps legacy plan to read-only for Claude and emits plan fallback reason', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'claude',
            selectedMode: 'plan',
            metadata: buildMetadata(),
            applyTiming: 'immediate',
        });

        expect(res.effectiveMode).toBe('read-only');
        expect(reasonCodes(res)).toContain('plan_not_supported_for_provider');
    });

    it('emits provider-native mapping reason when provider canonicalization changes the mode', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'claude',
            selectedMode: 'safe-yolo',
            metadata: buildMetadata(),
            applyTiming: 'immediate',
        });

        expect(res.reasons).toContainEqual({
            code: 'mode_mapped_for_provider',
            params: { providerMode: 'auto' },
        });
    });

    it('emits codex-like read-only enforcement reason', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'opencode',
            selectedMode: 'read-only',
            metadata: buildMetadata(),
            applyTiming: 'immediate',
        });

        expect(res.effectiveMode).toBe('read-only');
        expect(reasonCodes(res)).toContain('read_only_enforced_by_tool_gating');
    });

    it('emits next-prompt timing reason when apply timing is deferred', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'claude',
            selectedMode: 'default',
            metadata: buildMetadata(),
            applyTiming: 'next_prompt',
        });

        expect(reasonCodes(res)).toContain('applies_on_next_message');
    });

    it('emits codex-like approval behavior reason for safe-yolo', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'codex',
            selectedMode: 'safe-yolo',
            metadata: buildMetadata(),
            applyTiming: 'immediate',
        });

        expect(reasonCodes(res)).toContain('approval_setting_controls_auto_approval');
    });

    it('keeps default for pi (tool gating handled at spawn)', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'pi',
            selectedMode: 'default',
            metadata: buildMetadata(),
            applyTiming: 'immediate',
        });

        expect(res.effectiveMode).toBe('default');
        expect(reasonCodes(res)).not.toContain('read_only_enforced_by_tool_gating');
    });

    it('emits read_only_best_effort when provider maps read-only to a non-read-only native mode', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'claude',
            selectedMode: 'read-only',
            metadata: buildMetadata(),
            applyTiming: 'immediate',
        });

        expect(reasonCodes(res)).toContain('read_only_best_effort');
        expect(res.notes.some((note) => /best effort/i.test(note))).toBe(true);
    });

    it('emits MCP spawn restriction reason when ACP policy providers have no ACP metadata', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'codex',
            selectedMode: 'default',
            metadata: buildMetadata(),
            applyTiming: 'immediate',
        });

        expect(reasonCodes(res)).toContain('mcp_sandbox_restrictions_apply_on_spawn');
    });

    it('does not emit MCP spawn restriction reason when generic session-control metadata is present', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'codex',
            selectedMode: 'default',
            metadata: buildMetadata({
                sessionModesV1: {
                    v: 1,
                    provider: 'unexpected-provider',
                    updatedAt: 1,
                    currentModeId: 'default',
                    availableModes: [],
                },
            }),
            applyTiming: 'immediate',
        });

        expect(reasonCodes(res)).not.toContain('mcp_sandbox_restrictions_apply_on_spawn');
    });

    it('falls back to legacy ACP metadata keys when generic session-control keys are absent', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'codex',
            selectedMode: 'default',
            metadata: buildMetadata({
                acpSessionModesV1: {
                    v: 1,
                    provider: 'unexpected-provider',
                    updatedAt: 1,
                    currentModeId: 'default',
                    availableModes: [],
                },
            }),
            applyTiming: 'immediate',
        });

        expect(reasonCodes(res)).not.toContain('mcp_sandbox_restrictions_apply_on_spawn');
    });
});
