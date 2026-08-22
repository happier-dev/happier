import { describe, expect, it } from 'vitest';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { PermissionMode } from './permissionTypes';
import { readAccountPermissionDefaults, resolveNewSessionDefaultPermissionMode } from './permissionDefaults';

describe('resolveNewSessionDefaultPermissionMode', () => {
    const accountDefaultsByTargetKey = {
        [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' })]: 'plan' as PermissionMode,
        [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })]: 'safe-yolo' as PermissionMode,
        [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]: 'read-only' as PermissionMode,
    };
    const accountDefaults = readAccountPermissionDefaults(accountDefaultsByTargetKey, ['claude', 'codex', 'gemini']);

    it('reads account defaults from backend target keys', () => {
        expect(readAccountPermissionDefaults(accountDefaultsByTargetKey, ['claude', 'codex', 'gemini'])).toEqual({
            byTargetKey: {
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' })]: 'plan',
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })]: 'safe-yolo',
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]: 'read-only',
            },
        });
    });

    it('uses account defaults when no profile override is present', () => {
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'claude', accountDefaults })).toBe('read-only');
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'codex', accountDefaults })).toBe('safe-yolo');
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'gemini', accountDefaults })).toBe('read-only');
    });

    it('uses canonical target-keyed profile overrides when present', () => {
        const profileDefaultsByTargetKey = {
            [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })]: 'yolo' as PermissionMode,
        };
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'codex', accountDefaults, profileDefaultsByTargetKey })).toBe('yolo');
        // Other providers fall back to account defaults when no override exists.
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'claude', accountDefaults, profileDefaultsByTargetKey })).toBe('read-only');
    });

    it('prefers configured ACP backend target defaults over the agent-type fallback default', () => {
        const configuredTarget = { kind: 'configuredAcpBackend', backendId: 'review-bot' } as const;
        const configuredDefaults = readAccountPermissionDefaults({
            [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })]: 'read-only',
            [resolveBackendTargetKeyV2(configuredTarget)]: 'safe-yolo',
        }, ['codex']);

        expect(resolveNewSessionDefaultPermissionMode({
            agentType: 'codex',
            backendTarget: configuredTarget,
            accountDefaults: configuredDefaults,
        })).toBe('safe-yolo');
    });

    it('falls back to legacy profile override mapping when provider-specific override is missing', () => {
        const emptyAccountDefaults = readAccountPermissionDefaults({}, ['claude', 'codex', 'gemini']);
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'claude', accountDefaults: emptyAccountDefaults, legacyProfileDefaultPermissionMode: 'plan' })).toBe('read-only');
        // Legacy "plan" is mapped to read-only.
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'codex', accountDefaults: emptyAccountDefaults, legacyProfileDefaultPermissionMode: 'plan' })).toBe('read-only');
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'gemini', accountDefaults: emptyAccountDefaults, legacyProfileDefaultPermissionMode: 'bypassPermissions' })).toBe('yolo');
    });

    it('clamps unsupported profile override modes to safe defaults for the target provider', () => {
        // Codex-like agents do not expose "plan" as a permission mode.
        const emptyAccountDefaults = readAccountPermissionDefaults({}, ['codex']);
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'codex', accountDefaults: emptyAccountDefaults, legacyProfileDefaultPermissionMode: 'plan' })).toBe('read-only');
    });

    it('preserves an external Agent default without borrowing bundled permission policy', () => {
        const externalTarget = { kind: 'backend', backendId: 'acme.review.backend' } as const;
        const externalDefaults = readAccountPermissionDefaults({
            [resolveBackendTargetKeyV2(externalTarget)]: 'plan',
        }, ['codex']);

        expect(resolveNewSessionDefaultPermissionMode({
            agentType: 'acme.review.backend',
            backendTarget: externalTarget,
            accountDefaults: externalDefaults,
        })).toBe('plan');
    });
});
