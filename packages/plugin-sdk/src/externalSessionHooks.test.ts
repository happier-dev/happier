import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { PluginInvocationContext } from './invocation.js';
import type { JsonValue } from './identity.js';
import {
    AGENT_EXTERNAL_SESSION_HOOK_LIMITS,
    validateAgentExternalSessionHookMapEventRequest,
    validateAgentExternalSessionHookMapEventResult,
    validateAgentExternalSessionHookResolveInstallationRequest,
    validateAgentExternalSessionHookResolveInstallationResult,
    validateAgentExternalSessionHooksContribution,
    type AgentExternalSessionHookInstallationVariant,
    type AgentExternalSessionHookCustodiedEntryProjection,
    type AgentExternalSessionHookMapEventRequest,
    type AgentExternalSessionHookMapEventResult,
    type AgentExternalSessionHookResolveInstallationRequest,
    type AgentExternalSessionHookResolveInstallationResult,
    type AgentExternalSessionHooksContribution,
} from './sessions/external/index.js';

const encoder = new TextEncoder();
const invocation = {
    signal: new AbortController().signal,
    deadlineAtMs: 1_000,
    maxSerializedBytes: 65_536,
} as const;

function variant(
    overrides: Partial<AgentExternalSessionHookInstallationVariant> = {},
): AgentExternalSessionHookInstallationVariant {
    return {
        variantId: 'session-lifecycle-v1',
        targets: [{
            targetId: 'user-settings',
            format: 'hook_event_json_arrays_v1',
            collectionId: 'hooks',
        }],
        events: [{
            eventId: 'session-start',
            targetId: 'user-settings',
            nativeEventName: 'SessionStart',
            command: {
                kind: 'happier_observation_v1',
                shellDialect: 'posix',
                matcher: 'identity',
                timeoutMs: 500,
            },
        }],
        ...overrides,
    };
}

const resolveRequest = {
    ...invocation,
    installation: {
        installationIdentity: 'installation-1',
        executableIdentity: 'sha256:agent-binary',
        installedVersion: '1.2.3',
        platform: 'darwin',
        architecture: 'arm64',
    },
} as const satisfies AgentExternalSessionHookResolveInstallationRequest;

const custody = {
    variantId: 'session-lifecycle-v1',
    targets: [{
        targetId: 'user-settings',
        absolutePath: '/opt/arbitrary-agent/config/hooks.json',
        entries: [{
            eventId: 'session-start',
            nativeEventName: 'SessionStart',
            entryIndex: 0,
            entry: {
                matcher: 'identity',
                hooks: [{
                    type: 'command',
                    command: 'happier hook event',
                    timeout: 1,
                }],
            },
        }],
    }],
} as const satisfies AgentExternalSessionHookCustodiedEntryProjection;

const resolveResult = {
    ok: true,
    value: {
        kind: 'supported',
        variantId: 'session-lifecycle-v1',
        targets: [{
            targetId: 'user-settings',
            absolutePath: '/opt/arbitrary-agent/config/hooks.json',
        }],
        readiness: { kind: 'ready' },
    },
} as const satisfies AgentExternalSessionHookResolveInstallationResult;

const mapRequest = {
    ...invocation,
    installationIdentity: 'installation-1',
    variantId: 'session-lifecycle-v1',
    eventId: 'session-start',
    observedAtMs: 100,
    nativePayload: {
        arbitraryAgentEnvelope: {
            session: ['native-17', { nested: true }],
        },
    },
} as const satisfies AgentExternalSessionHookMapEventRequest;

const mapResult = {
    ok: true,
    value: {
        kind: 'mapped',
        sourceInput: {
            kind: 'arbitraryAgentSource',
            rootIdentity: 'root-1',
        },
        remoteSessionId: 'native-17',
        linkData: { projectId: 'project-1' },
        createdAtMs: 80,
        facts: [{
            kind: 'turn_phase',
            value: 'idle',
            evidenceClass: 'qualified_hook',
            observedAtMs: 100,
            expiresAtMs: 200,
        }],
    },
} as const satisfies AgentExternalSessionHookMapEventResult;

const hooks: AgentExternalSessionHooksContribution = {
    installationVariants: [variant()],
    resolveInstallation: () => resolveResult,
    mapHookEvent: () => mapResult,
};

function rejected(run: () => unknown): void {
    expect(run).toThrow(/External Session hooks/u);
}

describe('External Session hooks public contract', () => {
    it('publishes one nested contribution with exactly two callbacks', async () => {
        expectTypeOf<keyof AgentExternalSessionHooksContribution>().toEqualTypeOf<
            'installationVariants' | 'resolveInstallation' | 'mapHookEvent'
        >();
        expectTypeOf<AgentExternalSessionHookMapEventRequest['nativePayload']>()
            .toEqualTypeOf<JsonValue>();
        expectTypeOf<Parameters<typeof hooks.resolveInstallation>>()
            .toEqualTypeOf<[
                request: AgentExternalSessionHookResolveInstallationRequest,
                context: PluginInvocationContext,
            ]>();
        expectTypeOf<Parameters<typeof hooks.mapHookEvent>>()
            .toEqualTypeOf<[request: AgentExternalSessionHookMapEventRequest]>();
        expectTypeOf<Awaited<ReturnType<typeof hooks.mapHookEvent>>>()
            .toEqualTypeOf<AgentExternalSessionHookMapEventResult>();

        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as { exports?: Record<string, unknown> };
        expect(packageJson.exports?.['./experimental/sessions']).toBeUndefined();
        expect(packageJson.exports?.['./sessions/external']).toEqual({
            default: './dist/sessions/external/index.js',
            types: './dist/sessions/external/index.d.ts',
        });
    });

    it('normalizes and deeply snapshots variants with captured callbacks', () => {
        const input = {
            ...hooks,
            installationVariants: [{
                ...variant(),
                variantId: '  session-lifecycle-v1  ',
            }],
        };
        const snapshot = validateAgentExternalSessionHooksContribution(input);

        expect(snapshot.installationVariants[0]?.variantId).toBe('session-lifecycle-v1');
        expect(snapshot.resolveInstallation).not.toBe(hooks.resolveInstallation);
        expect(snapshot.mapHookEvent).not.toBe(hooks.mapHookEvent);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.installationVariants)).toBe(true);
        expect(Object.isFrozen(snapshot.installationVariants[0]?.targets)).toBe(true);
        expect(Object.isFrozen(snapshot.installationVariants[0]?.events[0]?.command)).toBe(true);

        (input.installationVariants[0]!.events[0]!.command as { matcher?: string }).matcher =
            'changed';
        expect(snapshot.installationVariants[0]?.events[0]?.command.matcher).toBe('identity');
    });

    it('rejects the retired planConfiguration callback at the strict contribution boundary', () => {
        rejected(() => validateAgentExternalSessionHooksContribution({
            ...hooks,
            planConfiguration: () => ({ ok: true as const, value: {} }),
        } as never));
    });

    it('rejects class, prototype, and accessor-backed contribution DTOs', () => {
        class StructuralHooks {
            readonly ignoredByRegistration = true;
            readonly owner = 'structural-hooks';
            readonly variants = [{
                ...variant(),
                variantId: '  structural-hooks  ',
            }];

            get installationVariants() {
                return this.variants;
            }

            get resolveInstallation() {
                return this.resolveInstallationImplementation;
            }

            resolveInstallationImplementation() {
                return Promise.resolve({
                    ...resolveResult,
                    value: { ...resolveResult.value, owner: this.owner },
                });
            }

            mapHookEvent() {
                return Promise.resolve({
                    ...mapResult,
                    value: { ...mapResult.value, owner: this.owner },
                });
            }
        }
        const contribution = new StructuralHooks();
        rejected(() => validateAgentExternalSessionHooksContribution(
            contribution as unknown as AgentExternalSessionHooksContribution,
        ));
    });

    it('enforces inclusive variant, target, and event count limits', () => {
        const limits = AGENT_EXTERNAL_SESSION_HOOK_LIMITS;
        expect(validateAgentExternalSessionHooksContribution({
            ...hooks,
            installationVariants: Array.from(
                { length: limits.maxInstallationVariants },
                (_, variantIndex) => variant({
                    variantId: `variant-${variantIndex}`,
                    targets: Array.from(
                        { length: limits.maxTargetsPerVariant },
                        (__, targetIndex) => ({
                            targetId: `target-${targetIndex}`,
                            format: 'hook_event_json_arrays_v1',
                            collectionId: `collection-${targetIndex}`,
                        }),
                    ),
                    events: Array.from(
                        { length: limits.maxEventsPerVariant },
                        (__, eventIndex) => ({
                            eventId: `event-${eventIndex}`,
                            targetId: `target-${eventIndex % limits.maxTargetsPerVariant}`,
                            nativeEventName: `Event${eventIndex}`,
                            command: {
                                kind: 'happier_observation_v1',
                                shellDialect: 'posix',
                            },
                        }),
                    ),
                }),
            ),
        }).installationVariants).toHaveLength(limits.maxInstallationVariants);

        for (const installationVariants of [
            [],
            Array.from(
                { length: limits.maxInstallationVariants + 1 },
                (_, index) => variant({ variantId: `variant-${index}` }),
            ),
            [variant({
                targets: Array.from(
                    { length: limits.maxTargetsPerVariant + 1 },
                    (_, index) => ({
                        targetId: `target-${index}`,
                        format: 'hook_event_json_arrays_v1',
                        collectionId: `collection-${index}`,
                    }),
                ),
            })],
            [variant({
                events: Array.from(
                    { length: limits.maxEventsPerVariant + 1 },
                    (_, index) => ({
                        eventId: `event-${index}`,
                        targetId: 'user-settings',
                        nativeEventName: `Event${index}`,
                        command: {
                            kind: 'happier_observation_v1',
                            shellDialect: 'posix',
                        },
                    }),
                ),
            })],
        ]) {
            rejected(() => validateAgentExternalSessionHooksContribution({
                ...hooks,
                installationVariants,
            }));
        }
    });

    it('rejects duplicate ids, dangling references, and the retired recipe shape', () => {
        for (const installationVariants of [
            [variant(), variant({ variantId: ' session-lifecycle-v1 ' })],
            [variant({
                targets: [
                    variant().targets[0]!,
                    {
                        ...variant().targets[0]!,
                        targetId: ' user-settings ',
                        collectionId: 'other',
                    },
                ],
            })],
            [variant({
                events: [{
                    ...variant().events[0]!,
                    targetId: 'missing-target',
                }],
            })],
        ]) {
            rejected(() => validateAgentExternalSessionHooksContribution({
                ...hooks,
                installationVariants,
            }));
        }

        for (const retired of [
            { adapters: [] },
            { recipes: [] },
        ]) {
            rejected(() => validateAgentExternalSessionHooksContribution(retired));
        }
        rejected(() => validateAgentExternalSessionHooksContribution({
            ...hooks,
            installationVariants: [{
                ...variant(),
                adapterId: 'legacy-adapter',
                events: [{
                    ...variant().events[0]!,
                    fields: [{ nativePath: ['session_id'] }],
                }],
            }],
        } as never));

        for (const command of [
            { kind: 'happier_observation_v1' },
            {
                kind: 'happier_observation_v1',
                shellDialect: 'powershell',
            },
        ]) {
            rejected(() => validateAgentExternalSessionHooksContribution({
                ...hooks,
                installationVariants: [{
                    ...variant(),
                    events: [{
                        ...variant().events[0]!,
                        command,
                    }],
                }],
            }));
        }

        // Every dialect the host serializer can actually emit is admissible;
        // the unencoded `powershell` form above stays rejected because no host
        // serializer selects it for a hook entry.
        for (const shellDialect of [
            'posix',
            'windows_cmd',
            'powershell_encoded',
        ] as const) {
            expect(validateAgentExternalSessionHooksContribution({
                ...hooks,
                installationVariants: [{
                    ...variant(),
                    events: [{
                        ...variant().events[0]!,
                        command: {
                            kind: 'happier_observation_v1',
                            shellDialect,
                        },
                    }],
                }],
            }).installationVariants[0]!.events[0]!.command.shellDialect)
                .toBe(shellDialect);
        }
    });

    it('admits plugin-resolved absolute targets and exact declared target sets', () => {
        const pathAtMax = `/${'a'.repeat(
            AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxTargetPathUtf8Bytes - 1,
        )}`;
        expect(encoder.encode(pathAtMax)).toHaveLength(
            AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxTargetPathUtf8Bytes,
        );
        expect(validateAgentExternalSessionHookResolveInstallationResult({
            ...resolveResult,
            value: {
                ...resolveResult.value,
                targets: [{
                    targetId: 'user-settings',
                    absolutePath: pathAtMax,
                }],
            },
        }, variant())).toEqual({
            ...resolveResult,
            value: {
                ...resolveResult.value,
                targets: [{
                    targetId: 'user-settings',
                    absolutePath: pathAtMax,
                }],
            },
        });
        expect(validateAgentExternalSessionHookResolveInstallationResult({
            ...resolveResult,
            value: {
                ...resolveResult.value,
                targets: [{
                    targetId: 'user-settings',
                    absolutePath: 'Q:\\agent-owned\\settings.json',
                }],
            },
        }, variant()).ok).toBe(true);

        const twoTargets = variant({
            targets: [
                variant().targets[0]!,
                {
                    targetId: 'workspace-settings',
                    format: 'hook_event_json_arrays_v1',
                    collectionId: 'workspace-hooks',
                },
            ],
        });
        for (const targets of [
            [],
            [{ targetId: 'user-settings', absolutePath: 'relative/settings.json' }],
            [{ targetId: 'user-settings', absolutePath: `${pathAtMax}x` }],
            resolveResult.value.targets,
            [
                { targetId: 'user-settings', absolutePath: '/same/settings.json' },
                { targetId: 'workspace-settings', absolutePath: '/same/settings.json' },
            ],
        ]) {
            rejected(() => validateAgentExternalSessionHookResolveInstallationResult({
                ...resolveResult,
                value: { ...resolveResult.value, targets },
            }, twoTargets));
        }
    });

    it('strictly validates resolve requests and generic readiness diagnostics', () => {
        expect(validateAgentExternalSessionHookResolveInstallationRequest(resolveRequest))
            .toEqual(resolveRequest);
        expect(validateAgentExternalSessionHookResolveInstallationResult(
            resolveResult,
            variant(),
        )).toEqual(resolveResult);
        expect(validateAgentExternalSessionHookResolveInstallationResult({
            ...resolveResult,
            value: {
                ...resolveResult.value,
                readiness: {
                    kind: 'needs_attention',
                    diagnostic: {
                        code: 'agent.trust_required',
                        severity: 'warning',
                        message: 'Review the Agent installation.',
                        remediation: { kind: 'openSettings', path: '/settings/agents' },
                    },
                },
            },
        }, variant()).ok).toBe(true);
        expect(validateAgentExternalSessionHookResolveInstallationResult({
            ok: true,
            value: {
                kind: 'unsupported',
                reason: 'version_unsupported',
            },
        })).toEqual({
            ok: true,
            value: {
                kind: 'unsupported',
                reason: 'version_unsupported',
            },
        });

        rejected(() => validateAgentExternalSessionHookResolveInstallationResult({
            ...resolveResult,
            value: {
                ...resolveResult.value,
                readiness: {
                    kind: 'needs_attention',
                    diagnostic: {
                        code: 'agent.trust_required',
                        severity: 'warning',
                        agentId: 'codex',
                    },
                },
            },
        }, variant()));
        rejected(() => validateAgentExternalSessionHookResolveInstallationResult({
            ...resolveResult,
            value: {
                ...resolveResult.value,
                readiness: {
                    kind: 'needs_attention',
                    diagnostic: {
                        code: 'agent.trust_required',
                        severity: 'warning',
                        remediation: {
                            kind: 'openSettings',
                            path: '/settings/agents',
                            url: 'https://invalid.example',
                        },
                    },
                },
            },
        }, variant()));
    });

    it('admits only exact bounded host-derived custody and deeply snapshots owned entries', () => {
        const input = {
            ...resolveRequest,
            custody,
        };
        const snapshot = validateAgentExternalSessionHookResolveInstallationRequest(input);

        expect(snapshot).toEqual(input);
        expect(Object.isFrozen(snapshot.custody)).toBe(true);
        expect(Object.isFrozen(snapshot.custody?.targets)).toBe(true);
        expect(Object.isFrozen(snapshot.custody?.targets[0]?.entries)).toBe(true);
        expect(Object.isFrozen(snapshot.custody?.targets[0]?.entries[0])).toBe(true);
        expect(snapshot.custody?.targets[0]?.entries[0]?.entryIndex).toBe(0);
        expect(Object.isFrozen(snapshot.custody?.targets[0]?.entries[0]?.entry)).toBe(true);
        expect(Object.isFrozen(
            snapshot.custody?.targets[0]?.entries[0]?.entry.hooks,
        )).toBe(true);
        expect(validateAgentExternalSessionHookResolveInstallationRequest({
            ...resolveRequest,
            custody: {
                ...custody,
                targets: [{
                    ...custody.targets[0],
                    entries: [{
                        ...custody.targets[0].entries[0],
                        entryIndex: Number.MAX_SAFE_INTEGER,
                    }],
                }],
            },
        }).custody?.targets[0]?.entries[0]?.entryIndex)
            .toBe(Number.MAX_SAFE_INTEGER);

        for (const overBroadCustody of [
            { ...custody, state: 'active' },
            { ...custody, revision: 4 },
            { ...custody, principal: { id: 'principal-1' } },
            { ...custody, secret: 'secret' },
            { ...custody, configuration: { hooks: {} } },
            { ...custody, foreignEntries: [] },
            {
                ...custody,
                targets: [{
                    ...custody.targets[0],
                    inputIdentity: 'sha256:configuration',
                }],
            },
            {
                ...custody,
                targets: [{
                    ...custody.targets[0],
                    entries: [{
                        ...custody.targets[0].entries[0],
                        inputIdentity: 'sha256:configuration',
                    }],
                }],
            },
            {
                ...custody,
                targets: [{
                    ...custody.targets[0],
                    entries: [{
                        ...custody.targets[0].entries[0],
                        identicalEntriesBefore: 0,
                    }],
                }],
            },
            {
                ...custody,
                targets: [{
                    ...custody.targets[0],
                    entries: [{
                        ...custody.targets[0].entries[0],
                        occurrenceCount: 1,
                    }],
                }],
            },
            {
                ...custody,
                targets: [{
                    ...custody.targets[0],
                    entries: [{
                        ...custody.targets[0].entries[0],
                        displayOrder: 0,
                    }],
                }],
            },
            {
                ...custody,
                targets: [{
                    ...custody.targets[0],
                    entries: [{
                        ...custody.targets[0].entries[0],
                        entry: {
                            ...custody.targets[0].entries[0].entry,
                            token: 'secret',
                        },
                    }],
                }],
            },
        ]) {
            rejected(() => validateAgentExternalSessionHookResolveInstallationRequest({
                ...resolveRequest,
                custody: overBroadCustody,
            }));
        }
    });

    it('enforces custody target, total-entry, identity, path, and JSON limits', () => {
        const limits = AGENT_EXTERNAL_SESSION_HOOK_LIMITS;
        const targets = Array.from(
            { length: limits.maxTargetsPerVariant },
            (_, targetIndex) => ({
                targetId: `target-${targetIndex}`,
                absolutePath: `/config/target-${targetIndex}.json`,
                entries: Array.from(
                    {
                        length:
                            limits.maxEventsPerVariant / limits.maxTargetsPerVariant,
                    },
                    (__, entryIndex) => ({
                        eventId: `event-${targetIndex}-${entryIndex}`,
                        nativeEventName: `Event${entryIndex}`,
                        entryIndex,
                        entry: {
                            matcher: null,
                            hooks: [{
                                type: 'command' as const,
                                command: `happier hook ${targetIndex} ${entryIndex}`,
                                timeout: 1,
                            }] as const,
                        },
                    }),
                ),
            }),
        );
        expect(validateAgentExternalSessionHookResolveInstallationRequest({
            ...resolveRequest,
            custody: {
                variantId: 'session-lifecycle-v1',
                targets,
            },
        }).custody?.targets.flatMap((target) => target.entries))
            .toHaveLength(limits.maxEventsPerVariant);

        for (const invalidCustody of [
            {
                ...custody,
                targets: [],
            },
            {
                ...custody,
                targets: Array.from(
                    { length: limits.maxTargetsPerVariant + 1 },
                    (_, index) => ({
                        ...custody.targets[0],
                        targetId: `target-${index}`,
                        absolutePath: `/config/target-${index}.json`,
                    }),
                ),
            },
            {
                ...custody,
                targets: [{
                    ...custody.targets[0],
                    entries: [{
                        eventId: custody.targets[0].entries[0].eventId,
                        nativeEventName:
                            custody.targets[0].entries[0].nativeEventName,
                        entry: custody.targets[0].entries[0].entry,
                    }],
                }],
            },
            {
                ...custody,
                targets: [{
                    ...custody.targets[0],
                    entries: [{
                        ...custody.targets[0].entries[0],
                        entryIndex: -1,
                    }],
                }],
            },
            {
                ...custody,
                targets: [{
                    ...custody.targets[0],
                    entries: [{
                        ...custody.targets[0].entries[0],
                        entryIndex: 0.5,
                    }],
                }],
            },
            {
                ...custody,
                targets: [{
                    ...custody.targets[0],
                    entries: [{
                        ...custody.targets[0].entries[0],
                        entryIndex: Number.MAX_SAFE_INTEGER + 1,
                    }],
                }],
            },
            {
                ...custody,
                targets: [{
                    ...custody.targets[0],
                    entries: Array.from(
                        { length: limits.maxEventsPerVariant + 1 },
                        (_, index) => ({
                            ...custody.targets[0].entries[0],
                            eventId: `event-${index}`,
                        }),
                    ),
                }],
            },
            {
                ...custody,
                targets: [
                    custody.targets[0],
                    {
                        ...custody.targets[0],
                        targetId: ` ${custody.targets[0].targetId} `,
                        absolutePath: '/config/other.json',
                    },
                ],
            },
            {
                ...custody,
                targets: [
                    custody.targets[0],
                    {
                        ...custody.targets[0],
                        targetId: 'other-target',
                    },
                ],
            },
            {
                ...custody,
                targets: [{
                    ...custody.targets[0],
                    entries: [
                        custody.targets[0].entries[0],
                        {
                            ...custody.targets[0].entries[0],
                            nativeEventName: 'OtherEvent',
                        },
                    ],
                }],
            },
        ]) {
            rejected(() => validateAgentExternalSessionHookResolveInstallationRequest({
                ...resolveRequest,
                custody: invalidCustody,
            }));
        }
    });

    it('passes arbitrary bounded native JSON and rejects unrelated request fields', () => {
        expect(validateAgentExternalSessionHookMapEventRequest(mapRequest)).toEqual(mapRequest);
        rejected(() => validateAgentExternalSessionHookMapEventRequest({
            ...mapRequest,
            fields: [{ fieldId: 'session-id', value: 'native-17' }],
        }));

        const nestedPayload = (depth: number): unknown => {
            let payload: unknown = true;
            for (let index = 0; index < depth; index += 1) {
                payload = { nested: payload };
            }
            return payload;
        };
        expect(validateAgentExternalSessionHookMapEventRequest({
            ...mapRequest,
            nativePayload: nestedPayload(AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxJsonDepth),
        }).nativePayload).toEqual(
            nestedPayload(AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxJsonDepth),
        );
        rejected(() => validateAgentExternalSessionHookMapEventRequest({
            ...mapRequest,
            nativePayload: nestedPayload(AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxJsonDepth + 1),
        }));
        const atNodeLimit = Object.fromEntries(
            Array.from(
                { length: AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxJsonNodes },
                (_, index) => [`k${index}`, index],
            ),
        );
        expect(validateAgentExternalSessionHookMapEventRequest({
            ...mapRequest,
            nativePayload: atNodeLimit,
        }).nativePayload).toEqual(atNodeLimit);
        rejected(() => validateAgentExternalSessionHookMapEventRequest({
            ...mapRequest,
            nativePayload: Object.fromEntries(
                Array.from(
                    { length: AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxJsonNodes + 1 },
                    (_, index) => [`k${index}`, index],
                ),
            ),
        }));

        expect(validateAgentExternalSessionHookMapEventRequest({
            ...mapRequest,
            nativePayload: '\uD800',
        }).nativePayload).toBe('\uD800');

        class ExtendedArray extends Array<unknown> {}
        const accessorPayload = {} as Record<string, unknown>;
        Object.defineProperty(accessorPayload, 'value', {
            enumerable: true,
            get: () => 'must-not-run',
        });
        const cyclicPayload = { nested: null as unknown };
        cyclicPayload.nested = cyclicPayload;
        for (const nativePayload of [
            new ExtendedArray('value'),
            accessorPayload,
            Object.defineProperty({}, Symbol('hidden'), { enumerable: true, value: true }),
            cyclicPayload,
        ]) {
            rejected(() => validateAgentExternalSessionHookMapEventRequest({
                ...mapRequest,
                nativePayload,
            }));
        }
    });

    it('validates mapped identity/facts and normalizes remoteSessionId', () => {
        const qualifiedFactVariants = [
            {
                kind: 'liveness',
                value: 'running',
                evidenceClass: 'qualified_hook',
                observedAtMs: 100,
                expiresAtMs: 100,
            },
            {
                kind: 'turn_phase',
                value: 'idle',
                evidenceClass: 'qualified_hook',
                observedAtMs: 100,
                expiresAtMs: 100,
            },
            {
                kind: 'recent_activity',
                evidenceClass: 'qualified_hook',
                observedAtMs: 100,
                expiresAtMs: 100,
            },
            {
                kind: 'completed_boundary',
                boundaryId: 'boundary-1',
                evidenceClass: 'qualified_hook',
                observedAtMs: 100,
            },
            {
                kind: 'successful_empty',
                emptyTurnPhase: 'idle',
                evidenceClass: 'qualified_hook',
                observedAtMs: 100,
                expiresAtMs: 100,
            },
            {
                kind: 'retrieval_failed',
                axis: 'liveness',
                evidenceClass: 'qualified_hook',
                observedAtMs: 100,
            },
            {
                kind: 'unsupported',
                axis: 'turn_phase',
                evidenceClass: 'qualified_hook',
                observedAtMs: 100,
            },
        ] as const;
        expect(validateAgentExternalSessionHookMapEventResult({
            ok: true,
            value: { kind: 'ignored' },
        })).toEqual({
            ok: true,
            value: { kind: 'ignored' },
        });
        expect(validateAgentExternalSessionHookMapEventResult({
            ...mapResult,
            value: {
                ...mapResult.value,
                remoteSessionId: '  native-17  ',
                facts: [],
            },
        })).toEqual({
            ...mapResult,
            value: {
                ...mapResult.value,
                remoteSessionId: 'native-17',
                facts: [],
            },
        });
        const qualifiedResult = validateAgentExternalSessionHookMapEventResult({
            ...mapResult,
            value: {
                ...mapResult.value,
                facts: qualifiedFactVariants,
            },
        });
        expect(qualifiedResult.ok).toBe(true);
        if (!qualifiedResult.ok) throw new Error('Expected a successful qualified hook result');
        expect(qualifiedResult.value).toEqual({
            ...mapResult.value,
            facts: qualifiedFactVariants,
        });
        rejected(() => validateAgentExternalSessionHookMapEventResult({
            ...mapResult,
            value: {
                ...mapResult.value,
                facts: Array.from(
                    { length: AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxMappedFacts + 1 },
                    (_, index) => ({
                        kind: 'completed_boundary',
                        boundaryId: `boundary-${index}`,
                        evidenceClass: 'qualified_hook',
                        observedAtMs: 100,
                    }),
                ),
            },
        }));
        rejected(() => validateAgentExternalSessionHookMapEventResult({
            ...mapResult,
            value: {
                ...mapResult.value,
                sourceInput: { rootIdentity: 'root-1' },
            },
        }));
        rejected(() => validateAgentExternalSessionHookMapEventResult({
            ...mapResult,
            value: {
                ...mapResult.value,
                facts: [{
                    ...mapResult.value.facts[0],
                    unexpected: true,
                }],
            },
        }));
        rejected(() => validateAgentExternalSessionHookMapEventResult({
            ...mapResult,
            value: {
                ...mapResult.value,
                facts: [{
                    ...mapResult.value.facts[0],
                    evidenceClass: 'agent_native',
                }],
            },
        }));
        let tooDeep: Record<string, unknown> = { leaf: true };
        for (let depth = 0; depth <= AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxJsonDepth; depth += 1) {
            tooDeep = { nested: tooDeep };
        }
        rejected(() => validateAgentExternalSessionHookMapEventResult({
            ...mapResult,
            value: {
                ...mapResult.value,
                linkData: tooDeep,
            },
        }));
        rejected(() => validateAgentExternalSessionHookMapEventResult({
            ...mapResult,
            value: {
                ...mapResult.value,
                sourceInput: Object.fromEntries([
                    ['kind', 'source'],
                    ...Array.from(
                        { length: AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxJsonNodes + 1 },
                        (_, index) => [`k${index}`, index] as const,
                    ),
                ]),
            },
        }));
    });

    it('publishes resolve management policy and only the one total hook deadline', () => {
        expect(AGENT_EXTERNAL_SESSION_HOOK_LIMITS.totalHookDeadlineMs).toBe(500);
        expect(AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks.resolveInstallation.deadlineMs)
            .toBe(15_000);
        expect(AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks.mapHookEvent)
            .not.toHaveProperty('deadlineMs');
        expect(AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks)
            .not.toHaveProperty('planConfiguration');
    });

    it('rejects unrelated request/result fields and enforces callback ceilings', () => {
        rejected(() => validateAgentExternalSessionHookResolveInstallationRequest({
            ...resolveRequest,
            environment: { HOME: '/private' },
        }));
        rejected(() => validateAgentExternalSessionHookMapEventRequest({
            ...mapRequest,
            maxSerializedBytes:
                AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks.mapHookEvent
                    .maxEnvelopeUtf8Bytes + 1,
        }));
        rejected(() => validateAgentExternalSessionHookMapEventResult({
            ...mapResult,
            value: {
                ...mapResult.value,
                targetSessionId: 'happier-session',
            },
        }));
    });
});
