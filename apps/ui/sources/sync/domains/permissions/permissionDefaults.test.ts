import { describe, expect, it } from 'vitest';
import type { PermissionMode } from './permissionTypes';
import { resolveNewSessionDefaultPermissionMode } from './permissionDefaults';

describe('resolveNewSessionDefaultPermissionMode', () => {
    const accountDefaults = {
        claude: 'plan' as PermissionMode,
        codex: 'safe-yolo' as PermissionMode,
        gemini: 'read-only' as PermissionMode,
    };

    it('uses account defaults when no profile override is present', () => {
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'claude', accountDefaults })).toBe('read-only');
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'codex', accountDefaults })).toBe('safe-yolo');
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'gemini', accountDefaults })).toBe('read-only');
    });

    it('uses provider-specific profile overrides when present', () => {
        const profileDefaults = { codex: 'yolo' as PermissionMode };
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'codex', accountDefaults, profileDefaults })).toBe('yolo');
        // Other providers fall back to account defaults when no override exists.
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'claude', accountDefaults, profileDefaults })).toBe('read-only');
    });

    it('falls back to legacy profile override mapping when provider-specific override is missing', () => {
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'claude', accountDefaults, legacyProfileDefaultPermissionMode: 'plan' })).toBe('read-only');
        // Legacy "plan" is mapped to read-only.
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'codex', accountDefaults, legacyProfileDefaultPermissionMode: 'plan' })).toBe('read-only');
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'gemini', accountDefaults, legacyProfileDefaultPermissionMode: 'bypassPermissions' })).toBe('yolo');
    });

    it('clamps unsupported profile override modes to safe defaults for the target provider', () => {
        // Codex-like agents do not expose "plan" as a permission mode.
        expect(resolveNewSessionDefaultPermissionMode({ agentType: 'codex', accountDefaults, legacyProfileDefaultPermissionMode: 'plan' })).toBe('read-only');
    });
});
