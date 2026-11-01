import { createServer, type ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';
import { AgentSessionRuntimeEventSchema, type AgentSessionRuntimeContext, type AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { bindSessionProviderInputOutcome, createSessionProviderInputOutcomeBinding, type SessionProviderInputOutcome } from '@/agent/runtime/session/input/providerInputOutcome';
import { createDeferred } from '@/testkit/async/deferred';
import { createManagedServiceProcessSupervisorHost } from './managedProcessSupervisor';
import { createManagedServicesOwner } from './managedServicesOwner';
import { createUnavailableManagedServices } from './managedServicesAdapter';
import { createUnavailablePluginServices } from './unavailable';
import { createContextFixture } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/assembly.managedServices.testkit';
import { createOpenCodeServerClient } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/openCodeServerClient';
import { createOpenCodeServerRuntime } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/runtime';
import { createOpenCodeSessionRuntime } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/sessionRuntime';
import { createOpenCodeServerTransport } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/transport';

const sessionId = 'happier-custody';
const nativeSessionId = 'ses_committed';
const inputId = 'host-original-input';
const turnId = 'host-original-turn';
const prompt = 'Reply exactly CUSTODY DONE. Do not use tools or modify files.';

async function composeCustody(identity: 'matching' | 'missing-session' | 'foreign-session' | 'missing-user' = 'matching') {
    const lifetime = new AbortController();
    const committed = createDeferred<void>();
    const messages: unknown[] = [];
    const events: AgentSessionRuntimeEvent[] = [];
    const settlements: SessionProviderInputOutcome[] = [];
    const unexpectedRoutes: string[] = [];
    let eventResponse: ServerResponse | null = null;
    let promptResponse: ServerResponse | null = null;
    let busy = false;
    let promptRequests = 0;
    let historyReads = 0;
    let completedResponses = 0;
    let userCreatedAt = 0;
    const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const json = (value: unknown) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(value));
        };
        if (url.pathname === '/event' || url.pathname === '/global/event') {
            if (url.pathname === '/event') eventResponse = response;
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.write('data: {"type":"server.connected","properties":{}}\n\n');
        } else if (url.pathname === '/health') json({ healthy: true });
        else if (url.pathname === '/session' && request.method === 'POST') json({ id: nativeSessionId });
        else if (url.pathname === `/session/${nativeSessionId}`) json({ id: nativeSessionId, directory: '/repo' });
        else if (url.pathname === `/session/${nativeSessionId}/message` && request.method === 'POST') {
            promptRequests += 1;
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { parts: readonly unknown[] };
            userCreatedAt = Date.now();
            messages.push({ info: { ...(identity === 'missing-user' ? {} : { id: 'msg_original' }),
                role: 'user', time: { created: userCreatedAt },
                ...(identity === 'missing-session' ? {} : { sessionID: identity === 'foreign-session' ? 'ses_foreign' : nativeSessionId }) },
                parts: body.parts });
            busy = true;
            promptResponse = response;
            response.once('finish', () => { completedResponses += 1; });
            committed.resolve();
        } else if (url.pathname === `/session/${nativeSessionId}/message`) {
            historyReads += 1;
            json(messages);
        } else if (url.pathname === `/session/${nativeSessionId}/message/msg_original`) json(messages[0]);
        else if (url.pathname === '/session/status') json(busy ? { [nativeSessionId]: { type: 'busy' } } : {});
        else if (url.pathname === `/session/${nativeSessionId}/abort`) json(true);
        else if (['/agent', '/command', '/skill', '/provider', '/config', '/mcp', '/permission', '/question'].includes(url.pathname)) json([]);
        else {
            unexpectedRoutes.push(`${request.method} ${url.pathname}`);
            response.writeHead(500).end();
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const owner = createManagedServicesOwner({
        processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
        dependencies: createUnavailableManagedServices().dependencies,
        resolveScope: scope => scope,
    });
    // The plugin uses the same public handle as an installed external Agent.
    const services = owner.bindScope({ occurrenceId: 'external-custody', pluginId: 'acme.external-opencode',
        contributionQualifiedId: 'acme.external-opencode/agents/opencode', operationId: 'session',
        signal: lifetime.signal, isOccurrenceCurrent: () => !lifetime.signal.aborted,
    }, createUnavailablePluginServices().exec);
    const handle = await services.supervise({ id: 'native-opencode', mode: { kind: 'attach', baseUrl },
        clientAccess: { kind: 'none' }, healthCheck: { kind: 'http', target: { kind: 'servicePath', path: '/health' } } });
    await handle.waitUntilHealthy();
    const client = createOpenCodeServerClient({ dialect: 'v1', directory: '/repo', signal: lifetime.signal,
        transport: createOpenCodeServerTransport({ managedService: handle, signal: lifetime.signal }) });
    const operations = createOpenCodeServerRuntime({ ctx: createContextFixture({ managedServerBaseUrl: baseUrl }),
        directory: '/repo', happierSessionId: sessionId, client, dialect: 'v1',
        mcpRegistration: Promise.resolve({ requiredHappier: { status: 'ready' }, registeredServers: [] }),
        mcpProjection: { registrations: [], requiredHappierServerName: null, requiredHappierConfigurationPresent: false } });
    const native = createOpenCodeSessionRuntime({ operations, request: { kind: 'create', sessionId, cwd: '/repo' },
        disposeOperations: () => operations.resetOrDisposeRuntime(),
        runtimeCapabilities: { sessionCapabilities: {}, tools: { delivery: 'native_mcp', support: 'supported' } } });
    native.watch(event => events.push(AgentSessionRuntimeEventSchema.parse(event)));
    // Only signal is consumed from the invocation context by this host slice.
    // Session/turn correlation, invariant validation and outcome translation stay real.
    const context = { signal: lifetime.signal } as AgentSessionRuntimeContext;
    const host = createNativeAgentSessionOperations(native, sessionId, undefined, undefined, undefined, undefined, undefined, {
        context, cwd: '/repo', connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
    });
    const binding = createSessionProviderInputOutcomeBinding({ getTarget: () => ({ sessionId,
        hasPendingProviderInput: localId => localId === inputId,
        // The durable Pending write is the host's external persistence boundary.
        observeProviderInputSettlement: outcome => { settlements.push(outcome); },
    }) });
    const unbind = bindSessionProviderInputOutcome({ runtime: host,
        observe: binding.observeProviderInputOutcome, wakePendingMaterialization() {} });
    const emit = (type: string, properties: Readonly<Record<string, unknown>>) => {
        if (!eventResponse) throw new Error('Expected native SSE subscription');
        eventResponse.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
    };
    return {
        host, native, operations, handle, events, settlements, committed: committed.promise,
        counters: () => ({ promptRequests, historyReads, completedResponses }),
        emitCommit() {
            emit('message.updated', { info: { id: 'msg_original', role: 'user', sessionID: nativeSessionId,
                time: { created: userCreatedAt } } });
            emit('message.part.updated', { part: { id: 'part_original', type: 'text', messageID: 'msg_original',
                sessionID: nativeSessionId, text: prompt } });
            emit('session.status', { sessionID: nativeSessionId, status: { type: 'busy' } });
        },
        async finishAssistantWhileBusy() {
            const assistant = { info: { id: 'msg_reply', role: 'assistant', sessionID: nativeSessionId,
                parentID: 'msg_original', time: { created: userCreatedAt + 1, completed: Date.now() }, finish: 'stop' },
                parts: [{ id: 'part_reply', type: 'text', sessionID: nativeSessionId, messageID: 'msg_reply', text: 'CUSTODY DONE' }] };
            messages.push(assistant);
            // Await native-event ingestion for the finality assertion; custody above
            // still crosses the real SSE subscription and public managed HTTP handle.
            await operations.handleProviderEvent({ type: 'message.updated', properties: { info: assistant.info } });
            await operations.handleProviderEvent({ type: 'message.part.updated', properties: { part: assistant.parts[0] } });
            await operations.handleProviderEvent({ type: 'session.compacted', properties: { sessionID: nativeSessionId } });
            return assistant;
        },
        releaseResponse() {
            promptResponse?.writeHead(200, { 'content-type': 'application/json' });
            promptResponse?.end(JSON.stringify(messages.at(-1)));
        },
        idle() {
            busy = false;
            emit('session.status', { sessionID: nativeSessionId, status: { type: 'idle' } });
            emit('session.idle', { sessionID: nativeSessionId });
        },
        async open() {
            await operations.openSession({ kind: 'create' });
            await expect.poll(() => eventResponse !== null && historyReads > 0).toBe(true);
        },
        async dispose() {
            vi.useRealTimers();
            lifetime.abort();
            unbind();
            await host.resetOrDisposeRuntime('session_end');
            await owner.dispose();
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
            expect(unexpectedRoutes).toEqual([]);
        },
    };
}

describe('external OpenCode native input custody through managed HTTP and the host consumer', () => {
    it.each(['response-before-idle', 'idle-before-response'] as const)('accepts committed input before a long response and waits for native finality (%s)', async ordering => {
        const fixture = await composeCustody();
        let sendError: unknown;
        let completed = false;
        let completionError: unknown;
        try {
            await fixture.open();
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
            const send = fixture.host.sendTurnPrompt(prompt, { localId: inputId, turnId, userMessageSeq: 41 })
                .catch(error => { sendError = error; });
            await fixture.committed;
            fixture.emitCommit();
            await vi.waitFor(() => expect(fixture.settlements).toContainEqual(expect.objectContaining({
                kind: 'accepted', localId: inputId, userMessageSeq: 41, providerTurnId: turnId,
            })));
            await send;
            expect(sendError).toBeUndefined();
            expect(fixture.counters()).toMatchObject({ promptRequests: 1, completedResponses: 0 });
            await vi.advanceTimersByTimeAsync(300_001);
            vi.useRealTimers();
            expect(fixture.counters()).toMatchObject({ promptRequests: 1, completedResponses: 0 });
            expect(fixture.events.some(event => event.kind === 'input-custody-unknown')).toBe(false);
            const completion = fixture.host.waitForTurnCompletion().then(() => { completed = true; }, error => { completionError = error; });
            await fixture.finishAssistantWhileBusy();
            expect(completed).toBe(false);
            expect(fixture.events.some(event => event.kind === 'turn-complete')).toBe(false);
            if (ordering === 'response-before-idle') {
                const committedReply = () => fixture.events.filter(event => event.kind === 'transcript-message-committed'
                    && event.role === 'assistant' && event.text === 'CUSTODY DONE');
                expect(committedReply()).toEqual([]);
                fixture.releaseResponse();
                // Unlike a server-side finish, the real committed transcript event
                // proves the response reached the native finality reader.
                await expect.poll(committedReply).toHaveLength(1);
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(completed).toBe(false);
                expect(fixture.events.some(event => event.kind === 'turn-complete')).toBe(false);
            }
            fixture.idle();
            await completion;
            expect(completionError).toBeUndefined();
            if (ordering === 'idle-before-response') {
                expect(fixture.counters().completedResponses).toBe(0);
                fixture.releaseResponse();
            }
            await expect.poll(() => fixture.counters().completedResponses).toBe(1);
            expect(fixture.settlements.filter(outcome => outcome.kind === 'accepted')).toHaveLength(1);
            expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'turn-complete', turnId }));
        } finally { await fixture.dispose(); }
    });

    it.each(['missing-session', 'foreign-session', 'missing-user'] as const)('keeps %s native inventory unproven', async identity => {
        const fixture = await composeCustody(identity);
        try {
            await fixture.open();
            const sent = fixture.host.sendTurnPrompt(prompt, { localId: inputId, turnId, userMessageSeq: 41 })
                .then(() => null, error => error);
            await fixture.committed;
            const reads = fixture.counters().historyReads;
            fixture.emitCommit();
            await expect.poll(() => fixture.counters().historyReads).toBeGreaterThan(reads);
            expect(fixture.settlements.some(outcome => outcome.kind === 'accepted')).toBe(false);
            await fixture.finishAssistantWhileBusy();
            fixture.releaseResponse();
            expect(await sent).toBeInstanceOf(Error);
            expect(fixture.settlements).toContainEqual(expect.objectContaining({
                kind: 'effect_may_have_occurred', localId: inputId,
            }));
            expect(fixture.settlements.some(outcome => outcome.kind === 'accepted')).toBe(false);
        } finally { await fixture.dispose(); }
    });

    it('keeps dispatched input custody unknown when cancellation precedes proven native identity', async () => {
        const fixture = await composeCustody('missing-session');
        try {
            await fixture.open();
            const sent = fixture.host.sendTurnPrompt(prompt, { localId: inputId, turnId, userMessageSeq: 41 })
                .then(() => null, error => error);
            await fixture.committed;
            const reads = fixture.counters().historyReads;
            fixture.emitCommit();
            await expect.poll(() => fixture.counters().historyReads).toBeGreaterThan(reads);
            if (!fixture.native.cancel) throw new Error('Expected public native cancellation');
            await expect(fixture.native.cancel({ turnId, reason: 'user' })).resolves.toMatchObject({ status: 'requested' });
            expect(await sent).toBeInstanceOf(Error);
            expect(fixture.settlements).toContainEqual(expect.objectContaining({
                kind: 'effect_may_have_occurred', localId: inputId,
            }));
            expect(fixture.settlements.some(outcome => outcome.kind === 'accepted' || outcome.kind === 'rejected_before_effect')).toBe(false);
            expect(fixture.counters()).toMatchObject({ promptRequests: 1, completedResponses: 0 });
        } finally { await fixture.dispose(); }
    });
});
