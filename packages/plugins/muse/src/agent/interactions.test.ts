import { deriveActivitySummaryFromAgentState } from '@/api/session/deriveActivitySummaryFromAgentState';
import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { readMuseRecord } from './events.js';

// The shared fixture owns native-process and Home network boundaries.

/** Fake authenticated Home delivery is the network boundary; the real Session
 * codec, actor parser, pending owner and permission application remain active. */
async function invokeHomeRpc(
    fixture: Awaited<ReturnType<typeof createAdmittedMuseSessionFixture>>,
    method: string,
    params: unknown,
) {
    return await fixture.run(() => fixture.host.rpcHandlerManager.handleRequest({
        method: `${fixture.host.sessionId}:${method}`, params, callerAuthority: 'present_user',
        authorization: { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND,
            sessionId: fixture.host.sessionId,
            actor: { kind: 'accountUser', accountId: 'owner', relationship: 'owner' } },
    }, undefined, 'authenticated_home_socket'));
}

async function expectNativeApprovalApplied(
    fixture: Awaited<ReturnType<typeof createAdmittedMuseSessionFixture>>,
    params: unknown,
) {
    const response = await invokeHomeRpc(fixture, RPC_METHODS.SESSION_PERMISSION_RESPOND, params);
    const audit = await fixture.readAudit();
    expect({ response, decisionCount: audit.decisionCount, released: audit.released })
        .toEqual({ response: undefined, decisionCount: 1, released: true });
}

it('receipts a native approval without applying it, then applies the exact offered abort through the host', async () => {
    const fixture = await createAdmittedMuseSessionFixture({ native: { scenario: 'approval-abort' } });
    const events = createAgentSessionRuntimeHarness();
    try {
        const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
        session.watch(events.recordRuntimeEvent);
        await session.send({ inputIds: ['approval-input'], input: { text: 'Run the controlled write from the retained recording.' },
            delivery: { kind: 'newTurn', turnId: 'approval-turn' } });
        const before = await fixture.waitForAudit(audit => audit.nativeResponseCount > 0);
        expect(before).toMatchObject({ receiptCount: 1, decisionCount: 0, released: false });
        expect(events.canonicalEvents().filter(event => event.kind === 'tool-result' || event.kind === 'turn-complete')).toEqual([]);
        const requestId = 'call_01a1bf8b6e2c72b8bdfdca70e4c64263';
        await vi.waitFor(() => {
            expect(events.canonicalEvents().filter(event => event.kind === 'tool-progress'
                && JSON.stringify(event.progress).includes('"nativeInteraction"'))).toEqual([]);
            expect(fixture.host.getAgentStateSnapshot()?.completedRequests?.[requestId]).toBeUndefined();
            expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId])
            .toMatchObject({ kind: 'permission', nativeChoices: { choices: [
            { id: 'allow_once', decision: 'approved', scope: 'once' },
            { id: 'abort', decision: 'abort', scope: 'once', allowsFeedback: true },
        ] } });
        });
        const pending = fixture.host.getAgentStateSnapshot()?.requests?.[requestId];
        if (!pending?.nativeChoices) throw new Error('Expected the native occurrence in the canonical pending owner');
        const requirementId = pending.nativeChoices.requirementId;
        expect(await invokeHomeRpc(fixture, RPC_METHODS.SESSION_PERMISSION_RESPOND, { id: requestId, approved: false, decision: 'abort',
            nativeChoice: { requirementId, choiceId: 'abort' },
        })).toBeUndefined();
        const after = await fixture.waitForAudit(audit => audit.decisionCount === 1);
        expect(after.released).toBe(true);
        await events.until('turn-complete');
        expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]).toBeUndefined();
        expect(fixture.host.getAgentStateSnapshot()?.completedRequests?.[requestId]).toMatchObject({ decision: 'abort' });
        events.expectExactlyOneTerminalEvent({ turnId: 'approval-turn' });
        await fixture.closeSession();
        const audit = await fixture.readAudit();
        expect(audit.methods.filter(method => method === 'approval/decide')).toHaveLength(1);
        expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
    } finally { events.dispose(); await fixture.dispose(); }
});

it('retains Allow once approval after the native tool and turn complete', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'muse-allow-once-'));
    const recordingPath = join(scratch, 'recording.json');
    // Lifecycle begins with resume; reuse the existing create-handshake composition.
    const lifecycle = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/lifecycle.json', import.meta.url), 'utf8')));
    const advanced = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/advanced.json', import.meta.url), 'utf8')));
    if (!Array.isArray(lifecycle.rows) || !Array.isArray(advanced.rows)) throw new Error('Missing captured native rows');
    const advancedRows = advanced.rows;
    const sessionIdentity = (value: JsonValue | undefined) => readMuseRecord(readMuseRecord(readMuseRecord(readMuseRecord(value).message).result).session).sessionId;
    const sourceId = sessionIdentity(lifecycle.rows[5]);
    const targetId = sessionIdentity(advancedRows[8]);
    if (typeof sourceId !== 'string' || typeof targetId !== 'string') throw new Error('Missing captured Session identity');
    const turnRows: JsonValue[] = JSON.parse(JSON.stringify(lifecycle.rows.slice(12, 49)).replaceAll(sourceId, targetId));
    await writeFile(recordingPath, JSON.stringify({ rows: [0, 1, 2, 6, 7, 8].map(index => advancedRows[index]).concat(turnRows) }));
    const fixture = await createAdmittedMuseSessionFixture({ native: { scenario: 'approval-local-persistent', recordingPath,
        nativePolicyPath: join(scratch, 'policy.json'), decisionAckPath: join(scratch, 'ack') },
        readActiveTurnAdmissionWitness: () => ({ inputId: 'allow-input', turnId: 'allow-turn', userMessageSeq: null, userMessageSeqs: [],
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }) });
    const events = createAgentSessionRuntimeHarness();
    try {
        const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
        session.watch(events.recordRuntimeEvent);
        await session.send({ inputIds: ['allow-input'], input: { text: 'Run the captured harmless command.' },
            delivery: { kind: 'newTurn', turnId: 'allow-turn' } });
        await fixture.waitForAudit(audit => audit.receiptCount === 1);
        const entry = Object.entries(fixture.host.getAgentStateSnapshot()?.requests ?? {})[0];
        const nativeChoices = entry?.[1].nativeChoices;
        if (!entry || !nativeChoices) throw new Error('Expected native approval');
        const [id] = entry;
        expect(deriveActivitySummaryFromAgentState(fixture.host.getAgentStateSnapshot()).pendingPermissionRequestCount).toBe(1);
        const response = invokeHomeRpc(fixture, RPC_METHODS.SESSION_PERMISSION_RESPOND, { id, approved: true, decision: 'approved',
            nativeChoice: { requirementId: nativeChoices.requirementId, choiceId: 'allow_once' } });
        await events.until('turn-complete');
        const cleanup = fixture.permissionHandler.cancelByPluginTurn('happier.agent.muse', 'allow-turn', 'turn completed');
        await writeFile(join(scratch, 'ack'), 'release');
        expect(await response).toBeUndefined();
        await cleanup;
        expect(deriveActivitySummaryFromAgentState(fixture.host.getAgentStateSnapshot()).pendingPermissionRequestCount).toBe(0);
        expect(fixture.host.getAgentStateSnapshot()?.completedRequests?.[id]).toMatchObject({ status: 'approved', decision: 'approved' });
        await fixture.closeSession();
        expect(fixture.host.getAgentStateSnapshot()?.completedRequests?.[id]).toMatchObject({ status: 'approved', decision: 'approved' });
    } finally { events.dispose(); await fixture.dispose(); await rm(scratch, { recursive: true, force: true }); }
});

it('offers host MCP catalog consent and applies its captured native grant exactly once', async () => {
    // Advanced create handshake plus the captured lifecycle allow-once turn.
    // Only the MCP tool identity is schema-derived on that native occurrence.
    // The native process still rejects every choice ID outside its own offer.
    const scratch = await mkdtemp(join(tmpdir(), 'muse-mcp-catalog-choice-'));
    const recordingPath = join(scratch, 'recording.json');
    const recording = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/lifecycle.json', import.meta.url), 'utf8')));
    if (!Array.isArray(recording.rows)) throw new Error('Missing captured native rows');
    const advanced = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/advanced.json', import.meta.url), 'utf8')));
    const advancedRows = advanced.rows;
    if (!Array.isArray(advancedRows)) throw new Error('Missing captured create handshake');
    const sessionIdentity = (value: JsonValue | undefined) => readMuseRecord(readMuseRecord(readMuseRecord(readMuseRecord(value).message).result).session).sessionId;
    const sourceId = sessionIdentity(recording.rows[5]);
    const targetId = sessionIdentity(advancedRows[8]);
    if (typeof sourceId !== 'string' || typeof targetId !== 'string') throw new Error('Missing captured Session identity');
    const turnRows: JsonValue[] = JSON.parse(JSON.stringify(recording.rows.slice(12, 49)).replaceAll(sourceId, targetId));
    await writeFile(recordingPath, JSON.stringify({ rows: [0, 1, 2, 6, 7, 8].map(index => advancedRows[index]).concat(turnRows).map(value => {
        const row = readMuseRecord(value);
        const message = readMuseRecord(row.message);
        return typeof message.method === 'string' && message.method.startsWith('approval/')
            ? { ...row, message: { ...message, params: { ...readMuseRecord(message.params), toolName: 'mcp__probe__pebble', rawArgs: '{}' } } }
            : row;
    }) }));
    const fixture = await createAdmittedMuseSessionFixture({ native: { scenario: 'approval-local-persistent', recordingPath,
            nativePolicyPath: join(scratch, 'unused-native-policy.json') },
        readActiveTurnAdmissionWitness: () => ({ inputId: 'catalog-choice-input', turnId: 'catalog-choice-turn',
            userMessageSeq: null, userMessageSeqs: [], causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
        mcpToolContext: { mcpServerIdentities: { probe: { serverId: 'catalog-probe', serverTitle: 'Probe' } },
            catalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [],
                catalog: McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'catalog-probe', name: 'probe', title: 'Probe',
                    transport: 'stdio', stdio: { command: 'fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
                    tools: { default: 'ask', overrides: {} }, toolsSnapshot: { checkedAt: 1, machineId: 'machine',
                        tools: [{ name: 'pebble', title: 'Pebble', tokens: 1 }] } }], bindings: [] }) } },
    });
    const events = createAgentSessionRuntimeHarness();
    try {
        const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
        session.watch(events.recordRuntimeEvent);
        await session.send({ inputIds: ['catalog-choice-input'], input: { text: 'Apply the retained native grant.' },
            delivery: { kind: 'newTurn', turnId: 'catalog-choice-turn' } });
        await fixture.waitForAudit(audit => audit.receiptCount === 1);
        await vi.waitFor(() => {
            const pending = Object.values(fixture.host.getAgentStateSnapshot()?.requests ?? {}).find(request => request.tool === 'mcp__probe__pebble');
            expect(pending).toMatchObject({ turnId: 'catalog-choice-turn' });
            expect(pending?.nativeChoices?.choices.find(choice => choice.id === 'mcp_always_allow')).toMatchObject({
                scope: 'localPersistent', followUp: { actionId: 'mcp.servers.tools.set',
                    input: { serverId: 'catalog-probe', tools: { pebble: 'allow' } } },
            });
        });
        const entry = Object.entries(fixture.host.getAgentStateSnapshot()?.requests ?? {}).find(([, request]) => request.tool === 'mcp__probe__pebble');
        if (!entry?.[1].nativeChoices) throw new Error('Expected native MCP catalog offer');
        const [id, pending] = entry;
        await expectNativeApprovalApplied(fixture, { id, nativeChoice: {
            requirementId: pending.nativeChoices.requirementId, choiceId: 'mcp_always_allow',
        } });
        await events.until('turn-complete');
        expect(fixture.host.getAgentStateSnapshot()?.completedRequests?.[id]).toMatchObject({
            nativeChoice: { choiceId: 'mcp_always_allow' },
        });
        expect((await fixture.readAudit()).methods.filter(method => method === 'approval/decide')).toHaveLength(1);
    } finally { events.dispose(); await fixture.dispose(); await rm(scratch, { recursive: true, force: true }); }
});

it('renders the replay-72 native request_user_input as an answerable canonical question and continues after answering', async () => {
    // Replay-72 captured the normalized live payload; retain the recorded MSP
    // method/order and substitute its exact question/options into native frames.
    const scratch = await mkdtemp(join(tmpdir(), 'muse-replay72-question-'));
    const recordingPath = join(scratch, 'recording.json');
    const question = { id: 'approve-profile',
        question: 'Created approval request 3520f39a-96af-815c-a079-860bba952396 for browser.profile.create AGENT-REPLAY-72-1110-extension on machine ffd72b3e-40ca-4644-9bd2-46753a01d8cb. Please approve in Happier Inbox, then choose continue. Have you approved?',
        header: 'Approval', selection: { mode: 'single' }, options: [
            { label: 'Approved, continue', description: 'You approved browser.profile.create in Happier Inbox, I will retry/check status.' },
            { label: 'Not approved, stop', description: 'You rejected or want to stop the QA run.' },
        ] };
    const recording = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/advanced.json', import.meta.url), 'utf8')));
    if (!Array.isArray(recording.rows)) throw new Error('Missing captured native rows');
    for (const value of recording.rows) {
        const params = readMuseRecord(readMuseRecord(readMuseRecord(value).message).params);
        if (Array.isArray(params.questions)) Object.assign(params, { questions: [question] });
        if (Array.isArray(params.answers)) Object.assign(params, { answers: [{ questionId: question.id, selectedLabel: 'Approved, continue' }] });
        const item = readMuseRecord(params.item);
        if (item.tool === 'request_user_input') {
            // Native 1.4.15 journal line835 omits selection in tool arguments;
            // its presented pending occurrence resolves this to single choice.
            const { selection: _selection, ...toolQuestion } = question;
            Object.assign(item, { args: JSON.stringify({ questions: [toolQuestion] }) });
        }
    }
    await writeFile(recordingPath, JSON.stringify(recording)
        .replaceAll('call_01a1bf8bb96d71deb3bfccc8c3c8e273', 'call_01a1cea8662f7686bbfd32783e20f1af'));
    const fixture = await createAdmittedMuseSessionFixture({ native: { scenario: 'question-single-choice', recordingPath } });
    const events = createAgentSessionRuntimeHarness();
    try {
        const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
        session.watch(events.recordRuntimeEvent);
        await session.send({ inputIds: ['question-input'], input: { text: 'Ask the retained color question.' },
            delivery: { kind: 'newTurn', turnId: 'question-turn' } });
        const before = await fixture.waitForAudit(audit => audit.nativeResponseCount > 0);
        expect(before).toMatchObject({ receiptCount: 1, decisionCount: 0, released: false });
        const requestId = 'call_01a1cea8662f7686bbfd32783e20f1af';
        await vi.waitFor(() => expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId])
            .toMatchObject({ kind: 'user_action', tool: 'AskUserQuestion', arguments: { questions: [
                { id: question.id, question: question.question, selection: 'single',
                    options: question.options },
            ] } }));
        const pending = fixture.host.getAgentStateSnapshot()?.requests?.[requestId];
        expect(events.canonicalEvents().filter(event => event.kind === 'tool-call' && event.toolCallId === requestId))
            .toMatchObject([{ toolName: 'AskUserQuestion', input: pending?.arguments }]);
        // Constructed from the native 500-character constraint: host accepts
        // the form, while the actual process boundary refuses its application.
        expect(await invokeHomeRpc(fixture, 'session.user_action.answer', { id: requestId, approved: true,
            answers: { 'approve-profile': ['Approved, continue'] }, answerDetails: { 'approve-profile': { note: 'x'.repeat(501) } },
        })).toMatchObject({ error: expect.any(String) });
        expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]).toBeDefined();
        expect(fixture.host.getAgentStateSnapshot()?.completedRequests?.[requestId]).toBeUndefined();
        expect(await fixture.waitForAudit(audit => audit.methods.filter(method => method === 'userInput/answer').length === 1))
            .toMatchObject({ decisionCount: 0, released: false });
        expect(await invokeHomeRpc(fixture, 'session.user_action.answer', { id: requestId, approved: true,
            answers: { 'approve-profile': ['Approved, continue'] },
        })).toBeUndefined();
        expect(await fixture.waitForAudit(audit => audit.decisionCount === 1)).toMatchObject({ released: true });
        await events.until('turn-complete');
        expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]).toBeUndefined();
        expect(fixture.host.getAgentStateSnapshot()?.completedRequests?.[requestId]).toMatchObject({ decision: 'approved', answeredBy: { kind: 'person', accountId: 'owner' },
            structuredAnswersV1: { 'approve-profile': ['Approved, continue'] } });
        events.expectExactlyOneTerminalEvent({ turnId: 'question-turn' });
        await fixture.closeSession();
        const audit = await fixture.readAudit();
        expect(audit.methods.filter(method => method === 'userInput/answer')).toHaveLength(2);
        expect(audit.methods.filter(method => method === 'approval/decide')).toHaveLength(0);
        expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
    } finally { events.dispose(); await fixture.dispose(); await rm(scratch, { recursive: true, force: true }); }
});

it.each([
    { outcome: 'cancelled', answers: [], clarification: null },
    { outcome: 'interrupted', answers: [{ questionId: 'color', selectedLabel: 'Blue', note: 'Confirmed before interrupt' }], clarification: null },
    { outcome: 'clarified', answers: [], clarification: { format: 'text', content: 'I need a different color.' } },
])('retires the native $outcome occurrence without a person answer or remaining answer authority', async (settlement) => {
    // These outcome vectors are schema-derived variations of the retained
    // advanced question; none is claimed as an observed native capture.
    const scratch = await mkdtemp(join(tmpdir(), 'muse-question-retirement-'));
    const nativeNotificationPath = join(scratch, 'native-notification.json');
    const fixture = await createAdmittedMuseSessionFixture({ native: { scenario: 'question-single-choice', nativeNotificationPath } });
    const events = createAgentSessionRuntimeHarness();
    const requestId = 'call_01a1bf8bb96d71deb3bfccc8c3c8e273';
    const toolCallId = 'call_01a1bf8bb96d71deb3bfccc8c3c8e273';
    try {
        const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
        session.watch(events.recordRuntimeEvent);
        await session.send({ inputIds: ['retirement-input'], input: { text: 'Ask the retained color question.' },
            delivery: { kind: 'newTurn', turnId: 'retirement-turn' } });
        await fixture.waitForAudit(audit => audit.receiptCount === 1);
        await vi.waitFor(() => expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId])
            .toMatchObject({ kind: 'user_action', lifetime: 'occurrence' }));
        const questionArguments = fixture.host.getAgentStateSnapshot()?.requests?.[requestId]?.arguments;
        const recording = JSON.parse(await readFile(new URL('./testkit/fixtures/advanced.json', import.meta.url), 'utf8'));
        const observed = recording.rows[61].message;
        const notification = { ...observed, params: { ...observed.params, ...settlement,
            decidedByCommandId: null, reason: 'Native-side outcome from the boundary fixture' } };
        await writeFile(nativeNotificationPath + '.tmp', JSON.stringify(notification));
        await rename(nativeNotificationPath + '.tmp', nativeNotificationPath);
        await vi.waitFor(() => {
            const state = fixture.host.getAgentStateSnapshot();
            expect(state?.requests?.[requestId]).toBeUndefined();
            expect(state?.completedRequests?.[requestId]).toMatchObject({ status: 'canceled', decision: 'abort' });
        });
        const completed = fixture.host.getAgentStateSnapshot()?.completedRequests?.[requestId];
        expect(completed).not.toHaveProperty('answeredBy');
        expect(completed).not.toHaveProperty('structuredAnswersV1');
        expect(completed).not.toHaveProperty('structuredAnswerDetailsV1');
        expect(await invokeHomeRpc(fixture, 'session.user_action.answer', {
            id: requestId, approved: true, answers: { color: ['Blue'] },
        })).toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
        await vi.waitFor(() => expect(events.canonicalEvents()).toContainEqual(expect.objectContaining({
            kind: 'tool-progress', toolCallId,
            progress: expect.objectContaining({ toolName: 'AskUserQuestion',
                rawInput: questionArguments,
                content: [{ type: 'text', text: JSON.stringify({ nativeQuestionSettlement: {
                    ...settlement, reason: notification.params.reason,
                } }) }],
            }),
        })));
        await fixture.closeSession();
        const audit = await fixture.readAudit();
        expect(audit.methods.filter(method => method === 'userInput/answer')).toHaveLength(0);
        expect(audit.methods.filter(method => method === 'approval/decide')).toHaveLength(0);
    } finally { events.dispose(); await fixture.dispose(); await rm(scratch, { recursive: true, force: true }); }
});

it('applies an updated native requirement through the same pending owner and rejects its old stage', async () => {
    // A schema-derived second stage of the captured abort occurrence exercises
    // native stage correlation; the captured abort continuation stays unchanged.
    const scratch = await mkdtemp(join(tmpdir(), 'muse-approval-stage-'));
    const nativeNotificationPath = join(scratch, 'native-notification.json');
    const fixture = await createAdmittedMuseSessionFixture({ native: { scenario: 'approval-abort', nativeNotificationPath } });
    const events = createAgentSessionRuntimeHarness();
    const requestId = 'call_01a1bf8b6e2c72b8bdfdca70e4c64263';
    try {
        const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
        session.watch(events.recordRuntimeEvent);
        await session.send({ inputIds: ['stage-input'], input: { text: 'Run the retained controlled write.' },
            delivery: { kind: 'newTurn', turnId: 'stage-turn' } });
        await fixture.waitForAudit(audit => audit.receiptCount === 1);
        await vi.waitFor(() => expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]?.nativeChoices).toBeDefined());
        const oldRequirementId = fixture.host.getAgentStateSnapshot()!.requests![requestId]!.nativeChoices!.requirementId;
        const recording = JSON.parse(await readFile(new URL('./testkit/fixtures/advanced.json', import.meta.url), 'utf8'));
        const params = recording.rows[21].message.params;
        const requirement = { ...params.currentRequirementId, sourceIndex: 1 };
        const requirementId = JSON.stringify(requirement);
        await writeFile(nativeNotificationPath + '.tmp', JSON.stringify({ jsonrpc: '2.0', method: 'approval/updated',
            params: { ...params, currentRequirementId: requirement } }));
        await rename(nativeNotificationPath + '.tmp', nativeNotificationPath);
        await vi.waitFor(() => expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]?.nativeChoices?.requirementId)
            .toBe(requirementId));
        expect(await invokeHomeRpc(fixture, RPC_METHODS.SESSION_PERMISSION_RESPOND, {
            id: requestId, approved: false, decision: 'abort',
            nativeChoice: { requirementId: oldRequirementId, choiceId: 'abort' },
        })).toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
        expect((await fixture.readAudit()).decisionCount).toBe(0);
        expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]).toBeDefined();
        await expectNativeApprovalApplied(fixture, {
            id: requestId, approved: false, decision: 'abort',
            nativeChoice: { requirementId, choiceId: 'abort' },
        });
        expect(await fixture.waitForAudit(audit => audit.decisionCount === 1)).toMatchObject({ released: true });
        await events.until('turn-complete');
        expect(fixture.host.getAgentStateSnapshot()?.completedRequests?.[requestId]).toMatchObject({
            nativeChoice: { requirementId, choiceId: 'abort' },
        });
        events.expectExactlyOneTerminalEvent({ turnId: 'stage-turn' });
        await fixture.closeSession();
        expect((await fixture.readAudit()).methods.filter(method => method === 'approval/decide')).toHaveLength(1);
    } finally { events.dispose(); await fixture.dispose(); await rm(scratch, { recursive: true, force: true }); }
});

it('leaves a localPersistent rule in the synthetic native policy file across process restart', async () => {
    // The offered choice and wire windows are captured; selecting that alternate
    // choice and persisting it are synthetic native behavior, not vendor proof.
    const scratch = await mkdtemp(join(tmpdir(), 'muse-native-policy-'));
    const recordingPath = join(scratch, 'composed-recording.json');
    const nativePolicyPath = join(scratch, 'native-permissions.json');
    const advanced = JSON.parse(await readFile(new URL('./testkit/fixtures/advanced.json', import.meta.url), 'utf8'));
    const lifecycle = JSON.parse(await readFile(new URL('./testkit/fixtures/lifecycle.json', import.meta.url), 'utf8'));
    const nativeSessionId = advanced.rows[8].message.result.session.sessionId;
    const sourceSessionId = lifecycle.rows[5].message.result.session.sessionId;
    const turnRows = JSON.parse(JSON.stringify(lifecycle.rows.slice(12, 49)).replaceAll(sourceSessionId, nativeSessionId));
    await writeFile(recordingPath, JSON.stringify({ evidence: {
        status: 'SCHEMA_DERIVED_COMPOSITION',
        note: 'Advanced create handshake plus lifecycle allow-once turn; localPersistent application/file/restart are synthetic native behavior.',
    }, rows: [advanced.rows[0], advanced.rows[1], advanced.rows[2], advanced.rows[6], advanced.rows[7], advanced.rows[8], ...turnRows] }));
    let savedPolicy: string | undefined;
    try {
        for (const restarted of [false, true]) {
            const sessionId = restarted ? 'host-muse-policy-restarted' : 'host-muse-policy-initial';
            const fixture = await createAdmittedMuseSessionFixture({ sessionId,
                native: { scenario: 'approval-local-persistent', recordingPath, nativePolicyPath },
                readActiveTurnAdmissionWitness: () => ({ inputId: sessionId + '-input', turnId: sessionId + '-turn',
                    userMessageSeq: null, userMessageSeqs: [], causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
            });
            const events = createAgentSessionRuntimeHarness();
            try {
                const session = await fixture.open({ kind: 'create', sessionId, cwd: process.cwd() });
                session.watch(events.recordRuntimeEvent);
                await session.send({ inputIds: [sessionId + '-input'], input: { text: 'Run the retained controlled native command.' },
                    delivery: { kind: 'newTurn', turnId: sessionId + '-turn' } });
                if (!restarted) {
                    await fixture.waitForAudit(audit => audit.receiptCount === 1);
                    const requestId = lifecycle.rows[22].message.params.toolCallId;
                    await vi.waitFor(() => expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]?.nativeChoices)
                        .toMatchObject({ choices: expect.arrayContaining([{
                            id: 'allow_local_prefix', label: 'Always allow in this workspace: printf NORMAL ...',
                            decision: 'approved_execpolicy_amendment', scope: 'localPersistent',
                            rulePreview: 'Always allow in this workspace: printf NORMAL ...',
                            response: { approved: true, decision: 'approved_execpolicy_amendment' },
                        }]) }));
                    expect(fixture.host.getAgentStateSnapshot()!.requests![requestId]).toMatchObject({ turnId: sessionId + '-turn' });
                    const requirementId = fixture.host.getAgentStateSnapshot()!.requests![requestId]!.nativeChoices!.requirementId;
                    expect(await invokeHomeRpc(fixture, RPC_METHODS.SESSION_PERMISSION_RESPOND, {
                        id: requestId, // Exact r1111c Action payload: choice only, no decision or turn override.
                        nativeChoice: { requirementId, choiceId: 'allow_local_prefix' },
                    })).toBeUndefined();
                    await fixture.waitForAudit(audit => audit.decisionCount === 1);
                    savedPolicy = await readFile(nativePolicyPath, 'utf8');
                    expect(JSON.parse(savedPolicy)).toEqual({ command: lifecycle.rows[22].message.params.subject.command,
                        choiceId: 'allow_local_prefix', scope: 'localPersistent',
                        rulePreview: lifecycle.rows[22].message.params.availableChoices[1].rulePreview });
                }
                await events.until('turn-complete');
                events.expectExactlyOneTerminalEvent({ turnId: sessionId + '-turn' });
                expect(fixture.host.getMetadataSnapshot()?.allowedTools ?? []).toEqual([]);
                await fixture.closeSession();
                expect(await fixture.readAudit()).toMatchObject({ receiptCount: restarted ? 0 : 1,
                    decisionCount: restarted ? 0 : 1, released: true });
                expect(await readFile(nativePolicyPath, 'utf8')).toBe(savedPolicy);
            } finally { events.dispose(); await fixture.dispose(); }
        }
    } finally { await rm(scratch, { recursive: true, force: true }); }
});


it.each([
    { name: 'multiple labels and note', selection: { mode: 'multiple', minSelections: 1, maxSelections: 2 },
        labels: ['Blue', 'Green'], detail: { note: 'Both colors' },
        nativeAnswer: { selectedLabels: ['Blue', 'Green'], note: 'Both colors' } },
    { name: 'free text and note', selection: { mode: 'single' }, labels: [],
        detail: { freeText: 'Amber', note: 'A custom color' },
        nativeAnswer: { freeText: 'Amber', note: 'A custom color' } },
])('preserves native question IDs and $name through the real user-action owner', async vector => {
    // Explicit schema-derived answer modes; no claim of native vendor capture.
    const scratch = await mkdtemp(join(tmpdir(), 'muse-question-shape-'));
    const recordingPath = join(scratch, 'question-recording.json');
    const recording = JSON.parse(await readFile(new URL('./testkit/fixtures/advanced.json', import.meta.url), 'utf8'));
    recording.rows = recording.rows.slice(0, 78);
    const questionId = 'native-color-question';
    const question = { ...recording.rows[55].message.params.questions[0], id: questionId, selection: vector.selection };
    recording.rows[55].message.params.questions = [question];
    recording.rows[58].message.params.questions = [question];
    const answers = [{ questionId, ...vector.nativeAnswer }];
    recording.rows[57].message.params.answers = answers;
    recording.rows[61].message.params.answers = answers;
    for (const row of recording.rows) {
        const item = row.message?.params?.item;
        if (item?.callId === 'call_01a1bf8bb96d71deb3bfccc8c3c8e273') item.args = JSON.stringify({ questions: [question] });
    }
    recording.evidence = { status: 'SCHEMA_DERIVED_VARIATION', note: vector.name };
    await writeFile(recordingPath, JSON.stringify(recording));
    const fixture = await createAdmittedMuseSessionFixture({ native: { scenario: 'question-single-choice', recordingPath } });
    const events = createAgentSessionRuntimeHarness();
    const requestId = 'call_01a1bf8bb96d71deb3bfccc8c3c8e273';
    try {
        const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
        session.watch(events.recordRuntimeEvent);
        await session.send({ inputIds: ['question-shape-input'], input: { text: 'Ask the retained question variation.' },
            delivery: { kind: 'newTurn', turnId: 'question-shape-turn' } });
        await fixture.waitForAudit(audit => audit.receiptCount === 1);
        await vi.waitFor(() => expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId])
            .toMatchObject({ kind: 'user_action', arguments: { questions: [{ id: questionId,
                selection: vector.selection.mode, allowCustom: true, allowNote: true,
                ...(vector.selection.mode === 'multiple' ? { minSelections: 1, maxSelections: 2 } : {}),
            }] } }));
        expect(await invokeHomeRpc(fixture, 'session.user_action.answer', {
            id: requestId, approved: true, answers: { [questionId]: vector.labels },
            answerDetails: { [questionId]: vector.detail },
        })).toBeUndefined();
        expect(await fixture.waitForAudit(audit => audit.decisionCount === 1)).toMatchObject({ released: true });
        await events.until('turn-complete');
        expect(fixture.host.getAgentStateSnapshot()?.completedRequests?.[requestId]).toMatchObject({
            answeredBy: { kind: 'person', accountId: 'owner' },
            structuredAnswersV1: { [questionId]: vector.labels },
        });
        events.expectExactlyOneTerminalEvent({ turnId: 'question-shape-turn' });
        await fixture.closeSession();
        expect((await fixture.readAudit()).methods.filter(method => method === 'userInput/answer')).toHaveLength(1);
    } finally { events.dispose(); await fixture.dispose(); await rm(scratch, { recursive: true, force: true }); }
});


it('keeps a captured child approval actionable after its parent turn completes and preserves the native route', async () => {
    // Exact child-follow capture: parent terminal row27 precedes approval/request row34.
    const fixture = await createAdmittedMuseSessionFixture({ systemRecords: true,
        sessionId: 'host-muse-late-child-approval', native: { scenario: 'approval-late-child' } });
    const events = createAgentSessionRuntimeHarness();
    const requestId = 'call_01a1bf90601e7207b75b60382afaabc2';
    try {
        const session = await fixture.open({ kind: 'create', sessionId: 'host-muse-late-child-approval', cwd: process.cwd() });
        session.watch(events.recordRuntimeEvent);
        await session.send({ inputIds: ['late-child-approval-input'], input: { text: 'Run the retained child approval scenario.' },
            delivery: { kind: 'newTurn', turnId: 'late-child-approval-turn' } });
        expect(await fixture.waitForAudit(audit => audit.receiptCount === 1))
            .toMatchObject({ decisionCount: 0, released: false });
        await events.until('turn-complete');
        events.expectExactlyOneTerminalEvent({ turnId: 'late-child-approval-turn' });
        await vi.waitFor(() => expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]).toMatchObject({
            kind: 'permission', nativeChoices: {
                origin: { sessionId: '57eb5081-f640-7bd6-8b7f-19602770febe',
                    subagentId: '01a1bf90-5807-7400-8dc6-5c1330a65971', subagentLabel: 'printf-child' },
                choices: [{ id: 'allow_once', decision: 'approved', scope: 'once' }, { id: 'abort' }],
            },
        }));
        const pending = fixture.host.getAgentStateSnapshot()?.requests?.[requestId];
        if (!pending?.nativeChoices) throw new Error('Expected the child approval in the canonical pending owner');
        await expectNativeApprovalApplied(fixture, {
            id: requestId, approved: true, decision: 'approved',
            nativeChoice: { requirementId: pending.nativeChoices?.requirementId, choiceId: 'allow_once' },
        });
        // The playback checks the captured parent sessionId on approval/decide,
        // independently of the child sessionId used only for origin presentation.
        expect(await fixture.waitForAudit(audit => audit.decisionCount === 1)).toMatchObject({ released: true });
        expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]).toBeUndefined();
        expect(fixture.host.getAgentStateSnapshot()?.completedRequests?.[requestId]).toMatchObject({ decision: 'approved' });
        events.expectExactlyOneTerminalEvent({ turnId: 'late-child-approval-turn' });
        await fixture.closeSession();
        expect((await fixture.readAudit()).methods.filter(method => method === 'approval/decide')).toHaveLength(1);
    } finally { events.dispose(); await fixture.dispose(); }
});


it('preserves opaque native approval arguments on the canonical generic card', async () => {
    // Schema-derived unknown subject/tool and valid JSON array. The native
    // rawArgs contract is an arbitrary string, described as usually JSON.
    const scratch = await mkdtemp(join(tmpdir(), 'muse-opaque-approval-'));
    const recordingPath = join(scratch, 'opaque-approval.json');
    const recording = JSON.parse(await readFile(new URL('./testkit/fixtures/advanced.json', import.meta.url), 'utf8'));
    const requestId = 'call_01a1bf8b6e2c72b8bdfdca70e4c64263';
    const rawArgs = '["opaque",null,17]';
    const subject = { kind: 'futureApprovalSubject', toolName: 'future_native_tool' };
    for (const row of recording.rows) {
        const params = row.message?.params;
        if (params?.toolCallId === requestId && ['approval/request', 'approval/requested', 'approval/updated'].includes(row.message.method)) {
            params.rawArgs = rawArgs;
            params.subject = subject;
            params.toolName = 'future_native_tool';
        }
    }
    recording.evidence = { status: 'SCHEMA_DERIVED_VARIATION', note: 'Open generic subject with nonobject JSON rawArgs' };
    await writeFile(recordingPath, JSON.stringify(recording));
    const fixture = await createAdmittedMuseSessionFixture({ native: { scenario: 'approval-abort', recordingPath } });
    const events = createAgentSessionRuntimeHarness();
    try {
        const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
        session.watch(events.recordRuntimeEvent);
        await session.send({ inputIds: ['opaque-approval-input'], input: { text: 'Run the retained opaque approval variation.' },
            delivery: { kind: 'newTurn', turnId: 'opaque-approval-turn' } });
        expect(await fixture.waitForAudit(audit => audit.receiptCount === 1))
            .toMatchObject({ decisionCount: 0, released: false });
        await vi.waitFor(() => expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]).toMatchObject({
            kind: 'permission', tool: 'future_native_tool', arguments: { rawArgs, nativeApproval: subject },
        }));
        const pending = fixture.host.getAgentStateSnapshot()?.requests?.[requestId];
        if (!pending?.nativeChoices) throw new Error('Expected the opaque native approval in the canonical pending owner');
        await expectNativeApprovalApplied(fixture, {
            id: requestId, approved: false, decision: 'abort',
            nativeChoice: { requirementId: pending.nativeChoices?.requirementId, choiceId: 'abort' },
        });
        expect(await fixture.waitForAudit(audit => audit.decisionCount === 1)).toMatchObject({ released: true });
        await events.until('turn-complete');
        events.expectExactlyOneTerminalEvent({ turnId: 'opaque-approval-turn' });
    } finally { events.dispose(); await fixture.dispose(); await rm(scratch, { recursive: true, force: true }); }
});

it('interrupts the owning Muse turn for a pending input through the active-input binding', async () => {
    const fixture = await createAdmittedMuseSessionFixture({ native: { scenario: 'approval-abort' } });
    try {
        const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
        await session.send({ inputIds: ['interrupt-input'], input: { text: 'Run the retained controlled write.' },
            delivery: { kind: 'newTurn', turnId: 'interrupt-turn' } });
        await fixture.waitForAudit(audit => audit.receiptCount === 1);
        const binding = fixture.publications.readActiveInputBinding();
        expect(binding).not.toBeNull();
        expect(await binding!.interruptPendingInputAndRun({ localId: 'queued-input' }))
            .toMatchObject({ ok: true, status: 'interrupted' });
        const audit = await fixture.readAudit();
        expect(audit.commandTargets.find(target => target.method === 'turn/interrupt'))
            .toMatchObject({ sessionId: session.runtimeDescriptorV1!.agent.providerSessionId,
                turnId: expect.any(String) });
    } finally { await fixture.dispose(); }
});


it('keeps each remaining shell requirement answerable after a nonterminal native decision', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'muse-shell-stages-'));
    const recordingPath = join(scratch, 'recording.json');
    // Reuse the create handshake composition of the MCP catalog test above;
    // lifecycle itself begins with resume and cannot serve a create request.
    const lifecycle = JSON.parse(await readFile(new URL('./testkit/fixtures/lifecycle.json', import.meta.url), 'utf8'));
    const advanced = JSON.parse(await readFile(new URL('./testkit/fixtures/advanced.json', import.meta.url), 'utf8'));
    const sourceId = lifecycle.rows[5].message.result.session.sessionId;
    const targetId = advanced.rows[8].message.result.session.sessionId;
    const turnRows = JSON.parse(JSON.stringify(lifecycle.rows.slice(12, 49)).replaceAll(sourceId, targetId));
    const rows = [0, 1, 2, 6, 7, 8].map(index => advanced.rows[index]).concat(turnRows);
    // Field-allowlisted native capture from FIN-DIAG-NATIVE-APPROVED-1113:
    // decide -> updated stage -> accepted ACK -> request, same call identity.
    const wire = JSON.parse(await readFile(new URL('./testkit/fixtures/shell-stage-transition.json', import.meta.url), 'utf8'));
    const observed = wire[0].frame.params;
    const initial = rows.find(row => row.message?.method === 'approval/request').message.params;
    const decision = rows[19].message.params;
    const stageTransition = JSON.parse(JSON.stringify(wire.slice(1))
        .replaceAll(observed.sessionId, decision.sessionId)
        .replaceAll(observed.approvalId, decision.approvalId)
        .replaceAll(observed.commandId, decision.commandId)
        .replaceAll(wire[3].frame.params.toolCallId, initial.toolCallId));
    // The diagnostic allowlist omits display labels; restore harmless fixture labels.
    for (const row of stageTransition) for (const choice of row.frame.params?.availableChoices ?? []) choice.label = choice.choiceId;
    await writeFile(recordingPath, JSON.stringify({ rows, stageTransition }));
    const fixture = await createAdmittedMuseSessionFixture({ native: { scenario: 'approval-stages', recordingPath } });
    const events = createAgentSessionRuntimeHarness();
    try {
        const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
        session.watch(events.recordRuntimeEvent);
        await session.send({ inputIds: ['staged-shell'], input: { text: 'Run the controlled shell.' },
            delivery: { kind: 'newTurn', turnId: 'staged-shell-turn' } });
        await fixture.waitForAudit(audit => audit.receiptCount === 1);
        const pendingId = () => Object.keys(fixture.host.getAgentStateSnapshot()?.requests ?? {})[0];
        await vi.waitFor(() => expect(pendingId()).toBeDefined());
        const id = pendingId()!;
        for (let sourceIndex = 0; sourceIndex < 3; sourceIndex++) {
            await vi.waitFor(() => {
                const offer = fixture.host.getAgentStateSnapshot()?.requests?.[id]?.nativeChoices;
                expect(offer).toBeDefined();
                expect(JSON.parse(offer!.requirementId).sourceIndex).toBe(sourceIndex);
            });
            const offer = fixture.host.getAgentStateSnapshot()!.requests![id]!.nativeChoices!;
            expect(await invokeHomeRpc(fixture, RPC_METHODS.SESSION_PERMISSION_RESPOND, {
                id, approved: true, decision: 'approved',
                nativeChoice: { requirementId: offer.requirementId, choiceId: 'allow_once' },
            })).toBeUndefined();
            if (sourceIndex < 2) expect(events.canonicalEvents().some(event => event.kind === 'turn-complete')).toBe(false);
        }
        await events.until('turn-complete');
        expect(await fixture.readAudit()).toMatchObject({ decisionCount: 3, released: true });
        events.expectExactlyOneTerminalEvent({ turnId: 'staged-shell-turn' });
        await fixture.closeSession();
    } finally { events.dispose(); await fixture.dispose(); await rm(scratch, { recursive: true, force: true }); }
});
