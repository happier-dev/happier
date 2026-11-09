import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.js';

// Only the remote Socket.IO transport is replaced; pending owners and RPC ingress are real.
vi.mock('socket.io-client', () => ({ io: () => createApiSessionSocketStub() }));

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
        const requestId = '01a1bf8b-74ca-78e3-94e2-94aec04f85de';
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
        await fixture.run(() => fixture.host.rpcHandlerManager.invokeLocal('permission', { id: requestId, approved: false, decision: 'abort',
            nativeChoice: { requirementId, choiceId: 'abort' },
        }, { verifiedPeerAuthority: 'present_user' }));
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

it('uses the canonical user-action answer for a native question and keeps the late requested notification settled', async () => {
    const fixture = await createAdmittedMuseSessionFixture({ native: { scenario: 'question-single-choice' } });
    const events = createAgentSessionRuntimeHarness();
    try {
        const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
        session.watch(events.recordRuntimeEvent);
        await session.send({ inputIds: ['question-input'], input: { text: 'Ask the retained color question.' },
            delivery: { kind: 'newTurn', turnId: 'question-turn' } });
        const before = await fixture.waitForAudit(audit => audit.nativeResponseCount > 0);
        expect(before).toMatchObject({ receiptCount: 1, decisionCount: 0, released: false });
        const requestId = '01a1bf8b-bc54-7a10-a15f-b5d8c6dec069';
        await vi.waitFor(() => expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId])
            .toMatchObject({ kind: 'user_action', tool: 'AskUserQuestion', arguments: { questions: [
                { id: 'color', question: 'Which color do you prefer?', selection: 'single',
                    options: [{ label: 'Blue' }, { label: 'Green' }] },
            ] } }));
        // Constructed from the native 500-character constraint: host accepts
        // the form, while the actual process boundary refuses its application.
        await expect(fixture.run(() => fixture.host.rpcHandlerManager.invokeLocal('session.user_action.answer', { id: requestId, approved: true,
            answers: { color: ['Blue'] }, answerDetails: { color: { note: 'x'.repeat(501) } },
        }, { verifiedPeerAuthority: 'present_user' }))).rejects.toThrow();
        expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]).toBeDefined();
        expect(fixture.host.getAgentStateSnapshot()?.completedRequests?.[requestId]).toBeUndefined();
        expect(await fixture.waitForAudit(audit => audit.methods.filter(method => method === 'userInput/answer').length === 1))
            .toMatchObject({ decisionCount: 0, released: false });
        await fixture.run(() => fixture.host.rpcHandlerManager.invokeLocal('session.user_action.answer', { id: requestId, approved: true,
            answers: { color: ['Blue'] },
        }, { verifiedPeerAuthority: 'present_user' }));
        expect(await fixture.waitForAudit(audit => audit.decisionCount === 1)).toMatchObject({ released: true });
        await events.until('turn-complete');
        expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]).toBeUndefined();
        expect(fixture.host.getAgentStateSnapshot()?.completedRequests?.[requestId]).toMatchObject({ decision: 'approved',
            structuredAnswersV1: { color: ['Blue'] } });
        events.expectExactlyOneTerminalEvent({ turnId: 'question-turn' });
        await fixture.closeSession();
        const audit = await fixture.readAudit();
        expect(audit.methods.filter(method => method === 'userInput/answer')).toHaveLength(2);
        expect(audit.methods.filter(method => method === 'approval/decide')).toHaveLength(0);
        expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
    } finally { events.dispose(); await fixture.dispose(); }
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
    const requestId = '01a1bf8b-bc54-7a10-a15f-b5d8c6dec069';
    const toolCallId = 'call_01a1bf8bb96d71deb3bfccc8c3c8e273';
    try {
        const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
        session.watch(events.recordRuntimeEvent);
        await session.send({ inputIds: ['retirement-input'], input: { text: 'Ask the retained color question.' },
            delivery: { kind: 'newTurn', turnId: 'retirement-turn' } });
        await fixture.waitForAudit(audit => audit.receiptCount === 1);
        await vi.waitFor(() => expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId])
            .toMatchObject({ kind: 'user_action', lifetime: 'occurrence' }));
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
        expect(await fixture.run(() => fixture.host.rpcHandlerManager.invokeLocal('session.user_action.answer', {
            id: requestId, approved: true, answers: { color: ['Blue'] },
        }, { verifiedPeerAuthority: 'present_user' }))).toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
        await vi.waitFor(() => expect(events.canonicalEvents()).toContainEqual(expect.objectContaining({
            kind: 'tool-progress', toolCallId,
            progress: expect.objectContaining({ toolName: 'request_user_input',
                rawInput: JSON.parse(recording.rows[53].message.params.item.args),
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
    const requestId = '01a1bf8b-74ca-78e3-94e2-94aec04f85de';
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
        expect(await fixture.run(() => fixture.host.rpcHandlerManager.invokeLocal('permission', {
            id: requestId, approved: false, decision: 'abort',
            nativeChoice: { requirementId: oldRequirementId, choiceId: 'abort' },
        }, { verifiedPeerAuthority: 'present_user' }))).toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
        expect((await fixture.readAudit()).decisionCount).toBe(0);
        expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]).toBeDefined();
        await fixture.run(() => fixture.host.rpcHandlerManager.invokeLocal('permission', {
            id: requestId, approved: false, decision: 'abort',
            nativeChoice: { requirementId, choiceId: 'abort' },
        }, { verifiedPeerAuthority: 'present_user' }));
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
                native: { scenario: 'approval-local-persistent', recordingPath, nativePolicyPath } });
            const events = createAgentSessionRuntimeHarness();
            try {
                const session = await fixture.open({ kind: 'create', sessionId, cwd: process.cwd() });
                session.watch(events.recordRuntimeEvent);
                await session.send({ inputIds: [sessionId + '-input'], input: { text: 'Run the retained controlled native command.' },
                    delivery: { kind: 'newTurn', turnId: sessionId + '-turn' } });
                if (!restarted) {
                    await fixture.waitForAudit(audit => audit.receiptCount === 1);
                    const requestId = lifecycle.rows[22].message.params.approvalId;
                    await vi.waitFor(() => expect(fixture.host.getAgentStateSnapshot()?.requests?.[requestId]?.nativeChoices)
                        .toMatchObject({ choices: expect.arrayContaining([{
                            id: 'allow_local_prefix', label: 'Always allow in this workspace: printf NORMAL ...',
                            decision: 'approved_execpolicy_amendment', scope: 'localPersistent',
                            rulePreview: 'Always allow in this workspace: printf NORMAL ...',
                            response: { approved: true, decision: 'approved_execpolicy_amendment' },
                        }]) }));
                    const requirementId = fixture.host.getAgentStateSnapshot()!.requests![requestId]!.nativeChoices!.requirementId;
                    await fixture.run(() => fixture.host.rpcHandlerManager.invokeLocal('permission', {
                        id: requestId, approved: true, decision: 'approved_execpolicy_amendment',
                        nativeChoice: { requirementId, choiceId: 'allow_local_prefix' },
                    }, { verifiedPeerAuthority: 'present_user' }));
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
