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
        codex: {
            id: 'codex',
            identity: { pluginId: 'codex', localId: 'codex' },
            capabilities: {
                surfaces: ['terminal'],
                sessions: {
                    open: ['create', 'resume', 'fork'],
                    delivery: ['newTurn', 'steer'],
                    cancel: true,
                    conversationRollback: true,
                    usageLimitRecovery: {
                        active: ['checkNow'],
                        inactive: ['checkNow'],
                    },
                },
            },
        },
        claude: {
            id: 'claude',
            identity: { pluginId: 'claude', localId: 'claude' },
            capabilities: {
                surfaces: ['terminal'],
                sessions: {
                    open: ['create', 'resume'],
                    delivery: ['newTurn', 'steer', 'followUp'],
                    cancel: true,
                },
            },
        },
        opencode: {
            id: 'opencode',
            identity: { pluginId: 'opencode', localId: 'opencode' },
            capabilities: {
                sessions: {
                    open: ['create', 'resume', 'fork'],
                    delivery: ['newTurn', 'steer'],
                    cancel: true,
                },
            },
        },
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

    it('answers bundled and external Agents from the same exact V2 projection', () => {
        const currentCodex = readCurrentProjectedAgentCapabilities({
            projection: projection as any,
            agentId: 'codex',
        });
        const currentClaude = readCurrentProjectedAgentCapabilities({
            projection: projection as any,
            agentId: 'claude',
        });
        expect(supportsAgentLifecycleCapability({
            agentId: 'codex',
            capability: 'sessionFork.conversation',
            metadata: {},
            currentAgentCapabilities: currentCodex,
        })).toBe(true);
        expect(supportsAgentLifecycleCapability({
            agentId: 'claude',
            capability: 'sessionRollback.conversation',
            metadata: {},
            currentAgentCapabilities: currentClaude,
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

    it('refines either origin with the exact Session runtime capability publication', () => {
        const currentCodex = readCurrentProjectedAgentCapabilities({
            projection: projection as any,
            agentId: 'codex',
        });
        const acpSessionMetadata = {
            runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { opaqueMode: 'private' } },
            agentRuntimeCapabilitiesV1: {
                sessionCapabilities: {
                    sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
                    sessionRollback: { conversation: 'unsupported' },
                },
            },
        };
        expect(supportsAgentLifecycleCapability({
            agentId: 'codex',
            capability: 'sessionFork.conversation',
            metadata: acpSessionMetadata,
            currentAgentCapabilities: currentCodex,
        })).toBe(false);
        expect(supportsAgentLifecycleCapability({
            agentId: 'codex',
            capability: 'sessionRollback.conversation',
            metadata: acpSessionMetadata,
            currentAgentCapabilities: currentCodex,
        })).toBe(false);
    });

    it('reads the terminal surface for bundled and external Agents through the same question', () => {
        expect(supportsAgentLifecycleCapability({
            agentId: 'opencode',
            capability: 'surface.terminal',
            metadata: { opencodeBackendMode: 'acp' },
            currentAgentCapabilities: readCurrentProjectedAgentCapabilities({
                projection: projection as any,
                agentId: 'opencode',
            }),
        })).toBe(false);
        expect(supportsAgentLifecycleCapability({
            agentId: 'codex',
            capability: 'surface.terminal',
            metadata: {
                agentRuntimeCapabilitiesV1: {
                    sessionCapabilities: {},
                    localControl: { supported: false },
                },
            },
            currentAgentCapabilities: readCurrentProjectedAgentCapabilities({
                projection: projection as any,
                agentId: 'codex',
            }),
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
        expect(supportsAgentLifecycleCapability({
            agentId: 'acme-lifecycle',
            capability: 'sessionFork.conversation',
            metadata: {
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'different-agent',
                    agent: {},
                },
                agentRuntimeCapabilitiesV1: {
                    sessionCapabilities: {
                        sessionFork: { conversation: 'supported' },
                    },
                },
            },
            currentAgentCapabilities: externalAgent,
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
        // A declaration without an executable readiness operation fails closed
        // for either origin.
        expect(supportsAgentLifecycleCapability({
            agentId: 'claude',
            capability: 'usageLimitRecovery.checkNow',
            metadata: {
                agentRuntimeCapabilitiesV1: {
                    sessionCapabilities: {
                        usageLimitRecovery: { checkNow: 'supported' },
                    },
                },
            },
            sessionActive: true,
            currentAgentCapabilities: readCurrentProjectedAgentCapabilities({
                projection: projection as any,
                agentId: 'claude',
            }),
        })).toBe(false);
        expect(supportsAgentLifecycleCapability({
            agentId: 'codex',
            capability: 'usageLimitRecovery.checkNow',
            metadata: {
                agentRuntimeCapabilitiesV1: {
                    sessionCapabilities: {
                        usageLimitRecovery: { checkNow: 'unsupported' },
                    },
                },
            },
            sessionActive: true,
            currentAgentCapabilities: readCurrentProjectedAgentCapabilities({
                projection: projection as any,
                agentId: 'codex',
            }),
        })).toBe(true);
    });
});

describe('supportsAgentLifecycleCapability runtime-kind refinement', () => {
    it('reads current Session capability and terminal facts from the live runtime publication', () => {
        const currentAcpMetadata = {
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'opencode',
                agent: { privatelyOwnedMode: 'acp' },
            },
            agentRuntimeCapabilitiesV1: {
                sessionCapabilities: {
                    sessionFork: { fromMessage: 'unsupported' },
                },
                localControl: null,
            },
        };
        expect(supportsAgentLifecycleCapability({
            agentId: 'opencode',
            capability: 'sessionFork.fromMessage',
            metadata: currentAcpMetadata,
            currentAgentCapabilities: readCurrentProjectedAgentCapabilities({
                projection: projection as any,
                agentId: 'opencode',
            }),
        })).toBe(false);
        expect(supportsAgentLifecycleCapability({
            agentId: 'opencode',
            capability: 'surface.terminal',
            metadata: currentAcpMetadata,
            currentAgentCapabilities: readCurrentProjectedAgentCapabilities({
                projection: projection as any,
                agentId: 'opencode',
            }),
        })).toBe(false);

        // With no concrete Session runtime fact, both origins use their exact
        // projected declaration; generic UI does not interpret Agent settings.
        expect(supportsAgentLifecycleCapability({
            agentId: 'opencode',
            capability: 'surface.terminal',
            metadata: {},
            currentAgentCapabilities: readCurrentProjectedAgentCapabilities({
                projection: projection as any,
                agentId: 'opencode',
            }),
        })).toBe(false);
    });

    it('keeps conversation fork and from-message fork distinct for a bundled Agent', () => {
        // A V2 declaration only carries a coarse `open: ['fork']`. Codex forks the
        // conversation but cannot fork from a message, so collapsing both
        // questions onto that one entry would advertise a route Codex refuses.
        expect(supportsAgentLifecycleCapability({
            agentId: 'codex',
            capability: 'sessionFork.conversation',
            metadata: {},
            currentAgentCapabilities: readCurrentProjectedAgentCapabilities({
                projection: projection as any,
                agentId: 'codex',
            }),
        })).toBe(true);
        expect(supportsAgentLifecycleCapability({
            agentId: 'codex',
            capability: 'sessionFork.fromMessage',
            metadata: {},
            currentAgentCapabilities: readCurrentProjectedAgentCapabilities({
                projection: projection as any,
                agentId: 'codex',
            }),
        })).toBe(false);
    });
});
