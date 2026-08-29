import { afterEach, describe, expect, it } from 'vitest';

import { PluginAgentUiBehaviorContributionV2Schema } from '@happier-dev/protocol';

import { BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS } from './generatedBundledPluginEntries.uiBehaviorOverrides';

import {
    buildNewSessionOptionsFromUiState,
    buildResumeSessionExtrasFromUiState,
    buildSessionHandoffSourceRecoveryResumePatch,
    buildSpawnSessionExtrasFromUiState,
    getNewSessionAgentInputExtraActionChips,
    isAttachedSessionTerminalAvailableForSession,
    resolveAgentUiBehavior,
    resolvePendingDeliveryLabelKeyForSession,
    resolvePendingDeliveryTransientActionForSession,
    resolveSessionGoalActionCapabilityProfile,
    supportsEditableSessionGoals,
} from './registryUiBehavior';
import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
    readProjectedAgentUiBehaviorDiagnostics,
} from './agentUiBehaviorProjection';
import { makeSettings } from './registryUiBehavior.testHelpers';
import { attachAgentPluginSettings } from './agentUiSettingLookup';
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
            publishExternalBehavior({});

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
            publishExternalBehavior({});

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
                backendMode: {
                    envKey: 'HAPPIER_ACME_BACKEND_MODE',
                    settingKey: { scope: 'account', localId: 'acmeBackendMode' },
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
        publishBehaviorForMachine(FIRST_MACHINE_ID, {});
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
        publishBehaviorForMachine(FIRST_MACHINE_ID, {});
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

    it('normalizes the declared option base from the selected machine, not a borrowed one', () => {
        // The option base feeds the spawn envelope. When it is read machine-blind
        // the composer renders one machine's declared options and normalizes
        // another's, so the values the reader set never reach `session.spawn_new`.
        publishBehaviorForMachine(FIRST_MACHINE_ID, {});
        publishBehaviorForMachine(SECOND_MACHINE_ID, {
            newSession: {
                agentOptions: [{ key: 'allowIndexing', kind: 'boolean', spawnConfigOption: true }],
            },
        });

        expect(buildNewSessionOptionsFromUiState({
            agentId: EXTERNAL_AGENT_ID,
            agentOptionState: { allowIndexing: true },
            machineId: SECOND_MACHINE_ID,
        })).toEqual({ allowIndexing: true });
        expect(buildNewSessionOptionsFromUiState({
            agentId: EXTERNAL_AGENT_ID,
            agentOptionState: { allowIndexing: true },
            machineId: FIRST_MACHINE_ID,
        })).toBeNull();
    });

    it('spawns on the selected machine with that machine\'s declared session options', () => {
        publishBehaviorForMachine(FIRST_MACHINE_ID, {});
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

    const INDEXING_CHIP_BEHAVIOR = Object.freeze({
        components: {
            slots: [
                {
                    id: 'acme-allow-indexing',
                    slot: 'newSession.agentInputExtraActionChips',
                    chip: {
                        kind: 'booleanOption',
                        optionStateKey: 'allowIndexing',
                        iconName: 'magnifying-glass',
                        onLabelKey: 'agentInput.auggieIndexingChip.on',
                        offLabelKey: 'agentInput.auggieIndexingChip.off',
                    },
                },
            ],
        },
    });

    it('offers the composer chips declared by the machine the composer is about to spawn on', () => {
        publishBehaviorForMachine(FIRST_MACHINE_ID, {});
        publishBehaviorForMachine(SECOND_MACHINE_ID, INDEXING_CHIP_BEHAVIOR);

        expect(getNewSessionAgentInputExtraActionChips({
            agentId: EXTERNAL_AGENT_ID,
            agentOptionState: { allowIndexing: false },
            setAgentOptionState: () => {},
            machineId: SECOND_MACHINE_ID,
        })?.map((chip) => chip.key)).toEqual(['acme-allow-indexing']);
    });

    it('withholds composer chips a machine\'s Agent does not declare', () => {
        publishBehaviorForMachine(FIRST_MACHINE_ID, {});
        publishBehaviorForMachine(SECOND_MACHINE_ID, INDEXING_CHIP_BEHAVIOR);

        expect(getNewSessionAgentInputExtraActionChips({
            agentId: EXTERNAL_AGENT_ID,
            agentOptionState: { allowIndexing: false },
            setAgentOptionState: () => {},
            machineId: FIRST_MACHINE_ID,
        })).toBeUndefined();
    });

    it('recovers a stopped source session with the source machine\'s declared environment', () => {
        publishBehaviorForMachine(FIRST_MACHINE_ID, {});
        publishBehaviorForMachine(SECOND_MACHINE_ID, HANDOFF_ENVIRONMENT_BEHAVIOR);

        expect(buildSessionHandoffSourceRecoveryResumePatch({
            agentId: EXTERNAL_AGENT_ID,
            machineId: SECOND_MACHINE_ID,
            metadata: { acmeBackendMode: 'server' },
        })).toEqual({ environmentVariables: { HAPPIER_ACME_BACKEND_MODE: 'server' } });
        // The first machine declares no handoff environment, so asking it must
        // answer with nothing rather than the other machine's declaration.
        expect(buildSessionHandoffSourceRecoveryResumePatch({
            agentId: EXTERNAL_AGENT_ID,
            machineId: FIRST_MACHINE_ID,
            metadata: { acmeBackendMode: 'server' },
        })).toEqual({});
    });
});

/**
 * Conformance between the two halves of one language.
 *
 * `contributes.agents[].ui` is the PUBLIC authoring grammar; this module's
 * descriptor interpreter is its implementation. A grammar that admitted a shape
 * the interpreter refuses would teach external authors a declaration that
 * silently does nothing, and a grammar narrower than the interpreter would
 * remove author capability. This pins both directions on the one declaration
 * that exercises every declarative block.
 */
describe('public Agent UI grammar conformance with the descriptor interpreter', () => {
    afterEach(() => {
        clearProjectedAgentUiBehaviorDescriptors();
    });

    it('interprets a grammar-admitted declaration with no refusal', () => {
        const declaration = PluginAgentUiBehaviorContributionV2Schema.parse({
            behavior: {
                descriptorId: 'acme.uiBehavior.v1',
                permissions: { footer: { usePermissionUpdates: true, stopHandling: 'denyAndAbortRun' } },
                pendingDelivery: { interruptAndRun: true },
                newSession: {
                    transcriptStorageModes: ['persisted', 'direct'],
                    agentOptions: [{ key: 'allowIndexing', kind: 'boolean', spawnConfigOption: true }],
                },
                payload: { spawnSessionExtras: { kind: 'static', value: { acmeMode: 'fast' } } },
                externalSessions: {
                    browse: {
                        order: 4,
                        sourceOptions: [{
                            key: 'acme:archive',
                            labelKey: 'acme.browse.archive',
                            source: { kind: 'acmeArchive' },
                        }],
                    },
                },
            },
            message: {
                metaOverrides: [{
                    id: 'acme.mode',
                    targetKey: 'acmeMode',
                    value: { kind: 'sessionConfigOptionOverride', key: 'acmeMode' },
                }],
            },
            components: {
                slots: [{
                    id: 'acme-allow-indexing',
                    slot: 'newSession.agentInputExtraActionChips',
                    chip: {
                        kind: 'booleanOption',
                        optionStateKey: 'allowIndexing',
                        iconName: 'magnifying-glass',
                        onLabelKey: 'agentInput.auggieIndexingChip.on',
                        offLabelKey: 'agentInput.auggieIndexingChip.off',
                    },
                }, {
                    id: 'acme-subagent-launch',
                    slot: 'sessionSubagents.launchCards',
                    surfaceId: 'subagent-launch',
                }, {
                    id: 'acme-subagent-details',
                    slot: 'sessionSubagents.teammateDetailsTab',
                    surfaceId: 'subagent-details',
                    resourceKind: 'acmeSubagentLauncher',
                    iconName: 'users',
                    tab: {
                        keyPrefix: 'acme-subagent-launcher',
                        titleKey: 'acme.subagents.launch.title',
                    },
                }],
            },
        });

        publishProjectedAgentUiBehaviorDescriptors({
            machineId: MACHINE_ID,
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme',
                    agentId: EXTERNAL_AGENT_ID,
                    version: 1,
                    ...declaration,
                },
            },
        });

        expect(readProjectedAgentUiBehaviorDiagnostics(MACHINE_ID)).toEqual([]);
        // The declaration is not merely accepted: it reaches real behavior.
        expect(getNewSessionAgentInputExtraActionChips({
            agentId: EXTERNAL_AGENT_ID,
            agentOptionState: { allowIndexing: false },
            setAgentOptionState: () => {},
            machineId: MACHINE_ID,
        })?.map((chip) => chip.key)).toEqual(['acme-allow-indexing']);
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: EXTERNAL_AGENT_ID,
            settings: makeSettings({}),
            resumeSessionId: '',
            machineId: MACHINE_ID,
            newSessionOptions: { allowIndexing: true },
            updatedAt: 7,
        }).sessionConfigOptionOverrides?.overrides).toMatchObject({
            allowIndexing: { value: true, updatedAt: 7 },
        });
        const externalBehavior = resolveAgentUiBehavior(EXTERNAL_AGENT_ID, MACHINE_ID);
        const renderedLaunchSurfaces: unknown[] = [];
        expect(externalBehavior.sessionSubagents?.renderLaunchCards?.({
            sessionId: 'session-1',
            scopeId: 'session:session-1',
            session: sessionFixture(),
            subagents: [],
            renderInlineSurface: (surface) => {
                renderedLaunchSurfaces.push(surface);
                return `rendered:${surface.slotId}`;
            },
        })).toEqual(['rendered:acme-subagent-launch']);
        expect(renderedLaunchSurfaces).toEqual([expect.objectContaining({
            pluginId: 'acme',
            agentId: EXTERNAL_AGENT_ID,
            surfaceId: 'subagent-launch',
            sessionId: 'session-1',
        })]);
        expect(renderedLaunchSurfaces[0]).not.toHaveProperty('machineId');
        const detailsTab = externalBehavior.sessionSubagents?.createTeammateLauncherDetailsTab?.({
            session: sessionFixture(),
            teamId: 'team-1',
        });
        expect(detailsTab).toMatchObject({
            kind: 'acmeSubagentLauncher',
            resource: {
                pluginInlineSurface: {
                    pluginId: 'acme',
                    agentId: EXTERNAL_AGENT_ID,
                    surfaceId: 'subagent-details',
                },
            },
        });
        expect(detailsTab?.resource).not.toHaveProperty('pluginInlineSurface.machineId');
    });
});

/**
 * The one public grammar has to accept the language the BUNDLED Agents already
 * write, or an installed Agent cannot reach parity by construction: an author
 * copying a first-party declaration would be refused at their manifest.
 *
 * There are no compiled-component exceptions: bundled and installed Agents
 * use the same host-owned controls and same-plugin inline surfaces.
 */
describe('the public grammar admits every bundled Agent declaration', () => {
    function splitBundledDeclaration(descriptor: Readonly<Record<string, unknown>>) {
        const { components, message, ...behavior } = descriptor;
        return {
            ...(Object.keys(behavior).length > 0 ? { behavior } : {}),
            ...(message ? { message } : {}),
            ...(components
                ? {
                    components: components as Record<string, unknown>,
                }
                : {}),
        };
    }

    it.each(Object.entries(BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS).map(
        ([agentId, entry]) => [agentId, entry?.descriptor ?? {}] as const,
    ))('accepts the %s declaration an external author would have to copy', (_agentId, descriptor) => {
        const parsed = PluginAgentUiBehaviorContributionV2Schema.safeParse(
            splitBundledDeclaration(descriptor),
        );
        expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    });

});

/**
 * The runtime-descriptor half of the public grammar.
 *
 * Every block below used to be filtered through the BUNDLED runtime-descriptor
 * reader roster, so an installed Agent could declare a valid block and watch it
 * return nothing. The canonical `runtimeDescriptorV1` envelope already names
 * the Agent that owns it, so these are read from the declaration's own Agent id
 * instead — the same read a bundled Agent gets.
 */
describe('external Agent runtime-descriptor declarations', () => {
    afterEach(() => {
        clearProjectedAgentUiBehaviorDescriptors();
    });

    const RUNTIME_DESCRIPTOR = Object.freeze({
        v: 1 as const,
        agentId: EXTERNAL_AGENT_ID,
        agent: { backendMode: 'turbo', providerSessionId: 'remote-1', workspaceId: 'ws-9' },
    });

    function publishRuntimeDescriptorBlocks(): void {
        publishExternalBehavior({
            payload: {
                sessionExtras: {
                    outputKey: 'acmeBackendMode',
                    values: ['turbo', 'classic'],
                    settingKey: { scope: 'account', localId: 'acmeBackendMode' },
                    aliases: { fast: 'turbo' },
                    defaultValue: 'classic',
                },
                backendTransport: {
                    backendMode: { values: ['turbo', 'classic'] },
                    runtimeHandleFields: ['backendMode', 'providerSessionId', 'workspaceId'],
                    agentExtra: { owner: 'acme', schemaId: 'acme.runtime', v: 1 },
                },
            },
            workState: {
                editableGoals: {
                    modeValues: ['turbo', 'classic'],
                    activeModeValues: ['turbo'],
                },
            },
            externalSessions: {
                browse: {
                    linkEnsureRequestExtras: {
                        runtimeDescriptorFromCandidate: {
                            backendMode: { values: ['turbo', 'classic'] },
                            sourceFields: ['workspaceId'],
                        },
                    },
                },
            },
        });
    }

    function settingsWithAcmeBackendMode(value: unknown): ReturnType<typeof makeSettings> {
        // Account-scoped Agent settings arrive from the New Session screen via
        // the non-enumerable scoped carrier. A flat host Settings key is not a
        // production-shaped input and must not make this test pass accidentally.
        return attachAgentPluginSettings(makeSettings(), {
            account: { acmeBackendMode: value },
        });
    }

    it('builds spawn extras from the Agent’s own declared account setting', () => {
        publishRuntimeDescriptorBlocks();

        expect(buildSpawnSessionExtrasFromUiState({
            agentId: EXTERNAL_AGENT_ID,
            machineId: MACHINE_ID,
            settings: settingsWithAcmeBackendMode('turbo') as never,
            resumeSessionId: '',
        })).toMatchObject({
            runtimeDescriptorV1: { v: 1, agentId: EXTERNAL_AGENT_ID, agent: { backendMode: 'turbo' } },
        });

        // Unset falls to the declared default; an unreadable value never
        // escapes the declared value set.
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: EXTERNAL_AGENT_ID,
            machineId: MACHINE_ID,
            settings: settingsWithAcmeBackendMode('nonsense') as never,
            resumeSessionId: '',
        })).toMatchObject({
            runtimeDescriptorV1: { v: 1, agentId: EXTERNAL_AGENT_ID, agent: { backendMode: 'classic' } },
        });
    });

    it('reads the resume mode from the Agent’s canonical runtime descriptor', () => {
        publishRuntimeDescriptorBlocks();

        expect(buildResumeSessionExtrasFromUiState({
            agentId: EXTERNAL_AGENT_ID,
            settings: settingsWithAcmeBackendMode('classic') as never,
            session: {
                metadata: { machineId: MACHINE_ID, runtimeDescriptorV1: RUNTIME_DESCRIPTOR },
            } as never,
        })).toEqual({
            runtimeDescriptorV1: { v: 1, agentId: EXTERNAL_AGENT_ID, agent: { backendMode: 'turbo' } },
        });
    });

    it('builds backend transport fields from the declared runtime handle', () => {
        publishRuntimeDescriptorBlocks();

        const fields = resolveAgentUiBehavior(EXTERNAL_AGENT_ID, MACHINE_ID)
            .payload?.buildBackendTransportFields?.({
                agentId: EXTERNAL_AGENT_ID,
                backendTarget: { kind: 'backend', backendId: EXTERNAL_AGENT_ID } as never,
                runtimeDescriptorV1: RUNTIME_DESCRIPTOR as never,
            });

        expect(fields).toEqual({
            runtimeDescriptorV1: {
                v: 1,
                agentId: EXTERNAL_AGENT_ID,
                agent: {
                    backendMode: 'turbo',
                    providerSessionId: 'remote-1',
                    workspaceId: 'ws-9',
                    agentExtra: {
                        owner: 'acme',
                        schemaId: 'acme.runtime',
                        v: 1,
                        runtimeHandle: {
                            backendMode: 'turbo',
                            providerSessionId: 'remote-1',
                            workspaceId: 'ws-9',
                        },
                    },
                },
            },
        });
    });

    it('builds External Sessions link extras from a candidate’s canonical descriptor', () => {
        publishRuntimeDescriptorBlocks();

        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID, MACHINE_ID)
            .externalSessions?.browse?.buildLinkEnsureRequestExtras?.({
                agentId: EXTERNAL_AGENT_ID,
                source: { kind: 'acmeWorkspace' } as never,
                candidate: { details: { runtimeDescriptorV1: RUNTIME_DESCRIPTOR } },
            })).toMatchObject({
            runtimeDescriptorV1: {
                v: 1,
                agentId: EXTERNAL_AGENT_ID,
                agent: { backendMode: 'turbo', providerSessionId: 'remote-1' },
            },
        });
    });

    it('drives mode-based goal editability from the same declared descriptor', () => {
        publishRuntimeDescriptorBlocks();

        expect(supportsEditableSessionGoals({
            agentId: EXTERNAL_AGENT_ID,
            session: {
                active: true,
                metadata: { machineId: MACHINE_ID, runtimeDescriptorV1: RUNTIME_DESCRIPTOR },
                agentState: { capabilities: { sessionGoalSetSupported: true } },
            } as never,
        })).toBe(true);

        // The positive twin: a mode outside `activeModeValues` is not editable,
        // so the read is a real decision rather than a constant.
        expect(supportsEditableSessionGoals({
            agentId: EXTERNAL_AGENT_ID,
            session: {
                active: true,
                metadata: {
                    machineId: MACHINE_ID,
                    runtimeDescriptorV1: {
                        ...RUNTIME_DESCRIPTOR,
                        agent: { ...RUNTIME_DESCRIPTOR.agent, backendMode: 'classic' },
                    },
                },
                agentState: { capabilities: { sessionGoalSetSupported: true } },
            } as never,
        })).toBe(false);
    });

    it('ignores another Agent’s runtime descriptor', () => {
        publishRuntimeDescriptorBlocks();

        expect(buildResumeSessionExtrasFromUiState({
            agentId: EXTERNAL_AGENT_ID,
            settings: makeSettings({}) as never,
            session: {
                metadata: {
                    machineId: MACHINE_ID,
                    runtimeDescriptorV1: { ...RUNTIME_DESCRIPTOR, agentId: 'other.agent' },
                },
            } as never,
        })).toEqual({
            runtimeDescriptorV1: { v: 1, agentId: EXTERNAL_AGENT_ID, agent: { backendMode: 'classic' } },
        });
    });
});
