import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
    BackendSessionLaunchHintsV1,
} from './index.js';
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
} from './index.js';

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
    linkedDirectory: '/work/project',
} as const satisfies AgentExternalSessionTakeoverResolveLaunchRequest;

const plan = {
    directory: '/work/project',
    backendModeHint: 'resume',
    environmentVariables: {
        AGENT_PROFILE: 'profile-1',
    },
} as const satisfies AgentExternalSessionTakeoverLaunchPlan;

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
    it('publishes exactly one request-only callback and the existing result envelope', async () => {
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

        rejects(() => validateAgentExternalSessionTakeoverContribution({
            resolveLaunch,
            resolveStop: () => result,
        }));
    });

    it('strictly snapshots the bounded fresh linked-identity request', () => {
        expect(validateAgentExternalSessionTakeoverResolveLaunchRequest(request))
            .toEqual(request);

        for (const invalidRequest of [
            { ...request, linkedSessionId: '' },
            { ...request, linkedSessionId: 's'.repeat(2_001) },
            { ...request, remoteSessionId: '' },
            { ...request, remoteSessionId: 'r'.repeat(2_001) },
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
            linkedDirectory: 'd'.repeat(10_000),
        })).toMatchObject({
            linkedSessionId: 's'.repeat(2_000),
            remoteSessionId: 'r'.repeat(2_000),
            linkedDirectory: 'd'.repeat(10_000),
        });
    });

    it('accepts only the exact bounded launch-plan fields', () => {
        expect(validateAgentExternalSessionTakeoverLaunchPlan(plan)).toEqual(plan);
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

        const broadHints: BackendSessionLaunchHintsV1 = {
            directory: '/work/project',
            environmentVariables: {},
            resumePlanOptions: {
                mode: 'new',
            },
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
            { ok: true, value: { directory: '/work/project', target: 'chosen' } },
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
