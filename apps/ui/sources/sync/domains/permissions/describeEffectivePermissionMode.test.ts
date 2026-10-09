import { describe, expect, it } from 'vitest';
import { t } from '@/text';

import type { Metadata } from '@happier-dev/session-core/state';

import { describeEffectivePermissionMode } from './describeEffectivePermissionMode';
import { mapToClaudePermissionMode } from '../../../../../../packages/plugins/claude/src/agent/runtime/permissionMode';

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
    it.each(['codebuddy', 'devin', 'fx'] as const)('describes %s native policy native approval policy while preserving host permission enforcement', (agentType) => {
        const res = describeEffectivePermissionMode({
            agentType,
            selectedMode: 'read-only',
            applyTiming: 'immediate',
            metadata: buildMetadata({
                sessionModesV1: {
                    v: 1, agentId: agentType, updatedAt: 2, currentModeId: 'unrestricted',
                    availableModes: [{ id: 'unrestricted', name: 'Unrestricted' }],
                },
                sessionModeOverrideV1: { v: 1, updatedAt: 1, modeId: 'unrestricted' },
            }),
        });
        expect(res).toMatchObject({ effectiveMode: 'read-only', nativeModeLabel: 'Unrestricted' });
        expect(reasonCodes(res)).toContain('native_mode_overrides_permissions');
        expect(reasonCodes(res)).toContain('read_only_enforced_by_tool_gating');
    });

    it('keeps the reported policy visible while a native override is pending', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'codebuddy', selectedMode: 'read-only', applyTiming: 'immediate',
            metadata: buildMetadata({
                sessionModesV1: {
                    v: 1, agentId: 'codebuddy', updatedAt: 1, currentModeId: 'dontAsk',
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
        expect(reasonCodes(res)).toContain('read_only_enforced_by_tool_gating');
        expect(reasonCodes(res)).not.toContain('plan_not_supported_for_provider');
        expect(res.reasons).not.toContainEqual({ code: 'mode_mapped_for_provider', params: { providerMode: 'dontAsk' } });
    });


    it('describes mapped generic Plan without claiming an explicit native override', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'devin', selectedMode: 'plan', applyTiming: 'immediate',
            metadata: buildMetadata({
                permissionMode: 'plan',
                sessionModesV2: {
                    v: 2, agentId: 'devin', updatedAt: 1, currentModeId: 'plan',
                    availableModes: [{ id: 'plan', name: 'Plan' }],
                },
            }),
        });
        expect(res.effectiveMode).toBe('plan');
        expect(reasonCodes(res)).toContain('read_only_enforced_by_tool_gating');
        expect(reasonCodes(res)).not.toContain('native_mode_overrides_permissions');
        expect(reasonCodes(res)).not.toContain('native_mode_pending');
    });

    it.each([null, 'bypass'] as const)('uses current V2 policy %s after clear without borrowing stale V1 policy', (currentModeId) => {
        const metadata = buildMetadata({
            sessionModesV2: {
                v: 2, agentId: 'devin', updatedAt: 3, currentModeId,
                availableModes: [{ id: 'bypass', name: 'Bypass permissions' }, { id: 'plan', name: 'Plan' }],
            },
            sessionModesV1: {
                v: 1, agentId: 'devin', updatedAt: 1, currentModeId: 'plan',
                availableModes: [{ id: 'plan', name: 'Stale Plan' }],
            },
            sessionModeOverrideV1: { v: 1, updatedAt: 4, modeId: null },
        });
        const params = { agentType: 'devin', selectedMode: 'default', applyTiming: 'immediate', metadata } as const;
        const res = describeEffectivePermissionMode(params);
        expect(res.nativeModeLabel).toBe(currentModeId === null ? undefined : 'Bypass permissions');
        expect(reasonCodes(res)).not.toContain('native_mode_overrides_permissions');

        metadata.sessionModeOverrideV1 = { v: 1, updatedAt: 5, modeId: 'plan' };
        const pending = describeEffectivePermissionMode(params);
        expect(pending.nativeModeLabel).toBe(currentModeId === null ? undefined : 'Bypass permissions');
        expect(pending.reasons).toContainEqual({
            code: 'native_mode_pending',
            params: { ...(currentModeId === null ? {} : { from: 'Bypass permissions' }), to: 'Plan' },
        });
        expect(pending.notes).toContain(currentModeId === null
            ? t('agentInput.mode.badgePending', { name: 'Plan' })
            : t('agentInput.mode.pendingSwitching', { from: 'Bypass permissions', to: 'Plan' }));
    });

    it('stops describing override precedence after an explicit clear', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'codebuddy', selectedMode: 'read-only', applyTiming: 'immediate',
            metadata: buildMetadata({
                sessionModesV1: {
                    v: 1, agentId: 'codebuddy', updatedAt: 3, currentModeId: 'dontAsk',
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
                    v: 1, agentId: 'opencode', updatedAt: 2, currentModeId: 'build',
                    availableModes: [{ id: 'build', name: 'Build' }],
                },
                sessionModeOverrideV1: { v: 1, updatedAt: 1, modeId: 'build' },
            }),
        });
        expect(res.nativeModeLabel).toBeUndefined();
        expect(reasonCodes(res)).not.toContain('native_mode_overrides_permissions');
    });


    it.each(['default', 'acceptEdits', 'bypassPermissions', 'safe-yolo', 'yolo', 'read-only'] as const)(
        'describes the Claude-native mode actually selected by the runtime for %s',
        (selectedMode) => {
            const res = describeEffectivePermissionMode({
                agentType: 'claude',
                selectedMode,
                metadata: buildMetadata(),
                applyTiming: 'immediate',
            });
            const nativeMode = res.reasons.find((reason) => reason.code === 'mode_mapped_for_provider')
                ?.params?.providerMode ?? res.effectiveMode;

            expect(nativeMode).toBe(mapToClaudePermissionMode(selectedMode));
        },
    );

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

    it('describes Grok read-only host enforcement without claiming provider-native filesystem containment', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'grok',
            selectedMode: 'read-only',
            metadata: buildMetadata(),
            applyTiming: 'immediate',
        });

        expect(res.reasons).toEqual([
            { code: 'read_only_enforced_by_tool_gating' },
        ]);
        expect(res.notes).toEqual([
            'Happier denies host-mediated ACP filesystem writes in Read Only and Plan. Trusted provider-native or direct writes remain best effort under the provider’s own policy.',
        ]);
        expect(res.notes.join(' ')).not.toContain('mapped to Default');
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
        expect(res.notes).toEqual([
            'Mapped to dontAsk for this provider.',
            'Trusted provider-native or direct writes remain best effort under this provider’s own policy.',
        ]);
        expect(res.notes.join(' ')).not.toContain('mapped to Default');
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
                    agentId: 'unexpected-provider',
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
                    agentId: 'unexpected-provider',
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
