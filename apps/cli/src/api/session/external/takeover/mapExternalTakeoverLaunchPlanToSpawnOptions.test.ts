import { describe, expect, it } from 'vitest';

import type {
    AgentExternalSessionTakeoverLaunchPlan,
    AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
    mapExternalTakeoverLaunchPlanToSpawnOptions,
} from './mapExternalTakeoverLaunchPlanToSpawnOptions';

type TargetAgent = Parameters<
    typeof mapExternalTakeoverLaunchPlanToSpawnOptions
>[0]['targetAgent'];

function targetAgent(params: Readonly<{
    id?: string;
    pluginId?: string;
    localId?: string;
    declaredEnvironmentKeys?: readonly string[];
}> = {}): TargetAgent {
    return {
        id: params.id ?? 'fixture-agent',
        identity: {
            pluginId: params.pluginId ?? 'happier.agent.fixture',
            localId: params.localId ?? params.id ?? 'fixture-agent',
        },
        hostAccess: {
            required: [{
                id: 'fixture-process',
                capability: 'process',
                reason: 'Fixture process launch.',
                scope: {
                    executables: [{ kind: 'systemTool', id: 'fixture-tool' }],
                    envKeys: [...(params.declaredEnvironmentKeys ?? [])],
                },
            }],
            optional: [],
        },
    };
}

function resolvedIdentity(
    overrides: Partial<AgentExternalSessionsResolvedIdentity> = {},
): AgentExternalSessionsResolvedIdentity {
    return {
        source: { kind: 'fixtureSource', revision: 'fresh' },
        remoteSessionId: 'remote-fresh',
        linkData: { revision: 'fresh' },
        ...overrides,
    };
}

describe('mapExternalTakeoverLaunchPlanToSpawnOptions', () => {
    it('keeps the host-selected local target when a plugin returns a remote provider directory', () => {
        expect(mapExternalTakeoverLaunchPlanToSpawnOptions({
            plan: {
                directory: '/remote/provider/workspace',
                backendModeHint: 'native-mode',
            },
            targetDirectory: '/local/selected/workspace',
            resolvedIdentity: resolvedIdentity(),
            linkedSessionId: 'session-linked',
            targetAgent: targetAgent(),
        })).toMatchObject({
            directory: '/local/selected/workspace',
            backendMode: 'native-mode',
        });
    });

    it('preserves every byte of an already-admitted POSIX target directory', () => {
        expect(mapExternalTakeoverLaunchPlanToSpawnOptions({
            plan: { directory: '/remote/provider/workspace' },
            targetDirectory: '/work/repo ',
            resolvedIdentity: resolvedIdentity(),
            linkedSessionId: 'session-linked',
            targetAgent: targetAgent(),
        })).toMatchObject({
            directory: '/work/repo ',
        });
    });

    it('maps only accepted launch hints while the host supplies target and fresh resume identity', () => {
        const plan: AgentExternalSessionTakeoverLaunchPlan = {
            directory: '/workspace/fresh',
            backendModeHint: 'native-mode',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'fixture-agent',
                agent: {
                    providerSessionId: 'remote-fresh',
                    sessionFile: '/agent/sessions/remote-fresh.jsonl',
                },
            },
            environmentVariables: {
                FIXTURE_HOME: '/runtime/fresh',
            },
        };

        expect(mapExternalTakeoverLaunchPlanToSpawnOptions({
            plan,
            targetDirectory: '/workspace/fresh',
            resolvedIdentity: resolvedIdentity(),
            linkedSessionId: 'session-linked',
            targetAgent: targetAgent({
                declaredEnvironmentKeys: ['FIXTURE_HOME'],
            }),
        })).toEqual({
            directory: '/workspace/fresh',
            agentTarget: {
                kind: 'agent',
                identity: {
                    pluginId: 'happier.agent.fixture',
                    localId: 'fixture-agent',
                },
            },
            existingSessionId: 'session-linked',
            resume: 'remote-fresh',
            approvedNewDirectoryCreation: true,
            backendMode: 'native-mode',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'fixture-agent',
                agent: {
                    providerSessionId: 'remote-fresh',
                    sessionFile: '/agent/sessions/remote-fresh.jsonl',
                },
            },
            environmentVariables: {
                FIXTURE_HOME: '/runtime/fresh',
            },
        });
    });

    it('preserves Pi\'s exact native resume carrier when duplicate provider ids exist', () => {
        const providerSessionId = 'pi-duplicate';
        const selectedSessionFile = '/home/lee/.pi/agent/sessions/workspace-a/pi-duplicate.jsonl';
        const siblingSessionFile = '/home/lee/.pi/agent/sessions/workspace-b/pi-duplicate.jsonl';
        const runtimeDescriptorV1 = {
            v: 1 as const,
            agentId: 'pi',
            agent: {
                resumeStrategy: 'sessionFileAbsolutePreferred',
                providerSessionId,
                sessionFile: selectedSessionFile,
            },
        };

        const options = mapExternalTakeoverLaunchPlanToSpawnOptions({
            plan: {
                directory: '/workspace/pi',
                runtimeDescriptorV1,
            },
            targetDirectory: '/workspace/pi',
            resolvedIdentity: resolvedIdentity({
                remoteSessionId: providerSessionId,
            }),
            linkedSessionId: 'session-linked-pi',
            targetAgent: targetAgent({
                id: 'pi',
                pluginId: 'happier.agent.pi',
                localId: 'pi',
            }),
        });

        expect(options).toMatchObject({
            resume: providerSessionId,
            runtimeDescriptorV1,
        });
        expect(options?.runtimeDescriptorV1).not.toMatchObject({
            agent: { sessionFile: siblingSessionFile },
        });
    });

    it('keeps an arbitrary external Agent as a qualified Agent target', () => {
        expect(mapExternalTakeoverLaunchPlanToSpawnOptions({
            plan: { directory: '/workspace/custom' },
            targetDirectory: '/workspace/custom',
            resolvedIdentity: resolvedIdentity({
                remoteSessionId: 'remote-custom',
            }),
            linkedSessionId: 'session-custom',
            targetAgent: targetAgent({
                id: 'custom-agent',
                pluginId: 'acme.agent.fixture',
                localId: 'custom-agent',
            }),
        })).toEqual({
            directory: '/workspace/custom',
            agentTarget: {
                kind: 'agent',
                identity: {
                    pluginId: 'acme.agent.fixture',
                    localId: 'custom-agent',
                },
            },
            existingSessionId: 'session-custom',
            resume: 'remote-custom',
            approvedNewDirectoryCreation: true,
        });
    });

    it('rejects the entire plan when any environment key is undeclared by the target Agent process owner', () => {
        expect(mapExternalTakeoverLaunchPlanToSpawnOptions({
            plan: {
                directory: '/workspace',
                environmentVariables: {
                    DECLARED_KEY: 'allowed',
                    UNDECLARED_KEY: 'must-reject-the-plan',
                },
            },
            targetDirectory: '/workspace',
            resolvedIdentity: resolvedIdentity(),
            linkedSessionId: 'session-linked',
            targetAgent: targetAgent({
                declaredEnvironmentKeys: ['DECLARED_KEY'],
            }),
        })).toBeNull();
    });

    it('rejects the entire plan when a declared key is reserved for host session custody', () => {
        expect(mapExternalTakeoverLaunchPlanToSpawnOptions({
            plan: {
                directory: '/workspace',
                environmentVariables: {
                    happier_session_attach_file: '/tmp/attacker-controlled',
                },
            },
            targetDirectory: '/workspace',
            resolvedIdentity: resolvedIdentity(),
            linkedSessionId: 'session-linked',
            targetAgent: targetAgent({
                declaredEnvironmentKeys: ['happier_session_attach_file'],
            }),
        })).toBeNull();
    });
});
