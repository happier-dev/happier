import { describe, expect, it } from 'vitest';

import { resolveAgentUiBehaviorFromFlavor, resolveSessionGoalActionCapabilityProfile, supportsEditableSessionGoals } from './registryUiBehavior';
import type { Session } from '@/sync/domains/state/storageTypes';

function createRegistryBehaviorSession(
    metadata: Session['metadata'],
    goalControls: Readonly<{ canSet: boolean; canClear: boolean }> = { canSet: false, canClear: false },
): Session {
    return {
        id: 's1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata,
        metadataVersion: 1,
        agentState: {
            capabilities: {
                sessionGoalSetSupported: goalControls.canSet,
                sessionGoalClearSupported: goalControls.canClear,
            },
        },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

describe('resolveAgentUiBehaviorFromFlavor', () => {
    it('resolves provider behavior through shared flavor aliases', () => {
        const behavior = resolveAgentUiBehaviorFromFlavor('open-code');

        expect(behavior?.directSessions?.browse?.getSourceOptions).toBeTypeOf('function');
    });

    it('keeps codex-specific permission footer overrides on the native codex agent', () => {
        const behavior = resolveAgentUiBehaviorFromFlavor('codex');

        expect(behavior?.permissions?.footer?.stopHandling).toBe('denyOnly');
        expect(behavior?.permissions?.footer?.supportsExecPolicyAmendment).toBe(true);
        expect(behavior?.sessionUsage?.supportsExactContextUsageBadge).toBe(false);
    });

    it('projects pending delivery presentation through the Claude provider behavior', () => {
        expect(resolveAgentUiBehaviorFromFlavor('claude')?.pendingDelivery?.resolveLabelKey).toBeTypeOf('function');
        expect(resolveAgentUiBehaviorFromFlavor('codex')?.pendingDelivery?.resolveLabelKey).toBeUndefined();
    });

    it('exposes editable goals for explicit codex app-server sessions and rejects explicit alternate modes', () => {
        expect(supportsEditableSessionGoals({
            agentId: 'codex',
            session: createRegistryBehaviorSession({
                flavor: 'codex',
                path: '/repo',
                host: 'host',
                codexBackendMode: 'appServer',
            }, { canSet: true, canClear: true }),
        })).toBe(true);

        expect(supportsEditableSessionGoals({
            agentId: 'codex',
            session: createRegistryBehaviorSession({
                flavor: 'codex',
                path: '/repo',
                host: 'host',
                codexBackendMode: 'acp',
            }),
        })).toBe(false);
    });

    it('intersects the full Codex goal surface with its live runtime controls', () => {
        expect(resolveSessionGoalActionCapabilityProfile({
            agentId: 'codex',
            session: createRegistryBehaviorSession({
                flavor: 'codex', path: '/repo', host: 'host', codexBackendMode: 'appServer',
            }, { canSet: true, canClear: false }),
        })).toEqual({ canEdit: true, canStop: true, canClear: false, canConfigureBudget: true });
    });

    it('restricts the goal action profile for an editable Claude session (edit/clear only, no budget)', () => {
        const profile = resolveSessionGoalActionCapabilityProfile({
            agentId: 'claude',
            session: {
                ...createRegistryBehaviorSession({
                    flavor: 'claude', path: '/repo', host: 'host', slashCommands: ['goal', 'help'],
                }),
                agentState: {
                    capabilities: {
                        sessionGoalSetSupported: true,
                        sessionGoalClearSupported: true,
                    },
                },
            },
        });
        expect(profile).toEqual({ canEdit: true, canStop: false, canClear: true, canConfigureBudget: false });
    });

    it('returns no goal action profile for a Claude session without /goal capability', () => {
        expect(resolveSessionGoalActionCapabilityProfile({
            agentId: 'claude',
            session: createRegistryBehaviorSession({ flavor: 'claude', path: '/repo', host: 'host' }),
        })).toBeNull();
    });

    it('fails closed for live Codex sessions whose runner does not publish goal controls', () => {
        expect(supportsEditableSessionGoals({
            agentId: 'codex',
            session: createRegistryBehaviorSession({
                flavor: 'codex',
                path: '/repo',
                host: 'host',
            }),
        })).toBe(false);

        expect(supportsEditableSessionGoals({
            agentId: 'codex',
            session: createRegistryBehaviorSession({
                flavor: 'codex',
                path: '/repo',
                host: 'host',
            }, { canSet: true, canClear: false }),
        })).toBe(true);
    });

    it('allows codex sessions with a native goal projection to edit the goal after runtime metadata is missing', () => {
        expect(supportsEditableSessionGoals({
            agentId: 'codex',
            session: {
                ...createRegistryBehaviorSession({
                    flavor: 'codex',
                    path: '/repo',
                    host: 'host',
                    sessionWorkStateV1: {
                        v: 1,
                        backendId: 'codex',
                        updatedAt: 10,
                        primaryItemId: 'goal:thread-1',
                        items: [
                            {
                                id: 'goal:thread-1',
                                kind: 'goal',
                                origin: 'vendor',
                                status: 'active',
                                title: 'Ship goals',
                                updatedAt: 10,
                            },
                        ],
                    },
                }),
                active: false,
            },
            daemonGoalControlsSupported: true,
        })).toBe(true);

        expect(supportsEditableSessionGoals({
            agentId: 'codex',
            session: {
                ...createRegistryBehaviorSession({
                    flavor: 'codex',
                    path: '/repo',
                    host: 'host',
                    codexBackendMode: 'appServer',
                }),
                active: false,
            },
        })).toBe(false);
    });

    it('uses the generic codex-decision footer behavior for opencode-family flavors', () => {
        const behavior = resolveAgentUiBehaviorFromFlavor('open-code');

        expect(behavior?.permissions?.footer?.stopHandling).toBe('denyAndAbortRun');
        expect(behavior?.permissions?.footer?.supportsExecPolicyAmendment).toBe(false);
        expect(behavior?.sessionUsage?.supportsExactContextUsageBadge).toBe(true);
    });
});
