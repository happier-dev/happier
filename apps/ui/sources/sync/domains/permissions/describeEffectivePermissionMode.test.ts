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

    it('keeps plan for Claude and does not emit codex-like plan fallback reason', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'claude',
            selectedMode: 'plan',
            metadata: buildMetadata(),
            applyTiming: 'immediate',
        });

        expect(res.effectiveMode).toBe('plan');
        expect(reasonCodes(res)).not.toContain('plan_not_supported_for_provider');
    });

    it('emits mapping reason when provider canonicalization changes the mode', () => {
        const res = describeEffectivePermissionMode({
            agentType: 'claude',
            selectedMode: 'safe-yolo',
            metadata: buildMetadata(),
            applyTiming: 'immediate',
        });

        expect(reasonCodes(res)).toContain('mode_mapped_for_provider');
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

    it('does not emit MCP spawn restriction reason when ACP metadata is present (even if malformed)', () => {
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
