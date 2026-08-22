import { describe, expect, it } from 'vitest';

import { resolveEffectiveConfiguredRuntimeControlSurface } from './effectiveRuntimeControlSurface';

describe('effectiveRuntimeControlSurface', () => {
    it('resolves no runtime control surface for an Agent with no bundled runtime contribution', () => {
        expect(resolveEffectiveConfiguredRuntimeControlSurface({
            agentId: 'acme-lifecycle',
            accountSettings: null,
        })).toBeNull();
    });

    it('uses the configured OpenCode runtime kind to disable direct storage for ACP new sessions', () => {
        expect(resolveEffectiveConfiguredRuntimeControlSurface({
            agentId: 'opencode',
            accountSettings: { opencodeBackendMode: 'acp' },
        })?.sessionStorage).toMatchObject({ direct: false, persisted: true });
    });

    it('uses the shared Codex runtime default when no explicit backend mode is configured', () => {
        expect(resolveEffectiveConfiguredRuntimeControlSurface({
            agentId: 'codex',
            accountSettings: null,
        })).toMatchObject({
            sessionCapabilities: {
                sessionFork: { conversation: 'supported' },
            },
            localControl: { supported: true, topology: 'exclusive', attachStrategy: 'terminal_host' },
        });
    });
});
