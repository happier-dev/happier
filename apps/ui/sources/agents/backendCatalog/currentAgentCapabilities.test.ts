import { describe, expect, it } from 'vitest';

import {
    readCurrentProjectedAgentCapabilities,
    supportsAgentLifecycleCapability,
    supportsCurrentProjectedAgentConversationRollback,
    supportsCurrentProjectedAgentSessionOpen,
    supportsCurrentProjectedAgentSurface,
    supportsCurrentProjectedAgentUsageLimitRecovery,
} from './currentAgentCapabilities';

const projection = {
    generation: 42,
    agentsById: {
        'acme-lifecycle': {
            id: 'acme-lifecycle',
            identity: { pluginId: 'acme.lifecycle', localId: 'acme-lifecycle' },
            capabilities: {
                surfaces: ['terminal'],
                sessions: {
                    open: ['create', 'resume', 'fork'],
                    delivery: ['newTurn', 'steer', 'followUp'],
                    cancel: true,
                    conversationRollback: true,
                    usageLimitRecovery: {
                        active: ['checkNow'],
                        inactive: ['checkNow', 'consumeResetCredit'],
                    },
                },
            },
        },
    },
} as const;

describe('readCurrentProjectedAgentCapabilities', () => {
    it('exposes one exact normalized declaration and its Protocol-owned predicates', () => {
        const current = readCurrentProjectedAgentCapabilities({
            projection: projection as any,
            agentId: 'acme-lifecycle',
        });

        expect(current).toMatchObject({
            agentId: 'acme-lifecycle',
            identity: { pluginId: 'acme.lifecycle', localId: 'acme-lifecycle' },
            generation: 42,
        });
        expect(supportsCurrentProjectedAgentSessionOpen(current, 'resume')).toBe(true);
        expect(supportsCurrentProjectedAgentConversationRollback(current)).toBe(true);
        expect(supportsCurrentProjectedAgentUsageLimitRecovery(current, 'inactive', 'consumeResetCredit')).toBe(true);
        expect(supportsCurrentProjectedAgentSurface(current, 'terminal')).toBe(true);
    });

    it('fails closed for an unknown, mismatched, or presentation-only entry', () => {
        expect(readCurrentProjectedAgentCapabilities({
            projection: projection as any,
            agentId: 'unknown-agent',
        })).toBeNull();
        expect(readCurrentProjectedAgentCapabilities({
            projection: {
                ...projection,
                agentsById: {
                    'acme-lifecycle': {
                        ...projection.agentsById['acme-lifecycle'],
                        id: 'presentation-fallback',
                    },
                },
            } as any,
            agentId: 'acme-lifecycle',
        })).toBeNull();
        expect(readCurrentProjectedAgentCapabilities({
            projection: {
                ...projection,
                agentsById: {
                    'acme-lifecycle': {
                        id: 'acme-lifecycle',
                        identity: projection.agentsById['acme-lifecycle'].identity,
                    },
                },
            } as any,
            agentId: 'acme-lifecycle',
        })).toBeNull();
    });
});

describe('supportsAgentLifecycleCapability', () => {
    const externalAgent = readCurrentProjectedAgentCapabilities({
        projection: projection as any,
        agentId: 'acme-lifecycle',
    });

    it('answers every Agent from one owner instead of an identity-class branch', () => {
        // Bundled: Codex declares conversation fork/rollback, Claude does not.
        expect(supportsAgentLifecycleCapability({
            agentId: 'codex',
            capability: 'sessionFork.conversation',
            metadata: {},
        })).toBe(true);
        expect(supportsAgentLifecycleCapability({
            agentId: 'claude',
            capability: 'sessionRollback.conversation',
            metadata: {},
        })).toBe(false);

        // External: the same question, answered from its exact V2 declaration.
        expect(supportsAgentLifecycleCapability({
            agentId: 'acme-lifecycle',
            capability: 'sessionFork.conversation',
            metadata: {},
            currentAgentCapabilities: externalAgent,
        })).toBe(true);
        expect(supportsAgentLifecycleCapability({
            agentId: 'acme-lifecycle',
            capability: 'sessionRollback.conversation',
            metadata: {},
            currentAgentCapabilities: externalAgent,
        })).toBe(true);
    });

    it('keeps the bundled per-session runtime-kind refinement that a static V2 declaration cannot express', () => {
        // The same Codex Agent on its ACP runtime kind refuses conversation fork
        // and rollback. A projection-only reading would re-advertise both.
        const acpSessionMetadata = { codexBackendMode: 'acp', runtime: { provider: 'codex', backendMode: 'acp' } };
        expect(supportsAgentLifecycleCapability({
            agentId: 'codex',
            capability: 'sessionFork.conversation',
            metadata: acpSessionMetadata,
        })).toBe(false);
        expect(supportsAgentLifecycleCapability({
            agentId: 'codex',
            capability: 'sessionRollback.conversation',
            metadata: acpSessionMetadata,
        })).toBe(false);
    });

    it('reads the terminal surface for bundled and external Agents through the same question', () => {
        expect(supportsAgentLifecycleCapability({
            agentId: 'opencode',
            capability: 'surface.terminal',
            metadata: { opencodeBackendMode: 'acp' },
            accountSettings: { opencodeBackendMode: 'server' },
        })).toBe(false);
        expect(supportsAgentLifecycleCapability({
            agentId: 'codex',
            capability: 'surface.terminal',
            metadata: { codexBackendMode: 'mcp', runtime: { provider: 'codex', backendMode: 'mcp' } },
        })).toBe(false);
        expect(supportsAgentLifecycleCapability({
            agentId: 'acme-lifecycle',
            capability: 'surface.terminal',
            metadata: {},
            currentAgentCapabilities: externalAgent,
        })).toBe(true);
    });

    it('fails closed for an external Agent whose current declaration is absent or belongs to another Agent', () => {
        expect(supportsAgentLifecycleCapability({
            agentId: 'acme-lifecycle',
            capability: 'sessionFork.conversation',
            metadata: {},
        })).toBe(false);
        expect(supportsAgentLifecycleCapability({
            agentId: 'other-external',
            capability: 'surface.terminal',
            metadata: {},
            currentAgentCapabilities: externalAgent,
        })).toBe(false);
        expect(supportsAgentLifecycleCapability({
            agentId: null,
            capability: 'sessionRollback.conversation',
            metadata: {},
        })).toBe(false);
    });

    it('separates active from inactive usage-limit recovery for an external Agent', () => {
        expect(supportsAgentLifecycleCapability({
            agentId: 'acme-lifecycle',
            capability: 'usageLimitRecovery.checkNow',
            metadata: {},
            sessionActive: true,
            currentAgentCapabilities: externalAgent,
        })).toBe(true);
        // Claude declares no V2 usage-limit recovery, but its bundled contribution does.
        expect(supportsAgentLifecycleCapability({
            agentId: 'claude',
            capability: 'usageLimitRecovery.checkNow',
            metadata: {},
            sessionActive: true,
        })).toBe(true);
    });
});

describe('supportsAgentLifecycleCapability runtime-kind refinement', () => {
    it('reads the terminal surface from the same Session runtime kind every other capability uses', () => {
        // No runtime kind is recorded on this Session, so the Agent's configured
        // runtime kind decides. Fork already answered from that kind; the
        // terminal surface used to answer from the Agent's default kind instead,
        // so one Session could be told "no native fork" and "yes terminal" about
        // the very same OpenCode ACP runtime.
        const acpAccountSettings = { opencodeBackendMode: 'acp' };
        expect(supportsAgentLifecycleCapability({
            agentId: 'opencode',
            capability: 'sessionFork.fromMessage',
            metadata: {},
            accountSettings: acpAccountSettings,
        })).toBe(false);
        expect(supportsAgentLifecycleCapability({
            agentId: 'opencode',
            capability: 'surface.terminal',
            metadata: {},
            accountSettings: acpAccountSettings,
        })).toBe(false);
        // The configured server runtime keeps both.
        expect(supportsAgentLifecycleCapability({
            agentId: 'opencode',
            capability: 'surface.terminal',
            metadata: {},
            accountSettings: { opencodeBackendMode: 'server' },
        })).toBe(true);
    });

    it('keeps conversation fork and from-message fork distinct for a bundled Agent', () => {
        // A V2 declaration only carries a coarse `open: ['fork']`. Codex forks the
        // conversation but cannot fork from a message, so collapsing both
        // questions onto that one entry would advertise a route Codex refuses.
        expect(supportsAgentLifecycleCapability({
            agentId: 'codex',
            capability: 'sessionFork.conversation',
            metadata: {},
        })).toBe(true);
        expect(supportsAgentLifecycleCapability({
            agentId: 'codex',
            capability: 'sessionFork.fromMessage',
            metadata: {},
        })).toBe(false);
    });
});
