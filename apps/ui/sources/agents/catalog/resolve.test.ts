import { describe, it, expect } from 'vitest';

import { resolveAgentIdOrDefault, resolveAgentIdForPermissionUi } from './resolve';

describe('agents/resolve', () => {
    it('preserves an unrecognized Agent identity and falls back only when it is absent', () => {
        expect(resolveAgentIdOrDefault('acme.agent', 'claude')).toBe('acme.agent');
        expect(resolveAgentIdOrDefault(null, 'claude')).toBe('claude');
    });

    it('uses canonical flavor when known and ignores tool prefix hints', () => {
        expect(resolveAgentIdForPermissionUi({ flavor: 'claude', toolName: 'CodexBash' })).toBe('claude');
        expect(resolveAgentIdForPermissionUi({ flavor: 'gemini', toolName: 'CodexBash' })).toBe('gemini');
    });

    it('prefers canonical session runtime metadata over stale flavor and tool prefix hints', () => {
        expect(resolveAgentIdForPermissionUi({
            metadata: {
                flavor: 'claude',
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    provider: {},
                },
            },
            flavor: 'claude',
            toolName: 'OpenCodeBash',
        })).toBe('codex');
    });

    it('preserves an installed external Agent declared by session metadata', () => {
        expect(resolveAgentIdForPermissionUi({
            metadata: {
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'acme.agent',
                    provider: {},
                },
            },
            flavor: 'claude',
            toolName: 'ClaudeBash',
        })).toBe('acme.agent');
    });

    it('preserves an external flavor instead of applying bundled tool-prefix behavior', () => {
        expect(resolveAgentIdForPermissionUi({
            flavor: 'acme.agent',
            toolName: 'CodexBash',
        })).toBe('acme.agent');
    });

    it('prefers Codex tool prefix hints for permission UI', () => {
        expect(resolveAgentIdForPermissionUi({ flavor: null, toolName: 'CodexBash' })).toBe('codex');
        expect(resolveAgentIdForPermissionUi({ flavor: '', toolName: 'CodexBash' })).toBe('codex');
    });

    it('uses registry-backed tool prefix hints for other agents too', () => {
        expect(resolveAgentIdForPermissionUi({ flavor: null, toolName: 'OpenCodeBash' })).toBe('opencode');
    });

    it('falls back to default agent when no flavor or codex tool hint exists', () => {
        expect(resolveAgentIdForPermissionUi({ flavor: null, toolName: 'Bash' })).toBe('claude');
        expect(resolveAgentIdForPermissionUi({ flavor: undefined, toolName: '' })).toBe('claude');
    });
});
