import { describe, expect, it } from 'vitest';

import {
    resolveEffectiveConfiguredRuntimeControlSurface,
    resolveEffectiveSessionRuntimeControlSurface,
    supportsEffectiveLocalControlForSession,
} from './effectiveRuntimeControlSurface';

describe('effectiveRuntimeControlSurface', () => {
    it('uses the persisted OpenCode runtime kind to disable local control for ACP sessions', () => {
        expect(supportsEffectiveLocalControlForSession({
            agentId: 'opencode',
            metadata: { opencodeBackendMode: 'acp' },
            accountSettings: { opencodeBackendMode: 'server' },
        })).toBe(false);
    });

    it('keeps the base OpenCode local-control surface when the session has no persisted runtime identity', () => {
        expect(resolveEffectiveSessionRuntimeControlSurface({
            agentId: 'opencode',
            metadata: {},
            accountSettings: { opencodeBackendMode: 'acp' },
        }).localControl).toMatchObject({ supported: true, topology: 'shared' });
    });

    it('uses the persisted Codex runtime kind to disable local control for MCP sessions', () => {
        expect(supportsEffectiveLocalControlForSession({
            agentId: 'codex',
            metadata: {
                codexBackendMode: 'mcp',
                runtime: { provider: 'codex', backendMode: 'mcp' },
            },
        })).toBe(false);
    });

    it('uses the configured OpenCode runtime kind to disable direct storage for ACP new sessions', () => {
        expect(resolveEffectiveConfiguredRuntimeControlSurface({
            agentId: 'opencode',
            accountSettings: { opencodeBackendMode: 'acp' },
        }).sessionStorage).toMatchObject({ direct: false, persisted: true });
    });

    it('uses the shared Codex runtime default when no explicit backend mode is configured', () => {
        expect(resolveEffectiveConfiguredRuntimeControlSurface({
            agentId: 'codex',
            accountSettings: null,
        })).toMatchObject({
            sessionCapabilities: {
                sessionFork: { conversation: 'supported' },
            },
            localControl: { supported: true, topology: 'exclusive', attachStrategy: 'tmux' },
        });
    });
});
