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
    provenance?: TargetAgent['provenance'];
    sourceKind?: TargetAgent['source']['kind'];
    declaredEnvironmentKeys?: readonly string[];
}> = {}): TargetAgent {
    return {
        id: params.id ?? 'fixture-agent',
        provenance: params.provenance ?? 'first_party',
        source: { kind: params.sourceKind ?? 'bundled' },
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
            backendTarget: {
                kind: 'backend',
                backendId: 'fixture-agent',
                sourceKind: 'built_in',
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

    it('maps an arbitrary external Agent to the configured backend target without an Agent-id branch', () => {
        expect(mapExternalTakeoverLaunchPlanToSpawnOptions({
            plan: { directory: '/workspace/custom' },
            targetDirectory: '/workspace/custom',
            resolvedIdentity: resolvedIdentity({
                remoteSessionId: 'remote-custom',
            }),
            linkedSessionId: 'session-custom',
            targetAgent: targetAgent({
                id: 'acme.custom-agent',
                provenance: 'external',
                sourceKind: 'package',
            }),
        })).toEqual({
            directory: '/workspace/custom',
            backendTarget: {
                kind: 'backend',
                backendId: 'acme.custom-agent',
                configuredBackendId: 'acme.custom-agent',
                sourceKind: 'configured',
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
