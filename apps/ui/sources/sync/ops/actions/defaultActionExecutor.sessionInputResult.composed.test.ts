import { afterEach, expect, it } from 'vitest';
import { listActionSpecsForSurface } from '@happier-dev/protocol/actions/actionSpecs';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

afterEach(async () => {
    await homes.reset();
    standardCleanup();
});

it('reads the reply projection for the exact original input through the app Action executor', async () => {
    const serverId = await homes.addHome({
        name: 'Session reply Home', serverUrl: 'https://session-reply.test',
        serverIdentityId: 'srv_session_reply', accountId: 'owner', currentAccount: true, accountEncryptionMode: 'plain',
    });
    const sessionId = 'reply-session';
    const localId = 'original-input';
    const reply = { v: 1, status: 'available', progress: {
        v: 1, mode: 'wait', disposition: 'inline', outcome: { kind: 'pass' },
    } };
    homes.answer(serverId, `GET /v2/sessions/${sessionId}`, {
        body: createPlainSessionByIdResponseFixture(createSessionFixture({ id: sessionId, encryptionMode: 'plain' })),
    });
    homes.answer(serverId, `GET /v2/sessions/${sessionId}/messages/by-local-id/${localId}/reply`, { body: reply });
    const result = await createDefaultActionExecutor().execute('session.input.result.get', { sessionId, localId, projection: 'reply' },
        { surface: 'ui', serverId, expectedAccountId: 'owner' });
    expect(result.ok, result.ok ? undefined : result.error).toBe(true);
    expect(result).toMatchObject({ ok: true, result: { ok: true, sessionId, localId, projection: 'reply', reply } });
    expect(homes.requestsFor(`/v2/sessions/${sessionId}/messages/by-local-id/${localId}/reply`)).toHaveLength(1);
});

it('enumerates the UI catalog and probes the Session read guards with schema-valid inputs', async () => {
    const serverId = await homes.addHome({
        name: 'Session Action census', serverUrl: 'https://session-action-census.test',
        serverIdentityId: 'srv_session_action_census', accountId: 'owner', currentAccount: true, accountEncryptionMode: 'plain',
    });
    const sessionId = 'reply-session';
    const inputs: Readonly<Record<string, unknown>> = {
        'session.vendor_plugin_catalog.list': { sessionId },
        'session.skill_catalog.list': { sessionId },
        'session.input.result.get': { sessionId, localId: 'original-input', projection: 'reply' },
        'session.wait.idle': { sessionId, timeoutSeconds: 1 },
        'session.work_state.get': { sessionId },
    };
    const executor = createDefaultActionExecutor();
    const probes = listActionSpecsForSurface('ui').filter(spec => Object.hasOwn(inputs, spec.id));
    expect(probes.map(spec => spec.id).sort()).toEqual(Object.keys(inputs).sort());
    const unsupported: string[] = [];
    for (const spec of probes) {
        const input = spec.inputSchema.parse(inputs[spec.id]);
        const result = await executor.execute(spec.id, input, { surface: 'ui', serverId, expectedAccountId: 'owner' });
        if (!result.ok && result.errorCode === 'unsupported_action') unsupported.push(spec.id);
    }
    // These are routed to their domain owners. Changes to the list surface as a contract diff.
    expect(unsupported.sort()).toEqual([
        'session.skill_catalog.list', 'session.vendor_plugin_catalog.list', 'session.wait.idle',
    ]);
});

it('does not read a reply when Home conceals an unreadable Session', async () => {
    const serverId = await homes.addHome({
        name: 'Session reply Home', serverUrl: 'https://session-reply-denied.test',
        serverIdentityId: 'srv_session_reply_denied', accountId: 'owner', currentAccount: true, accountEncryptionMode: 'plain',
    });
    const sessionId = 'hidden-session';
    const localId = 'original-input';
    homes.answer(serverId, `GET /v2/sessions/${sessionId}`, { status: 404, body: { error: 'Session not found' } });
    const result = await createDefaultActionExecutor().execute('session.input.result.get', { sessionId, localId, projection: 'reply' },
        { surface: 'ui', serverId, expectedAccountId: 'owner' });
    expect(result).toMatchObject({ ok: true, result: { ok: false, code: 'session_not_found' } });
    expect(homes.requestsFor(`/v2/sessions/${sessionId}/messages/by-local-id/${localId}/reply`)).toHaveLength(0);
});
