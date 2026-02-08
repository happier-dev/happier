import { describe, it, expect } from 'vitest';

import { resolveAgentIdOrDefault, resolveAgentIdForPermissionUi } from './resolve';

describe('agents/resolve', () => {
    it('falls back to a default agent id for unknown flavors', () => {
        expect(resolveAgentIdOrDefault('unknown', 'claude')).toBe('claude');
        expect(resolveAgentIdOrDefault(null, 'claude')).toBe('claude');
    });

    it('uses canonical flavor when known and ignores tool prefix hints', () => {
        expect(resolveAgentIdForPermissionUi({ flavor: 'claude', toolName: 'CodexBash' })).toBe('claude');
        expect(resolveAgentIdForPermissionUi({ flavor: 'gemini', toolName: 'CodexBash' })).toBe('gemini');
    });

    it('prefers Codex tool prefix hints for permission UI', () => {
        expect(resolveAgentIdForPermissionUi({ flavor: null, toolName: 'CodexBash' })).toBe('codex');
        expect(resolveAgentIdForPermissionUi({ flavor: '', toolName: 'CodexBash' })).toBe('codex');
    });

    it('falls back to default agent when no flavor or codex tool hint exists', () => {
        expect(resolveAgentIdForPermissionUi({ flavor: null, toolName: 'Bash' })).toBe('claude');
        expect(resolveAgentIdForPermissionUi({ flavor: undefined, toolName: '' })).toBe('claude');
    });
});
