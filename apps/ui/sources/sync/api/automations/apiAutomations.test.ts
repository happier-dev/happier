import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    clearAutomationRunHistory,
    getAutomationSettings,
    deleteAutomationDefinition,
    getAutomationDefinition,
    getAutomationRunDetail,
    listAutomationDefinitions,
    pauseAutomationDefinition,
    replaceAutomationDefinitionAssignments,
    mutateAutomationOccurrence,
    resumeAutomationDefinition,
    runAutomationDefinitionNow,
    updateAutomationSettings,
    reconcileAutomationDefinition,
} from './apiAutomations';

vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>(),
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://api.example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const credentials: AuthCredentials = { token: 'token-1', secret: 'secret-1' };

it.each([
    { managedTarget: { homeId: 'home-one', managedId: 'managed-one' }, includeUnindexedManagedTargets: true as const },
    { managedTargetUnindexed: true as const },
])('sends a managed relationship select as a structured query', async query => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({ automations: [], nextCursor: null })));
    await listAutomationDefinitions(credentials, query, { serverId: 'test', request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('/v3/automations/query');
    const init = request.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject(query);
});

it('refuses an unsupported selected read without falling back to an Account census', async () => {
    const request = vi.fn(async (_path: string) => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
    await expect(listAutomationDefinitions(credentials, { workflowDefinitionIds: ['builtin:review'] },
        { serverId: 'test', request })).rejects.toMatchObject({ status: 404 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('/v3/automations/query');
});

describe('Automation write receipt certainty', () => {
    it.each(['read', 'write'] as const)('preserves the HTTP owner failure cause on a refused %s', async kind => {
        const failureCause = { phase: 'execution_authorization', errorClass: 'Error',
            errorCode: 'credential_scope_denied', httpStatus: 403 };
        const request = vi.fn(async () => Response.json({ error: 'credential_scope_denied', failureCause }, { status: 403 }));
        const context = { serverId: 'test', request };
        const result = kind === 'read' ? getAutomationDefinition(credentials, 'set-one', context)
            : reconcileAutomationDefinition(credentials, 'set-one', {
                expectedTemplateVersion: 1, name: 'Triggers', description: null, enabled: true,
                assignments: [], triggers: [], removedTriggers: [],
            }, context);
        await expect(result).rejects.toMatchObject({ code: 'credential_scope_denied', status: 403, failureCause });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it.each(['lost', 'invalid', 'server'] as const)('keeps a %s mutation receipt unresolved', async kind => {
        const request = vi.fn(async () => {
            if (kind === 'lost') throw new Error('transport lost');
            return new Response('{}', { status: kind === 'server' ? 500 : 200 });
        });
        await expect(reconcileAutomationDefinition(credentials, 'set-one', {
            expectedTemplateVersion: 1, name: 'Triggers', description: null, enabled: true,
            assignments: [], triggers: [], removedTriggers: [],
        }, { serverId: 'test', request })).rejects.toMatchObject({ code: 'workflow_outcome_unresolved' });
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('keeps known pre-write conflicts as refusals', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({ error: 'automation_template_version_conflict' }), { status: 409 }));
        await expect(reconcileAutomationDefinition(credentials, 'set-one', {
            expectedTemplateVersion: 1, name: 'Triggers', description: null, enabled: true,
            assignments: [], triggers: [], removedTriggers: [],
        }, { serverId: 'test', request })).rejects.toMatchObject({ code: 'automation_template_version_conflict' });
    });
});

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
    it.each([{ ok: true, removedRevision: 11 }, { ok: true }])('returns deletion evidence as provided by the Home: %j', async (receipt) => {
        const request = vi.fn(async () => Response.json(receipt));
        await expect(deleteAutomationDefinition(credentials, 'deleted-set', { request, serverId: 'test' }))
            .resolves.toEqual(receipt);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('does not send JSON Content-Type for run-now POST requests without a body', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<any>>(async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
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

    it('preserves the exact workflow Run correspondence the admission receipt declared', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
                run: { ...runSummary, id: 'run-42', automationId: 'auto-1' },
                workflowRun: { recipeKind: 'workflow-v2', workflowRunId: 'run-42' },
            }),
        })) as unknown as typeof fetch);

        const admitted = await runAutomationDefinitionNow(credentials, 'auto-1');

        expect(admitted.run.id).toBe('run-42');
        expect(admitted.workflowRun).toEqual({ recipeKind: 'workflow-v2', workflowRunId: 'run-42' });
    });

    it('leaves a legacy admission receipt without a fabricated workflow correspondence', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ run: { ...runSummary, id: 'run-7', automationId: 'auto-1' } }),
        })) as unknown as typeof fetch);

        const admitted = await runAutomationDefinitionNow(credentials, 'auto-1');

        expect(admitted.run.id).toBe('run-7');
        expect(admitted.workflowRun).toBeUndefined();
    });

    it('reads and mutates current Automations without an API epoch advertisement', async () => {
        const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = toUrlString(input);
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => url.endsWith('/run-now') ? { run: runSummary }
                    : init?.method === 'PUT' ? eventDetail : { automations: [eventSummary], nextCursor: null },
            } as Response;
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await expect(listAutomationDefinitions(credentials)).resolves.toMatchObject({
            automations: [{ id: eventSummary.id, targetType: 'existingSession' }],
            nextCursor: null,
        });
        await expect(runAutomationDefinitionNow(credentials, eventSummary.id)).resolves.toMatchObject({
            run: { id: runSummary.id, cause: { kind: 'manual' } },
        });
        await expect(reconcileAutomationDefinition(credentials, eventSummary.id, {
            expectedTemplateVersion: 3, name: eventSummary.name, description: null, enabled: true,
            assignments: [], triggers: [], removedTriggers: [],
        })).resolves.toMatchObject({ id: eventSummary.id });
        expect(fetchSpy.mock.calls.map(([input]) => toUrlString(input))).toEqual([
            expect.stringContaining('/v3/automations?limit=100'),
            expect.stringContaining('/v3/automations/automation-event-1/run-now'),
            expect.stringContaining('/v3/automations/automation-event-1'),
        ]);
    });

    it('admits managed Workflow runs through the current route without a capability probe', async () => {
        const fetchSpy = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
            run: { ...runSummary, automationId: 'workflow-managed' },
            workflowRun: { recipeKind: 'workflow-v2', workflowRunId: runSummary.id },
        }), { status: 200 }));
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await expect(runAutomationDefinitionNow(credentials, 'workflow-managed'))
            .resolves.toMatchObject({ workflowRun: { workflowRunId: runSummary.id } });
        expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/v3/automations/workflow-managed/run-now'), expect.anything());
        expect(fetchSpy.mock.calls.map(([input]) => toUrlString(input))).toEqual([
            expect.stringContaining('/v3/automations/workflow-managed/run-now'),
        ]);
    });

    it('keeps current list summaries private-content-free and reads detail only by id', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
            const url = toUrlString(input);
            if (url.includes('/v3/automations/automation-event-1')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: async () => eventDetail,
                } as Response;
            }
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({ automations: [eventSummary], nextCursor: 'next-page' }),
            } as Response;
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const summaries = await listAutomationDefinitions(credentials);
        const detail = await getAutomationDefinition(credentials, 'automation-event-1');

        expect(summaries).toEqual({ automations: [eventSummary], nextCursor: 'next-page' });
        expect(summaries.automations[0]).not.toHaveProperty('triggerDefinitionEnvelope');
        expect(detail).toMatchObject({
            id: 'automation-event-1',
            triggers: [expect.objectContaining({ triggerDefinitionEnvelope: expect.any(String) })],
            executionRecipe: expect.objectContaining({ templateVersion: 3 }),
        });
        expect(fetchSpy.mock.calls.map(([input]) => toUrlString(input))).toEqual(expect.arrayContaining([
            expect.stringContaining('/v3/automations?limit=100'),
            expect.stringContaining('/v3/automations/automation-event-1'),
        ]));
    });

    it('reads one direct Run detail by its Automation and Run ids', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
            const url = toUrlString(input);
            expect(url).toContain('/v3/automations/automation-event-1/runs/run-1');
            expect(init?.method).toBeUndefined();
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => runDetail,
            } as Response;
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const detail = await getAutomationRunDetail(credentials, 'automation-event-1', 'run-1');

        expect(detail).toEqual(runDetail);
        expect(fetchSpy.mock.calls.map(([input]) => toUrlString(input))).toEqual([
            expect.stringContaining('/v3/automations/automation-event-1/runs/run-1'),
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
                    headers: new Headers(),
                    json: async () => ({ run: readyRun }),
                } as Response;
            },
        );
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await expect(mutateAutomationOccurrence(credentials, 'automation.run.reply_handoff.retry', { runId: 'run-1' })).resolves.toEqual(readyRun);
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
                    headers: new Headers(),
                    json: async () => settings,
                } as Response;
            }
            if (url.endsWith('/v3/automations/automation-event-1/runs/clear-history')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers(),
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
            headers: new Headers(),
            json: async () => ({
                automations: [{
                    ...eventSummary,
                    triggers: eventDetail.triggers,
                }],
                nextCursor: null,
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
                    headers: new Headers(),
                    json: async () => ({ ok: true, removedRevision: 11 }),
                } as Response;
            }
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
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
        await expect(deleteAutomationDefinition(credentials, 'automation-event-1'))
            .resolves.toEqual({ ok: true, removedRevision: 11 });

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
