import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    AutomationApiError,
    cancelAutomationRunV3,
    clearAutomationRunHistoryV3,
    createPluginEventAutomationDefinitionV3,
    getAutomationSettingsV3,
    deleteAutomationDefinitionV3,
    getAutomationDefinitionV3,
    getAutomationRunDetailV3,
    listAutomationDefinitionsV3,
    pauseAutomationDefinitionV3,
    replaceAutomationDefinitionAssignmentsV3,
    resumeAutomationDefinitionV3,
    runAutomationDefinitionNowV3,
    updateAutomationSettingsV3,
    runAutomationNow,
    updatePluginEventAutomationDefinitionV3,
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

const v3EventSummary = {
    id: 'automation-event-1',
    name: 'Repository updates',
    description: null,
    enabled: true,
    trigger: {
        kind: 'pluginEvent' as const,
        eventRef: {
            pluginId: 'happier.scm.github',
            localId: 'repository-event-v1',
        },
        sourceSelectorId: 'selector-1',
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
    },
    targetType: 'existingSession' as const,
    existingSessionId: 'session-1',
    templateVersion: 3,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: 1_786_257_600_000,
    updatedAt: 1_786_257_600_000,
    assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: 1_786_257_600_000 }],
};

const v3ExecutionRecipe = {
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

const v3EventCreate = {
    name: 'Repository updates',
    description: null,
    enabled: true,
    trigger: {
        kind: 'pluginEvent' as const,
        eventRef: {
            pluginId: 'happier.scm.github',
            localId: 'repository-event-v1',
        },
        sourceInstanceId: 'github:repository:1234',
        sourceContractVersion: 1,
        sourceConfig: {
            credentialRef: 'github:account:1',
            repository: 'happier-dev/happier',
        },
        displayLabel: 'happier-dev/happier',
        observationTransport: {
            kind: 'checkpointedPull' as const,
            watcherMaterializationRef: {
                machineId: 'machine-1',
                materializationId: 'materialization-1',
                pluginId: 'happier.scm.github',
            },
        },
        filter: null,
        maximumObservationAgeMs: 60_000,
    },
    executionRecipe: v3ExecutionRecipe,
    assignments: [{ machineId: 'machine-1' }],
};

const v3EventDetail = {
    ...v3EventSummary,
    executionRecipe: v3ExecutionRecipe,
    triggerDefinitionEnvelope: JSON.stringify({
        t: 'plain',
        v: { sourceInstanceId: 'github:repository:1234' },
    }),
};

const v3Run = {
    id: 'run-1',
    automationId: 'automation-event-1',
    state: 'queued' as const,
    origin: {
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
    contentRemovedAt: null,
    createdAt: 1_786_257_600_000,
    updatedAt: 1_786_257_600_000,
};

const v3RunDetail = {
    ...v3Run,
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
            json: async () => ({
                run: {
                    id: 'run-1',
                    automationId: 'auto-1',
                    state: 'queued',
                    scheduledAt: Date.now(),
                    dueAt: Date.now(),
                    claimedAt: null,
                    startedAt: null,
                    finishedAt: null,
                    claimedByMachineId: null,
                    leaseExpiresAt: null,
                    attempt: 0,
                    summaryCiphertext: null,
                    errorCode: null,
                    errorMessage: null,
                    producedSessionId: null,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            }),
        }));

        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await runAutomationNow(credentials, 'auto-1');

        const runNowCall = fetchSpy.mock.calls.find(
            ([input]) => toUrlString(input).includes('/v2/automations/auto-1/run-now'),
        );

        expect(runNowCall).toBeTruthy();

        const request = runNowCall?.[1];
        const headers = new Headers(request?.headers);

        expect(headers.get('Authorization')).toBe('Bearer token-1');
        expect(headers.get('Content-Type')).toBeNull();
    });

    it('keeps V3 list summaries private-content-free and reads detail only by id', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
            const url = toUrlString(input);
            if (url.includes('/v3/automations/automation-event-1')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => v3EventDetail,
                } as Response;
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ automations: [v3EventSummary] }),
            } as Response;
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const summaries = await listAutomationDefinitionsV3(credentials);
        const detail = await getAutomationDefinitionV3(credentials, 'automation-event-1');

        expect(summaries).toEqual([v3EventSummary]);
        expect(summaries[0]).not.toHaveProperty('triggerDefinitionEnvelope');
        expect(detail).toMatchObject({
            id: 'automation-event-1',
            triggerDefinitionEnvelope: expect.any(String),
            executionRecipe: expect.objectContaining({ templateVersion: 3 }),
        });
        expect(fetchSpy.mock.calls.map(([input]) => toUrlString(input))).toEqual(expect.arrayContaining([
            expect.stringContaining('/v3/automations'),
            expect.stringContaining('/v3/automations/automation-event-1'),
        ]));
    });

    it('reads one direct V3 Run detail and cancels a Run through the incumbent V3 owner', async () => {
        const cancelledRun = { ...v3Run, state: 'cancelled' as const, finishedAt: 1_786_257_601_000 };
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
                json: async () => v3RunDetail,
            } as Response;
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const detail = await getAutomationRunDetailV3(credentials, 'automation-event-1', 'run-1');
        const cancelled = await cancelAutomationRunV3(credentials, 'run-1');

        expect(detail).toEqual(v3RunDetail);
        expect(cancelled).toEqual(cancelledRun);
        expect(fetchSpy.mock.calls.map(([input]) => toUrlString(input))).toEqual([
            expect.stringContaining('/v3/automations/automation-event-1/runs/run-1'),
            expect.stringContaining('/v3/automations/runs/run-1/cancel'),
        ]);
    });

    it('reads and replaces strict account Automation settings, then clears one definition history through V3', async () => {
        const settings = {
            maxActiveRunsPerMachine: 4,
            runRetention: 'thirtyDays' as const,
        };
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
            const url = toUrlString(input);
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

        await expect(getAutomationSettingsV3(credentials)).resolves.toEqual(settings);
        await expect(updateAutomationSettingsV3(credentials, settings)).resolves.toEqual(settings);
        await expect(clearAutomationRunHistoryV3(credentials, 'automation-event-1')).resolves.toEqual({ clearedRuns: 3 });

        const calls = fetchSpy.mock.calls.map(([input, init]) => ({
            url: toUrlString(input),
            method: init?.method,
            body: init?.body,
            headers: new Headers(init?.headers),
        }));
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

    it('rejects private definition content in a V3 list response instead of treating it as a summary', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                automations: [{
                    ...v3EventSummary,
                    triggerDefinitionEnvelope: v3EventDetail.triggerDefinitionEnvelope,
                }],
            }),
        }) as Response);
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await expect(listAutomationDefinitionsV3(credentials)).rejects.toThrow();
    });

    it('posts a strict Event create and full versioned patch only to the V3 owner', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => ({
            ok: true,
            status: 200,
            json: async () => v3EventDetail,
        }) as Response);
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await createPluginEventAutomationDefinitionV3(credentials, v3EventCreate);
        await updatePluginEventAutomationDefinitionV3(credentials, 'automation-event-1', {
            ...v3EventCreate,
            expectedTemplateVersion: 3,
        });

        const createCall = fetchSpy.mock.calls.find(([input, init]) =>
            toUrlString(input).includes('/v3/automations') && init?.method === 'POST',
        );
        const patchCall = fetchSpy.mock.calls.find(([input, init]) =>
            toUrlString(input).includes('/v3/automations/automation-event-1') && init?.method === 'PATCH',
        );
        expect(createCall).toBeTruthy();
        expect(JSON.parse(String(createCall?.[1]?.body))).toEqual(v3EventCreate);
        expect(patchCall).toBeTruthy();
        expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
            ...v3EventCreate,
            expectedTemplateVersion: 3,
        });
    });

    it('keeps stale-version and stored-content failures typed for the composer', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (_input, init) => ({
            ok: false,
            status: 409,
            json: async () => ({
                error: init?.method === 'PATCH'
                    ? 'automation_template_version_conflict'
                    : 'automation_stored_content_unavailable',
            }),
        }) as Response);
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await expect(updatePluginEventAutomationDefinitionV3(credentials, 'automation-event-1', {
            ...v3EventCreate,
            expectedTemplateVersion: 3,
        })).rejects.toMatchObject({
            name: 'AutomationApiError',
            code: 'automation_template_version_conflict',
            status: 409,
        } satisfies Partial<AutomationApiError>);
        await expect(createPluginEventAutomationDefinitionV3(credentials, v3EventCreate)).rejects.toMatchObject({
            name: 'AutomationApiError',
            code: 'automation_stored_content_unavailable',
            status: 409,
        } satisfies Partial<AutomationApiError>);
    });

    it('keeps Event lifecycle mutations in the incumbent V3 owner', async () => {
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
                json: async () => url.endsWith('/run-now') ? { run: v3Run } : v3EventDetail,
            } as Response;
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await pauseAutomationDefinitionV3(credentials, 'automation-event-1');
        await resumeAutomationDefinitionV3(credentials, 'automation-event-1');
        await replaceAutomationDefinitionAssignmentsV3(credentials, 'automation-event-1', [{
            machineId: 'machine-2',
            enabled: true,
            priority: 10,
        }]);
        await runAutomationDefinitionNowV3(credentials, 'automation-event-1');
        await deleteAutomationDefinitionV3(credentials, 'automation-event-1');

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
