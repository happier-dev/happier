import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    cancelAutomationRun,
    clearAutomationRunHistory,
    getAutomationSettings,
    deleteAutomationDefinition,
    getAutomationDefinition,
    getAutomationRunDetail,
    listAutomationDefinitions,
    pauseAutomationDefinition,
    replaceAutomationDefinitionAssignments,
    retryAutomationReplyHandoff,
    resumeAutomationDefinition,
    runAutomationDefinitionNow,
    updateAutomationSettings,
} from './apiAutomations';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://api.example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const credentials: AuthCredentials = { token: 'token-1', secret: 'secret-1' };

const eventSummary = {
    id: 'automation-event-1',
    name: 'Repository updates',
    description: null,
    enabled: true,
    triggers: [{
        id: '11111111-1111-4111-8111-111111111111',
        revision: 2,
        enabled: true,
        createdAt: 1_786_257_600_000,
        updatedAt: 1_786_257_600_000,
        kind: 'pluginEvent' as const,
        eventRef: {
            pluginId: 'happier.scm.github',
            localId: 'push',
        },
        sourceSelectorId: '22222222-2222-4222-8222-222222222222',
        sourceContractVersion: 1,
        observation: {
            kind: 'checkpointedPull' as const,
            watcher: {
                machineId: 'machine-1',
                machineInstallationId: 'installation-1',
                pluginId: 'happier.scm.github',
                materializationId: 'materialization-1',
            },
        },
        sourceStatus: null,
        sourceCatalogStatus: null,
    }],
    targetType: 'existingSession' as const,
    existingSessionId: 'session-1',
    templateVersion: 3,
    lastRunAt: null,
    createdAt: 1_786_257_600_000,
    updatedAt: 1_786_257_600_000,
    assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: 1_786_257_600_000 }],
    retiredTriggers: [],
};

const eventExecutionRecipe = {
    v: 1 as const,
    templateVersion: 3,
    template: {
        t: 'plain' as const,
        v: { v: 1, prompt: 'Review {{input}}' },
    },
    triggerEvidence: null,
    target: {
        kind: 'existingSession' as const,
        sessionId: 'session-1',
    },
};

const eventDetail = {
    ...eventSummary,
    executionRecipe: eventExecutionRecipe,
    triggers: eventSummary.triggers.map((trigger) => ({
        ...trigger,
        triggerDefinitionEnvelope: JSON.stringify({
            t: 'plain',
            v: { sourceInstanceId: 'github:repository:1234' },
        }),
    })),
};

const runSummary = {
    id: 'run-1',
    automationId: 'automation-event-1',
    revision: 1,
    triggerId: null,
    triggerRetired: false,
    state: 'queued' as const,
    cause: {
        kind: 'manual' as const,
        invokedAt: 1_786_257_600_000,
    },
    dueAt: 1_786_257_600_000,
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    claimedByMachineId: null,
    leaseExpiresAt: null,
    attempt: 0,
    errorCode: null,
    producedSessionId: null,
    executionDispatchState: null,
    executionAttempt: 0,
    replyHandoffState: 'none' as const,
    replyHandoffAttempt: 0,
    replyHandoffDueAt: null,
    createdAt: 1_786_257_600_000,
    updatedAt: 1_786_257_600_000,
};

const runDetail = {
    ...runSummary,
    triggerEvidenceEnvelope: null,
    executionInputEnvelope: null,
    resultEnvelope: null,
    legacySummaryCiphertext: null,
    executionNativeRunId: null,
    executionNativeCallId: null,
    executionNativeSidechainId: null,
    events: [],
};

function toUrlString(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    if (input && typeof (input as Request).url === 'string') return (input as Request).url;
    return String(input);
}

describe('apiAutomations', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('does not send JSON Content-Type for run-now POST requests without a body', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<any>>(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ run: { ...runSummary, automationId: 'auto-1' } }),
        }));

        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await runAutomationDefinitionNow(credentials, 'auto-1');

        const runNowCall = fetchSpy.mock.calls.find(
            ([input]) => toUrlString(input).includes('/v3/automations/auto-1/run-now'),
        );

        expect(runNowCall).toBeTruthy();

        const request = runNowCall?.[1];
        const headers = new Headers(request?.headers);

        expect(headers.get('Authorization')).toBe('Bearer token-1');
        expect(headers.get('Content-Type')).toBeNull();
    });

    it('keeps current list summaries private-content-free and reads detail only by id', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
            const url = toUrlString(input);
            if (url.includes('/v3/automations/automation-event-1')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => eventDetail,
                } as Response;
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ automations: [eventSummary] }),
            } as Response;
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const summaries = await listAutomationDefinitions(credentials);
        const detail = await getAutomationDefinition(credentials, 'automation-event-1');

        expect(summaries).toEqual([eventSummary]);
        expect(summaries[0]).not.toHaveProperty('triggerDefinitionEnvelope');
        expect(detail).toMatchObject({
            id: 'automation-event-1',
            triggers: [expect.objectContaining({ triggerDefinitionEnvelope: expect.any(String) })],
            executionRecipe: expect.objectContaining({ templateVersion: 3 }),
        });
        expect(fetchSpy.mock.calls.map(([input]) => toUrlString(input))).toEqual(expect.arrayContaining([
            expect.stringContaining('/v3/automations'),
            expect.stringContaining('/v3/automations/automation-event-1'),
        ]));
    });

    it('reads one direct Run detail and cancels a Run through the incumbent owner', async () => {
        const cancelledRun = { ...runSummary, state: 'cancelled' as const, finishedAt: 1_786_257_601_000 };
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
            const url = toUrlString(input);
            if (url.endsWith('/v3/automations/runs/run-1/cancel')) {
                expect(init?.method).toBe('POST');
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ run: cancelledRun }),
                } as Response;
            }
            expect(url).toContain('/v3/automations/automation-event-1/runs/run-1');
            expect(init?.method).toBeUndefined();
            return {
                ok: true,
                status: 200,
                json: async () => runDetail,
            } as Response;
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const detail = await getAutomationRunDetail(credentials, 'automation-event-1', 'run-1');
        const cancelled = await cancelAutomationRun(credentials, 'run-1');

        expect(detail).toEqual(runDetail);
        expect(cancelled).toEqual(cancelledRun);
        expect(fetchSpy.mock.calls.map(([input]) => toUrlString(input))).toEqual([
            expect.stringContaining('/v3/automations/automation-event-1/runs/run-1'),
            expect.stringContaining('/v3/automations/runs/run-1/cancel'),
        ]);
    });

    it('requeues a blocked reply handoff through the canonical Run mutation route', async () => {
        const readyRun = {
            ...runSummary,
            replyHandoffState: 'ready' as const,
            replyHandoffDueAt: 1_786_257_601_000,
        };
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
            async (input, init) => {
                expect(toUrlString(input)).toContain('/v3/automations/runs/run-1/retry-reply-handoff');
                expect(init?.method).toBe('POST');
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ run: readyRun }),
                } as Response;
            },
        );
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await expect(retryAutomationReplyHandoff(credentials, 'run-1')).resolves.toEqual(readyRun);
    });

    it('reads and replaces strict account Automation settings, then clears one definition history', async () => {
        const settings = {
            maxActiveRunsPerMachine: 4,
            runRetention: 'thirtyDays' as const,
        };
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
            const url = toUrlString(input);
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return new Response('{}', { status: 200 });
            }
            if (url.endsWith('/v3/automations/settings')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => settings,
                } as Response;
            }
            if (url.endsWith('/v3/automations/automation-event-1/runs/clear-history')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ clearedRuns: 3 }),
                } as Response;
            }
            throw new Error(`Unexpected request: ${url} ${String(init?.method)}`);
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await expect(getAutomationSettings(credentials)).resolves.toEqual(settings);
        await expect(updateAutomationSettings(credentials, settings)).resolves.toEqual(settings);
        await expect(clearAutomationRunHistory(credentials, 'automation-event-1')).resolves.toEqual({ clearedRuns: 3 });

        const calls = fetchSpy.mock.calls.map(([input, init]) => ({
            url: toUrlString(input),
            method: init?.method,
            body: init?.body,
            headers: new Headers(init?.headers),
        })).filter((call) => call.url.includes('/v3/automations/'));
        expect(calls).toEqual([
            expect.objectContaining({
                url: expect.stringContaining('/v3/automations/settings'),
                method: undefined,
            }),
            expect.objectContaining({
                url: expect.stringContaining('/v3/automations/settings'),
                method: 'PUT',
                body: JSON.stringify(settings),
            }),
            expect.objectContaining({
                url: expect.stringContaining('/v3/automations/automation-event-1/runs/clear-history'),
                method: 'POST',
            }),
        ]);
        expect(calls[0]?.headers.get('Authorization')).toBe('Bearer token-1');
        expect(calls[1]?.headers.get('Content-Type')).toBe('application/json');
        expect(calls[2]?.headers.get('Content-Type')).toBeNull();
    });

    it('rejects private definition content in a current list response instead of treating it as a summary', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                automations: [{
                    ...eventSummary,
                    triggers: eventDetail.triggers,
                }],
            }),
        }) as Response);
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await expect(listAutomationDefinitions(credentials)).rejects.toThrow();
    });

    it('keeps Event lifecycle mutations in the incumbent owner', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
            const url = toUrlString(input);
            if (init?.method === 'DELETE') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ ok: true }),
                } as Response;
            }
            return {
                ok: true,
                status: 200,
                json: async () => url.endsWith('/run-now') ? { run: runSummary } : eventDetail,
            } as Response;
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await pauseAutomationDefinition(credentials, 'automation-event-1');
        await resumeAutomationDefinition(credentials, 'automation-event-1');
        await replaceAutomationDefinitionAssignments(credentials, 'automation-event-1', [{
            machineId: 'machine-2',
            enabled: true,
            priority: 10,
        }]);
        await runAutomationDefinitionNow(credentials, 'automation-event-1');
        await deleteAutomationDefinition(credentials, 'automation-event-1');

        const calls = fetchSpy.mock.calls.map(([input, init]) => ({
            url: toUrlString(input),
            method: init?.method,
            body: init?.body,
        }));
        expect(calls).toEqual([
            expect.objectContaining({ url: expect.stringContaining('/v3/automations/automation-event-1/pause'), method: 'POST' }),
            expect.objectContaining({ url: expect.stringContaining('/v3/automations/automation-event-1/resume'), method: 'POST' }),
            expect.objectContaining({
                url: expect.stringContaining('/v3/automations/automation-event-1/assignments'),
                method: 'POST',
                body: JSON.stringify({ assignments: [{ machineId: 'machine-2', enabled: true, priority: 10 }] }),
            }),
            expect.objectContaining({ url: expect.stringContaining('/v3/automations/automation-event-1/run-now'), method: 'POST' }),
            expect.objectContaining({ url: expect.stringContaining('/v3/automations/automation-event-1'), method: 'DELETE' }),
        ]);
        expect(calls.every((call) => call.url.includes('/v3/automations/'))).toBe(true);
    });
});
