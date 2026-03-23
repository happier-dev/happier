import { describe, expect, it } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import type { PermissionMode } from './permissionTypes';
import { readAccountPermissionDefaults, resolveNewSessionDefaultPermissionMode } from './permissionDefaults';

describe('resolveNewSessionDefaultPermissionMode', () => {
    const accountDefaultsByTargetKey = {
        [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: 'plan' as PermissionMode,
        [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: 'safe-yolo' as PermissionMode,
        [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: 'read-only' as PermissionMode,
    };
    const accountDefaults = readAccountPermissionDefaults(accountDefaultsByTargetKey, ['claude', 'codex', 'gemini', 'customAcp']);

    it('reads account defaults from backend target keys', () => {
        expect(readAccountPermissionDefaults(accountDefaultsByTargetKey, ['claude', 'codex', 'gemini'])).toEqual({
            byTargetKey: {
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: 'plan',
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: 'safe-yolo',
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: 'read-only',
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
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: 'yolo' as PermissionMode,
        };
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'codex', accountDefaults, profileDefaultsByTargetKey })).toBe('yolo');
        // Other providers fall back to account defaults when no override exists.
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'claude', accountDefaults, profileDefaultsByTargetKey })).toBe('read-only');
    });

    it('prefers configured ACP backend target defaults over the custom ACP family default', () => {
        const configuredTarget = { kind: 'configuredAcpBackend', backendId: 'review-bot' } as const;
        const configuredDefaults = readAccountPermissionDefaults({
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'customAcp' })]: 'read-only',
            [buildBackendTargetKey(configuredTarget)]: 'safe-yolo',
        }, ['customAcp']);

        expect(resolveNewSessionDefaultPermissionMode({
            agentType: 'customAcp',
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
});
