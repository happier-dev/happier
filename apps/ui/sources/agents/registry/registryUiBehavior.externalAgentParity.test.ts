import { afterEach, describe, expect, it } from 'vitest';

import {
    buildSessionHandoffSourceRecoveryResumePatch,
    buildSpawnSessionExtrasFromUiState,
    isAttachedSessionTerminalAvailableForSession,
    resolvePendingDeliveryLabelKeyForSession,
    resolvePendingDeliveryTransientActionForSession,
    resolveSessionGoalActionCapabilityProfile,
    supportsEditableSessionGoals,
} from './registryUiBehavior';
import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
} from './agentUiBehaviorProjection';
import { makeSettings } from './registryUiBehavior.testHelpers';
import type { Session } from '@/sync/domains/state/storageTypes';

const EXTERNAL_AGENT_ID = 'acme.agent';
const MACHINE_ID = 'machine-a';

/**
 * The exact facts the host itself writes and owns: the Agent identity the
 * canonical metadata reader accepts, the machine that owns the render, and the
 * protocol-owned terminal control-serviceability envelope the daemon publishes
 * for whichever Agent runs inside a terminal host.
 */
function sessionFixture(overrides: Readonly<{
    agentId?: string;
    terminal?: Record<string, unknown> | undefined;
    capabilities?: Record<string, unknown> | null;
    active?: boolean;
}> = {}): Session {
    return {
        id: 'session-1',
        active: overrides.active ?? true,
        metadata: {
            machineId: MACHINE_ID,
            path: '',
            host: '',
            runtimeDescriptorV1: { v: 1, agentId: overrides.agentId ?? EXTERNAL_AGENT_ID, agent: {} },
            ...(overrides.terminal === undefined ? {} : { terminal: overrides.terminal }),
        },
        agentState: overrides.capabilities === undefined
            ? null
            : { capabilities: overrides.capabilities },
    } as unknown as Session;
}

const SERVABLE_TERMINAL = Object.freeze({
    mode: 'zellij',
    controlServiceabilityV1: {
        v: 1,
        attachmentId: 'attachment-1',
        state: 'servable',
        observedAt: 1,
    },
});

function publishExternalBehavior(behavior: Readonly<Record<string, unknown>>): void {
    publishProjectedAgentUiBehaviorDescriptors({
        machineId: MACHINE_ID,
        descriptorsByAgentId: {
            [EXTERNAL_AGENT_ID]: {
                kind: 'plugin.ui.v1',
                pluginId: 'acme',
                agentId: EXTERNAL_AGENT_ID,
                version: 1,
                behavior,
            },
        },
    });
}

describe('installed external Agent UI parity with a bundled Agent', () => {
    afterEach(() => {
        clearProjectedAgentUiBehaviorDescriptors();
    });

    describe('attached session terminal', () => {
        it('offers attached-terminal control to an external Agent that declares support', () => {
            publishExternalBehavior({ attachedSessionTerminal: { supported: true } });

            expect(isAttachedSessionTerminalAvailableForSession(
                sessionFixture({ terminal: { ...SERVABLE_TERMINAL } }),
            )).toBe(true);
        });

        it('withholds attached-terminal control from an Agent that declares no support', () => {
            publishExternalBehavior({ mcpServers: { supportsDetectedConfigScan: true } });

            expect(isAttachedSessionTerminalAvailableForSession(
                sessionFixture({ terminal: { ...SERVABLE_TERMINAL } }),
            )).toBe(false);
        });

        it.each([
            ['a stopped session', { terminal: { ...SERVABLE_TERMINAL }, active: false }],
            ['a session with no terminal host', { terminal: undefined }],
            ['a plain-mode terminal', {
                terminal: { ...SERVABLE_TERMINAL, mode: 'plain' },
            }],
            ['an unservable attachment', {
                terminal: {
                    ...SERVABLE_TERMINAL,
                    controlServiceabilityV1: {
                        ...SERVABLE_TERMINAL.controlServiceabilityV1,
                        state: 'recoverable_unservable',
                    },
                },
            }],
            ['a retired attachment', {
                terminal: {
                    ...SERVABLE_TERMINAL,
                    controlServiceabilityV1: {
                        ...SERVABLE_TERMINAL.controlServiceabilityV1,
                        retired: true,
                    },
                },
            }],
        ])('still refuses %s even when the Agent declares support', (_name, overrides) => {
            publishExternalBehavior({ attachedSessionTerminal: { supported: true } });

            expect(isAttachedSessionTerminalAvailableForSession(sessionFixture(overrides))).toBe(false);
        });

        it('keeps the bundled Claude Agent attachable through the same host predicate', () => {
            expect(isAttachedSessionTerminalAvailableForSession(
                sessionFixture({ agentId: 'claude', terminal: { ...SERVABLE_TERMINAL } }),
            )).toBe(true);
        });
    });

    describe('pending delivery custody', () => {
        it('labels custody-observed delivery for an external Agent that declares a label', () => {
            publishExternalBehavior({
                pendingDelivery: { custodyLabelKey: 'session.pendingMessages.deliveryStatus.queuedInClaude' },
            });

            expect(resolvePendingDeliveryLabelKeyForSession({
                session: sessionFixture({ capabilities: null }),
                localId: 'local-1',
                detail: 'custody_observed',
            })).toBe('session.pendingMessages.deliveryStatus.queuedInClaude');
        });

        it('labels the custody-observed local id an external Agent published through the public SDK', () => {
            publishExternalBehavior({
                pendingDelivery: { custodyLabelKey: 'session.pendingMessages.deliveryStatus.queuedInClaude' },
            });

            expect(resolvePendingDeliveryLabelKeyForSession({
                session: sessionFixture({
                    capabilities: { pendingInputInterruptAndRunLocalId: 'local-1' },
                }),
                localId: 'local-1',
                detail: undefined,
            })).toBe('session.pendingMessages.deliveryStatus.queuedInClaude');
        });

        it('offers interrupt-and-run to an external Agent that declares it', () => {
            publishExternalBehavior({ pendingDelivery: { interruptAndRun: true } });

            expect(resolvePendingDeliveryTransientActionForSession({
                session: sessionFixture({
                    capabilities: {
                        pendingInputInterruptAndRunLocalId: 'local-1',
                        pendingInputInterruptAndRunStateAt: 1234,
                    },
                }),
                localId: 'local-1',
                wireMode: 'pending_input_v1',
            })).toEqual({ id: 'interrupt_and_run', localId: 'local-1', stateAtMs: 1234 });
        });

        it('withholds interrupt-and-run from an Agent that declares none', () => {
            publishExternalBehavior({ mcpServers: { supportsDetectedConfigScan: true } });

            expect(resolvePendingDeliveryTransientActionForSession({
                session: sessionFixture({
                    capabilities: { pendingInputInterruptAndRunLocalId: 'local-1' },
                }),
                localId: 'local-1',
                wireMode: 'pending_input_v1',
            })).toBeNull();
        });
    });
});

/**
 * Two machines in one Account can hold different versions of the same Agent,
 * so its descriptor is a per-machine fact. These cases publish two machines
 * that disagree and assert that a decision owned by one machine reads that
 * machine's declaration — never the other machine's, and never a machine
 * picked by id ordering.
 */
describe('machine-owned decisions read the owning machine\'s declaration', () => {
    const FIRST_MACHINE_ID = 'machine-a';
    const SECOND_MACHINE_ID = 'machine-b';

    afterEach(() => {
        clearProjectedAgentUiBehaviorDescriptors();
    });

    function publishBehaviorForMachine(
        machineId: string,
        behavior: Readonly<Record<string, unknown>>,
    ): void {
        publishProjectedAgentUiBehaviorDescriptors({
            machineId,
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme',
                    agentId: EXTERNAL_AGENT_ID,
                    version: 1,
                    behavior,
                },
            },
        });
    }

    const EDITABLE_GOALS_BEHAVIOR = Object.freeze({
        workState: {
            editableGoals: {
                providerId: EXTERNAL_AGENT_ID,
                capabilityDriven: true,
                persistedGoalSnapshot: {
                    path: ['workStateSnapshotV1'],
                    itemKind: 'goal',
                    providerFields: ['sourceId'],
                },
            },
        },
    });

    const HANDOFF_ENVIRONMENT_BEHAVIOR = Object.freeze({
        payload: {
            environmentVariables: {
                providerId: EXTERNAL_AGENT_ID,
                backendMode: {
                    envKey: 'HAPPIER_ACME_BACKEND_MODE',
                    settingKey: 'acmeBackendMode',
                    legacyMetadataKey: 'acmeBackendMode',
                    runtimeDescriptorField: 'backendMode',
                    defaultValue: 'acp',
                    values: ['acp', 'server'],
                },
            },
        },
    });

    function goalEditableSessionOnMachine(machineId: string): Session {
        return {
            id: 'session-1',
            active: true,
            metadata: {
                machineId,
                path: '',
                host: '',
                runtimeDescriptorV1: { v: 1, agentId: EXTERNAL_AGENT_ID, agent: {} },
            },
            agentState: { capabilities: { sessionGoalSetSupported: true } },
        } as unknown as Session;
    }

    it('grants editable goals to the machine whose Agent declares them', () => {
        // The declaring machine sorts AFTER the silent one, so an id-ordered
        // pick answers with the silent machine's (absent) declaration.
        publishBehaviorForMachine(FIRST_MACHINE_ID, { mcpServers: { supportsDetectedConfigScan: true } });
        publishBehaviorForMachine(SECOND_MACHINE_ID, EDITABLE_GOALS_BEHAVIOR);

        expect(supportsEditableSessionGoals({
            agentId: EXTERNAL_AGENT_ID,
            session: goalEditableSessionOnMachine(SECOND_MACHINE_ID),
        })).toBe(true);
        expect(resolveSessionGoalActionCapabilityProfile({
            agentId: EXTERNAL_AGENT_ID,
            session: goalEditableSessionOnMachine(SECOND_MACHINE_ID),
        })).toEqual({ canEdit: true, canStop: false, canClear: false, canConfigureBudget: false });
    });

    it('withholds editable goals from a machine whose Agent declares none', () => {
        publishBehaviorForMachine(FIRST_MACHINE_ID, { mcpServers: { supportsDetectedConfigScan: true } });
        publishBehaviorForMachine(SECOND_MACHINE_ID, EDITABLE_GOALS_BEHAVIOR);

        expect(supportsEditableSessionGoals({
            agentId: EXTERNAL_AGENT_ID,
            session: goalEditableSessionOnMachine(FIRST_MACHINE_ID),
        })).toBe(false);
        expect(resolveSessionGoalActionCapabilityProfile({
            agentId: EXTERNAL_AGENT_ID,
            session: goalEditableSessionOnMachine(FIRST_MACHINE_ID),
        })).toBeNull();
    });

    it('spawns on the selected machine with that machine\'s declared session options', () => {
        publishBehaviorForMachine(FIRST_MACHINE_ID, { mcpServers: { supportsDetectedConfigScan: true } });
        publishBehaviorForMachine(SECOND_MACHINE_ID, {
            newSession: {
                agentOptions: [{ key: 'allowIndexing', kind: 'boolean', spawnConfigOption: true }],
            },
        });

        expect(buildSpawnSessionExtrasFromUiState({
            agentId: EXTERNAL_AGENT_ID,
            settings: makeSettings({}),
            resumeSessionId: '',
            machineId: SECOND_MACHINE_ID,
            newSessionOptions: { allowIndexing: true },
            updatedAt: 4242,
        })).toEqual({
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 4242,
                overrides: { allowIndexing: { value: true, updatedAt: 4242 } },
            },
        });
    });

    it('recovers a stopped source session with the source machine\'s declared environment', () => {
        publishBehaviorForMachine(FIRST_MACHINE_ID, { mcpServers: { supportsDetectedConfigScan: true } });
        publishBehaviorForMachine(SECOND_MACHINE_ID, HANDOFF_ENVIRONMENT_BEHAVIOR);

        expect(buildSessionHandoffSourceRecoveryResumePatch({
            agentId: EXTERNAL_AGENT_ID,
            metadata: { machineId: SECOND_MACHINE_ID, acmeBackendMode: 'server' },
        })).toEqual({ environmentVariables: { HAPPIER_ACME_BACKEND_MODE: 'server' } });
    });
});
