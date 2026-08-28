import { describe, expect, expectTypeOf, it } from 'vitest';

import {
    AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS,
    validateAgentExternalSessionTakeoverContribution,
    validateAgentExternalSessionTakeoverLaunchPlan,
    validateAgentExternalSessionTakeoverResolveLaunchRequest,
    validateAgentExternalSessionTakeoverResolveLaunchResult,
    type AgentExternalSessionTakeoverContribution,
    type AgentExternalSessionTakeoverLaunchPlan,
    type AgentExternalSessionTakeoverResolveLaunchCallback,
    type AgentExternalSessionTakeoverResolveLaunchRequest,
    type AgentExternalSessionTakeoverResolveLaunchResult,
} from './external/index.js';

const invocation = {
    signal: new AbortController().signal,
    deadlineAtMs: 10_000,
    maxSerializedBytes: 262_144,
} as const;

const request = {
    ...invocation,
    linkedSessionId: 'happier-session-1',
    source: {
        kind: 'arbitraryAgentSource',
        rootIdentity: 'root-1',
    },
    remoteSessionId: 'native-session-1',
    linkData: {
        nativeIdentity: 'native-session-1',
    },
    targetDirectory: '/local/selected/project',
    linkedDirectory: '/work/project',
} as const satisfies AgentExternalSessionTakeoverResolveLaunchRequest;

const plan = {
    directory: '/work/project',
    backendModeHint: 'resume',
    environmentVariables: {
        AGENT_PROFILE: 'profile-1',
    },
} as const satisfies AgentExternalSessionTakeoverLaunchPlan;

const runtimeDescriptorV1 = {
    v: 1,
    agentId: 'fixture.agent',
    agent: {
        providerSessionId: 'native-session-1',
        sessionFile: '/agent/sessions/native-session-1.jsonl',
    },
} as const;

const result = {
    ok: true,
    value: plan,
} as const satisfies AgentExternalSessionTakeoverResolveLaunchResult;

const resolveLaunch: AgentExternalSessionTakeoverResolveLaunchCallback =
    async () => result;

function rejects(run: () => unknown): void {
    expect(run).toThrow(/External Session takeover/u);
}

describe('External Session takeover public contract', () => {
    it('publishes exactly one request-only callback and ignores unrelated members', async () => {
        expectTypeOf<keyof AgentExternalSessionTakeoverContribution>()
            .toEqualTypeOf<'resolveLaunch'>();
        expectTypeOf<Parameters<AgentExternalSessionTakeoverResolveLaunchCallback>>()
            .toEqualTypeOf<[
                request: AgentExternalSessionTakeoverResolveLaunchRequest,
            ]>();
        expectTypeOf<Awaited<ReturnType<AgentExternalSessionTakeoverResolveLaunchCallback>>>()
            .toEqualTypeOf<AgentExternalSessionTakeoverResolveLaunchResult>();

        const contribution = validateAgentExternalSessionTakeoverContribution({
            resolveLaunch,
        });
        expect(Object.keys(contribution)).toEqual(['resolveLaunch']);
        await expect(contribution.resolveLaunch(request)).resolves.toEqual(result);

        const withRetiredOperation = validateAgentExternalSessionTakeoverContribution({
            resolveLaunch,
            resolveStop: () => result,
        });
        expect(Object.keys(withRetiredOperation)).toEqual(['resolveLaunch']);
    });

    it('captures class, prototype, and accessor-backed callbacks with the author receiver', async () => {
        class StructuralTakeover {
            readonly ignoredByRegistration = true;
            readonly owner = 'structural-takeover';

            get resolveLaunch() {
                return this.resolveLaunchImplementation;
            }

            resolveLaunchImplementation() {
                return Promise.resolve({
                    ...result,
                    value: { ...result.value, owner: this.owner },
                });
            }
        }
        const contribution = new StructuralTakeover();
        const snapshot = validateAgentExternalSessionTakeoverContribution(
            contribution as unknown as AgentExternalSessionTakeoverContribution,
        );

        expect(snapshot).not.toBe(contribution);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(snapshot).not.toHaveProperty('ignoredByRegistration');
        await expect(Reflect.apply(snapshot.resolveLaunch, { owner: 'foreign' }, [request]))
            .resolves.toMatchObject({ value: { owner: 'structural-takeover' } });
    });

    it('rejects inherited and accessor-backed DTO fields without reading accessors', () => {
        let accessorReads = 0;
        class StructuralRequest {
            readonly signal = request.signal;
            readonly deadlineAtMs = request.deadlineAtMs;
            readonly maxSerializedBytes = request.maxSerializedBytes;
            readonly linkedSessionId = request.linkedSessionId;
            readonly source = request.source;
            readonly remoteSessionId = request.remoteSessionId;
            readonly linkData = request.linkData;
            readonly targetDirectory = request.targetDirectory;
        }
        rejects(() => validateAgentExternalSessionTakeoverResolveLaunchRequest(
            new StructuralRequest(),
        ));

        const accessorResult = { ok: true } as Record<string, unknown>;
        Object.defineProperty(accessorResult, 'value', {
            enumerable: true,
            get() {
                accessorReads += 1;
                return plan;
            },
        });
        rejects(() => validateAgentExternalSessionTakeoverResolveLaunchResult(
            accessorResult,
        ));
        expect(accessorReads).toBe(0);

        const nonEnumerableResult = { ok: true } as Record<string, unknown>;
        Object.defineProperty(nonEnumerableResult, 'value', {
            enumerable: false,
            value: plan,
        });
        rejects(() => validateAgentExternalSessionTakeoverResolveLaunchResult(
            nonEnumerableResult,
        ));

        expect(validateAgentExternalSessionTakeoverResolveLaunchResult(
            Object.assign(Object.create(null), result),
        )).toEqual(result);
    });

    it('strictly snapshots the bounded fresh linked-identity request', () => {
        expect(validateAgentExternalSessionTakeoverResolveLaunchRequest(request))
            .toEqual(request);

        for (const invalidRequest of [
            { ...request, linkedSessionId: '' },
            { ...request, linkedSessionId: 's'.repeat(2_001) },
            { ...request, remoteSessionId: '' },
            { ...request, remoteSessionId: 'r'.repeat(2_001) },
            { ...request, targetDirectory: '' },
            { ...request, targetDirectory: 'd'.repeat(10_001) },
            { ...request, linkedDirectory: '' },
            { ...request, linkedDirectory: 'd'.repeat(10_001) },
            { ...request, source: { kind: '', rootIdentity: 'root-1' } },
            { ...request, linkData: [] },
            { ...request, targetSessionId: 'plugin-chosen-target' },
            { ...request, transcriptMode: 'hosted' },
            { ...request, services: {} },
        ]) {
            rejects(() =>
                validateAgentExternalSessionTakeoverResolveLaunchRequest(invalidRequest),
            );
        }

        expect(validateAgentExternalSessionTakeoverResolveLaunchRequest({
            ...request,
            linkedSessionId: 's'.repeat(2_000),
            remoteSessionId: 'r'.repeat(2_000),
            targetDirectory: 'd'.repeat(10_000),
            linkedDirectory: 'd'.repeat(10_000),
        })).toMatchObject({
            linkedSessionId: 's'.repeat(2_000),
            remoteSessionId: 'r'.repeat(2_000),
            targetDirectory: 'd'.repeat(10_000),
            linkedDirectory: 'd'.repeat(10_000),
        });
    });

    it('accepts only the exact bounded launch-plan fields', () => {
        expect(validateAgentExternalSessionTakeoverLaunchPlan(plan)).toEqual(plan);
        const planWithRuntimeDescriptor = {
            ...plan,
            runtimeDescriptorV1,
        } as const;
        expect(validateAgentExternalSessionTakeoverLaunchPlan(
            planWithRuntimeDescriptor,
        )).toEqual(planWithRuntimeDescriptor);
        let nestedAccessorReads = 0;
        const accessorAgent = {};
        const accessorDescriptor = {
            v: 1,
            agentId: 'fixture.agent',
            agent: accessorAgent,
        };
        Object.defineProperty(accessorAgent, 'providerSessionId', {
            enumerable: true,
            get() {
                nestedAccessorReads += 1;
                return 'native-session-1';
            },
        });
        rejects(() => validateAgentExternalSessionTakeoverLaunchPlan({
            directory: '/work/project',
            runtimeDescriptorV1: accessorDescriptor,
        }));
        expect(nestedAccessorReads).toBe(0);
        expect(validateAgentExternalSessionTakeoverLaunchPlan({
            directory: 'd'.repeat(AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.maxDirectoryCodeUnits),
            backendModeHint: 'm'.repeat(
                AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.maxBackendModeHintCodeUnits,
            ),
            environmentVariables: Object.fromEntries(
                Array.from(
                    {
                        length:
                            AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS
                                .maxEnvironmentVariableEntries,
                    },
                    (_, index) => [
                        `KEY_${index}`,
                        'v'.repeat(
                            AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS
                                .maxEnvironmentVariableValueCodeUnits,
                        ),
                    ],
                ),
            ),
        })).toBeDefined();
        expect(validateAgentExternalSessionTakeoverLaunchPlan({
            directory: '/work/project',
            environmentVariables: {
                ['K'.repeat(
                    AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS
                        .maxEnvironmentVariableKeyCodeUnits,
                )]: '',
            },
        })).toBeDefined();

        const broadHints = {
            directory: '/work/project',
            environmentVariables: {},
            resumePlanOptions: { mode: 'new' },
        };
        for (const invalidPlan of [
            { directory: '' },
            {
                directory: 'd'.repeat(
                    AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.maxDirectoryCodeUnits + 1,
                ),
            },
            { directory: '/work/project', backendModeHint: '' },
            {
                directory: '/work/project',
                backendModeHint: 'm'.repeat(
                    AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.maxBackendModeHintCodeUnits + 1,
                ),
            },
            {
                directory: '/work/project',
                environmentVariables: Object.fromEntries(
                    Array.from(
                        {
                            length:
                                AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS
                                    .maxEnvironmentVariableEntries + 1,
                        },
                        (_, index) => [`KEY_${index}`, 'value'],
                    ),
                ),
            },
            {
                directory: '/work/project',
                environmentVariables: {
                    ['K'.repeat(
                        AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS
                            .maxEnvironmentVariableKeyCodeUnits + 1,
                    )]: 'value',
                },
            },
            {
                directory: '/work/project',
                environmentVariables: {
                    KEY: 'v'.repeat(
                        AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS
                            .maxEnvironmentVariableValueCodeUnits + 1,
                    ),
                },
            },
            broadHints,
            { directory: '/work/project', existingSessionId: 'authority-smuggling' },
            { directory: '/work/project', unrecognizedHostExtension: 'rejected' },
            { directory: '/work/project', metadata: {} },
            { directory: '/work/project', sessionStateUpdates: [] },
            { directory: '/work/project', connectedServices: {} },
            { directory: '/work/project', pendingInput: {} },
        ]) {
            rejects(() => validateAgentExternalSessionTakeoverLaunchPlan(invalidPlan));
        }
    });

    it('strictly validates success and failure result envelopes', () => {
        expect(validateAgentExternalSessionTakeoverResolveLaunchResult(result))
            .toEqual(result);
        expect(validateAgentExternalSessionTakeoverResolveLaunchResult({
            ok: false,
            code: 'unavailable',
            message: 'Primary runtime unavailable',
            retryable: true,
        })).toEqual({
            ok: false,
            code: 'unavailable',
            message: 'Primary runtime unavailable',
            retryable: true,
        });

        for (const invalidResult of [
            { ok: true, value: { ...plan, target: 'chosen' } },
            { ok: true, value: plan, source: request.source },
            { ok: false, code: 'unknown_failure' },
            { ok: false, code: 'unavailable', retryable: 'yes' },
            {
                ok: false,
                code: 'unavailable',
                message: 'm'.repeat(2_001),
            },
        ]) {
            rejects(() =>
                validateAgentExternalSessionTakeoverResolveLaunchResult(invalidResult),
            );
        }
    });
});
