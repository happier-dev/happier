import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import { createSessionProviderBehaviorFromDescriptor } from './sessionProviderBehaviorDescriptors';
import type { SessionProviderBehavior } from './sessionProviderBehaviorTypes';

type DeriveTargetsContext = Parameters<
    NonNullable<NonNullable<SessionProviderBehavior['participants']>['deriveTargets']>
>[0];

const agentTeamMemberSubagent = {
    id: 'agent_team_member:probe:alpha@probe',
    kind: 'agent_team_member',
    status: 'running',
    display: { title: 'alpha' },
    transcript: {},
    recipient: { kind: 'agent_team_member', teamId: 'probe', memberId: 'alpha@probe' },
    capabilities: {
        canOpen: false,
        canSend: true,
        canStop: false,
        canLaunchChild: false,
        canDelete: true,
        canOpenAdvancedRun: false,
    },
    timestamps: {},
} satisfies SessionSubagent;

describe('createSessionProviderBehaviorFromDescriptor', () => {
    it('builds generic participant and subagent behavior from descriptor predicates', () => {
        const { behavior, diagnostics } = createSessionProviderBehaviorFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'acme',
            agentId: 'acme',
            version: 1,
            display: {},
            session: {
                providerBehavior: {
                    kind: 'session.providerBehavior.v1',
                    participants: {
                        sidechainIds: {
                            kind: 'toolCallInputString',
                            toolNames: ['Task'],
                            inputKey: 'sidechainId',
                        },
                    },
                    subagents: {
                        ignoreActivityPreviewText: {
                            kind: 'jsonEventType',
                            recipientKinds: ['agent_team_member'],
                            eventTypes: ['idle_notification'],
                        },
                    },
                },
            },
            message: {},
            components: { slots: [] },
        });

        expect(diagnostics).toEqual([]);
        const sidechainMessages = [{
            kind: 'tool-call',
            id: 'tool-1',
            localId: null,
            createdAt: 1,
            children: [],
            tool: {
                name: 'Task',
                state: 'completed',
                input: { sidechainId: 'side-1' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
            },
        }] satisfies readonly Message[];
        expect(behavior.participants?.deriveSidechainIds?.({
            flavor: 'acme',
            messages: sidechainMessages,
        })).toEqual(['side-1']);
        expect(behavior.subagents?.shouldIgnoreActivityPreviewText?.({
            subagent: agentTeamMemberSubagent,
            text: '{"type":"idle_notification"}',
        })).toBe(true);
    });

    it('fails closed for unsupported predicate kinds', () => {
        const { behavior, diagnostics } = createSessionProviderBehaviorFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'acme',
            agentId: 'acme',
            version: 1,
            display: {},
            session: {
                providerBehavior: {
                    kind: 'session.providerBehavior.v1',
                    participants: {
                        sidechainIds: {
                            kind: 'providerCallback',
                            callbackId: 'acme.local',
                        },
                    },
                },
            },
            message: {},
            components: { slots: [] },
        });

        expect(behavior.participants?.deriveSidechainIds).toBeUndefined();
        expect(diagnostics).toContainEqual(expect.objectContaining({
            code: 'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            path: 'participants.sidechainIds',
        }));
    });

    it('fails closed for unsupported provider behavior descriptor ids', () => {
        const { behavior, diagnostics } = createSessionProviderBehaviorFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'claude',
            agentId: 'claude',
            version: 1,
            display: {},
            session: {
                providerBehaviorDescriptorId: 'claude.unknownSessionProviderBehavior.v1',
            },
            message: {},
            components: { slots: [] },
        });

        expect(behavior).toEqual({});
        expect(diagnostics).toContainEqual(expect.objectContaining({
            code: 'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            path: 'session.providerBehaviorDescriptorId',
        }));
    });

    it('does not materialize executable provider behavior from descriptor ids alone', () => {
        const { behavior, diagnostics } = createSessionProviderBehaviorFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'claude',
            agentId: 'claude',
            version: 1,
            display: {},
            session: {
                providerBehaviorDescriptorId: 'claude.sessionProviderBehavior.v1',
            },
            message: {},
            components: { slots: [] },
        });

        expect(behavior).toEqual({});
        expect(diagnostics).toContainEqual(expect.objectContaining({
            code: 'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            path: 'session.providerBehaviorDescriptorId',
        }));
    });

    it('builds agent team participant and subagent behavior from descriptor data', () => {
        const { behavior, diagnostics } = createSessionProviderBehaviorFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'claude',
            agentId: 'claude',
            version: 1,
            display: {},
            session: {
                providerBehavior: {
                    kind: 'session.providerBehavior.v1',
                    agentTeam: {
                        kind: 'session.agentTeamBehavior.v1',
                        snapshotKey: 'claudeTeam',
                        providerLabel: 'Claude',
                        flavorAliases: ['claude'],
                        tools: {
                            teamCreate: ['AgentTeamCreate', 'TeamCreate'],
                            teamDelete: ['AgentTeamDelete', 'TeamDelete'],
                            teamSendMessage: ['AgentTeamSendMessage', 'TeamSendMessage'],
                            subagentSpawn: ['Agent', 'Task'],
                            activeTeamFallbackSubagentSpawn: ['Agent'],
                            configMutation: ['Edit', 'Write'],
                        },
                        configTeamPath: {
                            rootDirectory: '.claude',
                            teamsDirectory: 'teams',
                            filename: 'config.json',
                        },
                        lifecycleEvents: {
                            ignoreActivityPreview: ['idle_notification', 'shutdown_approved'],
                            shutdownApproved: 'shutdown_approved',
                        },
                    },
                },
            },
            message: {},
            components: { slots: [] },
        });

        const messages = [
            {
                kind: 'tool-call',
                id: 'create',
                localId: null,
                createdAt: 1,
                children: [],
                tool: {
                    id: 'tool-create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                    result: { ok: true, team_name: 'probe' },
                    createdAt: 1,
                    startedAt: 1,
                    completedAt: 2,
                    description: null,
                },
            },
            {
                kind: 'tool-call',
                id: 'task-alpha',
                localId: null,
                createdAt: 3,
                children: [],
                tool: {
                    id: 'tool-alpha',
                    name: 'Task',
                    state: 'completed',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: {
                        tool_use_result: {
                            status: 'teammate_spawned',
                            team_name: 'probe',
                            agent_id: 'alpha@probe',
                            name: 'alpha',
                        },
                    },
                    createdAt: 3,
                    startedAt: 3,
                    completedAt: 4,
                    description: null,
                },
            },
        ] satisfies readonly Message[];

        expect(diagnostics).toEqual([]);
        expect(behavior.participants?.deriveSnapshot?.({ flavor: 'claude', messages })).toEqual({
            claudeTeam: {
                teamId: 'probe',
                members: [{ memberId: 'alpha@probe', memberLabel: 'alpha' }],
            },
        });
        expect(behavior.participants?.deriveSidechainIds?.({ flavor: 'claude', messages })).toEqual(['tool-alpha']);
        const targetContext: DeriveTargetsContext = {
            // deriveTargets only reads session.metadata; a full Session fixture would obscure the descriptor behavior under test.
            session: { metadata: { flavor: 'claude' } } as DeriveTargetsContext['session'],
            messages,
            currentTargets: [],
        };
        expect(behavior.participants?.deriveTargets?.(targetContext)).toEqual([{
            key: 'agent_team_broadcast:probe',
            displayLabel: 'probe',
            recipient: { kind: 'agent_team_broadcast', teamId: 'probe' },
        }]);
        expect(behavior.subagents?.deriveSubagents?.({ flavor: 'claude', messages })[0]).toMatchObject({
            id: 'agent_team_member:probe:alpha@probe',
            kind: 'agent_team_member',
            status: 'running',
            display: {
                title: 'alpha',
                providerLabel: 'Claude',
                groupKey: 'probe',
                groupLabel: 'probe',
            },
            transcript: {
                sidechainId: 'tool-alpha',
                toolId: 'tool-alpha',
            },
            recipient: {
                kind: 'agent_team_member',
                teamId: 'probe',
                memberId: 'alpha@probe',
                memberLabel: 'alpha',
            },
        });
        expect(behavior.subagents?.shouldIgnoreActivityPreviewText?.({
            subagent: agentTeamMemberSubagent,
            text: '{"type":"shutdown_approved"}',
        })).toBe(true);
    });

    it('keeps legacy unavailable Agent Team tool calls usable by generic provider behavior', () => {
        const { behavior, diagnostics } = createSessionProviderBehaviorFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'claude',
            agentId: 'claude',
            version: 1,
            display: {},
            session: {
                providerBehavior: {
                    kind: 'session.providerBehavior.v1',
                    agentTeam: {
                        kind: 'session.agentTeamBehavior.v1',
                        snapshotKey: 'claudeTeam',
                        providerLabel: 'Claude',
                        flavorAliases: ['claude'],
                        tools: {
                            teamCreate: ['AgentTeamCreate'],
                            teamDelete: ['AgentTeamDelete'],
                            teamSendMessage: ['AgentTeamSendMessage'],
                            subagentSpawn: ['Task'],
                        },
                    },
                },
            },
            message: {},
            components: { slots: [] },
        });
        const messages = [{
            kind: 'tool-call',
            id: 'legacy-task',
            localId: null,
            createdAt: 1,
            children: [],
            tool: {
                id: 'legacy-tool',
                name: 'Task',
                state: 'unavailable',
                input: { team_name: 'legacy', name: 'alpha' },
                createdAt: 1,
                startedAt: null,
                completedAt: null,
                description: null,
            },
        }] satisfies readonly Message[];

        expect(diagnostics).toEqual([]);
        expect(behavior.participants?.deriveSidechainIds?.({ flavor: 'claude', messages })).toEqual(['legacy-tool']);
        expect(behavior.subagents?.deriveSubagents?.({ flavor: 'claude', messages })).toEqual([
            expect.objectContaining({
                id: 'agent_team_member:legacy:alpha@legacy',
                transcript: expect.objectContaining({ sidechainId: 'legacy-tool' }),
            }),
        ]);
    });
});
