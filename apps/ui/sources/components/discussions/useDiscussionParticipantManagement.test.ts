import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, answerDiscussionThreadForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { DiscussionInviteRequestV1Schema, DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { DiscussionAccessGrantMutationResponseV1Schema, DiscussionLeaveResponseV1Schema } from '@happier-dev/protocol/discussions/access';
import { DiscussionModelParticipantLaunchV1Schema } from '@happier-dev/protocol/discussions/modelParticipantLaunch';
import { DiscussionErrorResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { resolveSessionModelLabel } from '@/sync/domains/models/modelOptions';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { createDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepository');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { reconcileDiscussionParticipantRoster, useDiscussionParticipantManagement } = await import('./useDiscussionParticipantManagement');
const { getStorage } = await import('@/sync/domains/state/storage');
const initial = getStorage().getState();
beforeEach(async () => { await homes.reset(); });
afterEach(() => { getStorage().setState(initial, true); standardCleanup(); });

it('publishes an Account accessibility change when the participant and grant rows are otherwise unchanged', () => {
    const current = DiscussionParticipantsListResponseV1Schema.parse({ discussionId: 'discussion', ownerAccountId: 'alice',
        access: 'owner', grants: [{ principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'edit',
            createdByAccountId: 'alice', createdAt: 1, display: { name: 'Retained Bob' } }], participants: [],
        accountActors: [{ v: 1, accountId: 'alice', accessibility: 'current', profile: null },
            { v: 1, accountId: 'bob', accessibility: 'current', profile: { name: 'Retained Bob', firstName: 'Retained',
                lastName: 'Bob', username: 'bob', avatarUrl: 'https://management.test/bob.png' } }],
    });
    const former = DiscussionParticipantsListResponseV1Schema.parse({ ...current, accountActors: current.accountActors?.map(actor =>
        actor.accountId === 'bob' ? { ...actor, accessibility: 'former' as const } : actor) });

    expect(reconcileDiscussionParticipantRoster(current, former).accountActors?.find(actor => actor.accountId === 'bob')?.accessibility)
        .toBe('former');
});

async function fixture() {
    const serverId = await homes.addHome({ name: 'Review', serverUrl: 'https://management.test', accountId: 'alice', currentAccount: true });
    const scope = { serverId, accountId: 'alice' };
    const thread = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
    const client = createDiscussionClient({ scope, availability: 'available' });
    const created = await client.create({ creationLocalId: 'creation', messageLocalId: 'first', title: 'Review',
        content: { v: 1, parts: [{ t: 'text', text: 'Ready?' }] } });
    if (created.kind !== 'succeeded') throw new Error(JSON.stringify(created));
    const discussionId = created.value.discussion.id;
    const path = `/v1/discussions/${discussionId}`;
    let ownerAccountId = 'alice';
    let participants: ReturnType<typeof DiscussionParticipantsListResponseV1Schema.parse>['participants'] = [
        { participant: { kind: 'session', sessionId: 'independent-session' }, answerPolicy: 'when_addressed', createdAt: 1 },
    ];
    const roster = () => DiscussionParticipantsListResponseV1Schema.parse({ discussionId, ownerAccountId,
        access: ownerAccountId === 'alice' ? 'owner' : 'admin', grants: [{ principal: { kind: 'account', accountId: 'bob' },
            accessLevel: 'edit', createdByAccountId: 'alice', createdAt: 1, display: { name: 'Bob' } }],
        participants });
    homes.answer(serverId, `${path}/participants`, { select: () => ({ body: roster() }) });
    const repository = createDiscussionRepository({ scope, address: { serverId }, client });
    await repository.refreshDiscussion(discussionId);
    let enabled = true;
    const hook = await renderHook((selectedDiscussionId: string) => {
        const bindings = useServerCredentialAccountScopeBindings([serverId]);
        const accountLifetime = bindings.get(serverId) ?? null;
        return useDiscussionParticipantManagement({ accountLifetime, discussionId: selectedDiscussionId, repository, enabled,
            summary: repository.getSnapshot().threads[selectedDiscussionId]?.summary ?? null });
    }, { initialProps: discussionId });
    await vi.waitFor(() => expect(hook.getCurrent().roster?.discussionId).toBe(discussionId));
    const mutation = (changed = true) => {
        const { participants: _participants, ...grants } = roster();
        return DiscussionAccessGrantMutationResponseV1Schema.parse({ ...grants, changed });
    };
    return { serverId, path, hook, roster, mutation, thread, setOwner: (value: string) => { ownerAccountId = value; },
        setParticipants: (value: typeof participants) => { participants = value; }, setEnabled: (value: boolean) => { enabled = value; } };
}

function modelParticipant(serverId: string, participantSlotId = 'retained-slot', sessionId: string | null = null) {
    const launch = DiscussionModelParticipantLaunchV1Schema.parse({ executionTarget: { serverId, machineId: 'model-machine' },
        directory: { kind: 'path', path: '/workspace' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: 'gpt-6-luna', updatedAtMs: 1 },
            permissionIntent: { value: 'read-only', updatedAtMs: 1 }, options: {} },
    });
    return { participant: { kind: 'model' as const, participantSlotId }, launch,
        sessionId, answerPolicy: 'when_addressed' as const, createdAt: 1 };
}

it('re-admits equal rosters without loading or publishing unchanged participants, while policy, membership and revocation stay current', async () => {
    const f = await fixture();
    const { publishMountedDiscussionChanges } = await import('@/sync/domains/discussions/discussionChangeWatch');
    const rows = Array.from({ length: 1000 }, (_, index) => ({ participant: { kind: 'session' as const, sessionId: `session-${index}` },
        answerPolicy: 'when_addressed' as const, createdAt: 1 }));
    f.setParticipants(rows);
    await act(async () => { await f.hook.getCurrent().refresh(); });
    const baseline = f.hook.getCurrent().roster!;
    let rosterPublications = 0;
    const statuses: string[] = [];
    const unsubscribe = f.hook.subscribe(() => {
        const value = f.hook.getCurrent();
        statuses.push(value.status);
        if (value.roster !== baseline) rosterPublications++;
    });
    const invalidate = (cursor: number, discussionId = baseline.discussionId) => publishMountedDiscussionChanges({
        serverId: f.serverId, accountId: 'alice', changes: [{ kind: 'discussion', entityId: discussionId, cursor, changedAt: cursor, hint: null }],
    });
    const reads = () => homes.requestsFor(`${f.path}/participants`).length;
    try {
        const before = reads();
        await act(async () => invalidate(1, 'other-discussion'));
        expect(reads()).toBe(before);
        for (let cursor = 1; cursor <= 8; cursor++) {
            await act(async () => invalidate(cursor));
            await vi.waitFor(() => expect(reads()).toBe(before + cursor));
            await vi.waitFor(() => expect(f.hook.getCurrent().status).toBe('ready'));
        }
        expect(statuses).not.toContain('loading');
        expect(rosterPublications).toBe(0);
        unsubscribe();
        f.setParticipants([{ ...rows[1]!, answerPolicy: 'reads_only' }, rows[0]!]);
        f.setOwner('bob');
        await act(async () => invalidate(10));
        await vi.waitFor(() => expect(f.hook.getCurrent().roster?.ownerAccountId).toBe('bob'));
        const changed = f.hook.getCurrent().roster!;
        expect(changed.access).toBe('admin');
        expect(changed.participants).toHaveLength(2);
        expect(changed.participants[0]?.answerPolicy).toBe('reads_only');
        expect(changed.participants[1]).toBe(baseline.participants[0]);
        expect(changed.grants).toBe(baseline.grants);
        homes.answer(f.serverId, `${f.path}/participants`, { status: 403,
            body: DiscussionErrorResponseV1Schema.parse({ error: 'discussion_read_denied' }) });
        await act(async () => invalidate(11));
        await vi.waitFor(() => expect(f.hook.getCurrent().status).toBe('error'));
        expect(f.hook.getCurrent().roster).toBeNull();
    } finally {
        unsubscribe();
        await f.hook.unmount();
    }
});

it('does not publish Machine inventory updates to a roster that names no model participant', async () => {
    const f = await fixture();
    let publications = 0;
    const unsubscribe = f.hook.subscribe(() => { publications += 1; });
    try {
        const machine = createMachineFixture({ id: 'inventory-machine' });
        await act(async () => { getStorage().setState({ machineListByServerId: { [f.serverId]: [machine] } }); });
        await act(async () => { getStorage().setState({ machineListByServerId: { [f.serverId]: [{ ...machine,
            metadataVersion: machine.metadataVersion + 1, metadata: { ...machine.metadata!, displayName: 'Renamed' } }] } }); });
        expect(f.hook.getCurrent().modelParticipants).toEqual([]);
        expect(publications).toBe(0);
    } finally {
        unsubscribe();
        await f.hook.unmount();
    }
});

it('does not restore a removed participant when an older invalidation read arrives late', async () => {
    const f = await fixture();
    const { publishMountedDiscussionChanges } = await import('@/sync/domains/discussions/discussionChangeWatch');
    const held = createDeferred<void>();
    const previous = f.roster();
    let reads = 0;
    homes.answer(f.serverId, `${f.path}/participants`, { select: () => ++reads === 1
        ? { body: previous, respondAfter: held.promise } : { body: f.roster() } });
    const invalidate = (cursor: number) => publishMountedDiscussionChanges({ serverId: f.serverId, accountId: 'alice',
        changes: [{ kind: 'discussion', entityId: previous.discussionId, cursor, changedAt: cursor, hint: null }] });
    try {
        await act(async () => invalidate(1));
        await vi.waitFor(() => expect(reads).toBe(1));
        f.setParticipants([]);
        await act(async () => invalidate(2));
        await vi.waitFor(() => expect(f.hook.getCurrent().roster?.participants).toEqual([]));
        expect(reads).toBe(2);
        await act(async () => { held.resolve(); await held.promise; });
        await vi.waitFor(() => expect(f.hook.getCurrent().roster?.participants).toEqual([]));
    } finally {
        held.resolve();
        await f.hook.unmount();
    }
});

it('names a saved model choice without treating an unwitnessed null binding as starting', async () => {
    const f = await fixture();
    const model = modelParticipant(f.serverId);
    const machine = createMachineFixture({ id: 'model-machine', metadata: { ...createMachineFixture().metadata!, host: 'QA workstation' } });
    await act(async () => { getStorage().setState({ machineListByServerId: { [f.serverId]: [machine] } }); });
    f.setParticipants([model]);
    await act(async () => { await f.hook.getCurrent().refresh(); });
    const modelLabel = resolveSessionModelLabel('codex', null, 'gpt-6-luna') ?? 'gpt-6-luna';
    expect(Reflect.get(f.hook.getCurrent(), 'modelParticipants')).toMatchObject([{ participantSlotId: 'retained-slot',
        display: { modelLabel, machineLabel: 'QA workstation', displayLabel: expect.stringContaining(modelLabel) },
        birth: { kind: 'unknown', reason: 'not_observed' }, canRetry: true }]);
    expect(Reflect.get(f.hook.getCurrent(), 'modelParticipants')).toMatchObject([
        { display: { displayLabel: expect.stringContaining('QA workstation') } },
    ]);
    expect(homes.requests.filter(request => /models|capabilities|machine.*detect/.test(request.path))).toEqual([]);
    await f.hook.unmount();
});

it('refreshes an uncertain reserved model and retries its exact row slot without pretending it started', async () => {
    const f = await fixture();
    const model = modelParticipant(f.serverId);
    homes.answer(f.serverId, `POST ${f.path}/participants/invite`, { select: input => {
        const request = DiscussionInviteRequestV1Schema.parse(input);
        expect(request.participant).toMatchObject(model.participant);
        f.setParticipants([model]);
        return { dispatchThenFail: true };
    } });
    await act(async () => { await f.hook.getCurrent().inviteExecutable({ kind: 'model', launch: model.launch },
        { participantSlotId: model.participant.participantSlotId }); });
    expect(Reflect.get(f.hook.getCurrent(), 'modelParticipants')).toMatchObject([{ participantSlotId: 'retained-slot',
        birth: { kind: 'unknown', reason: 'outcome_unknown' }, canRetry: true }]);
    await act(async () => { await f.hook.getCurrent().retry(); });
    expect(homes.requestsFor(`${f.path}/participants/invite`).map(request => request.input)).toEqual([
        { participant: { ...model.participant, launch: model.launch } }, { participant: { ...model.participant, launch: model.launch } },
    ]);
    f.setParticipants([{ ...model, sessionId: 'bound-elsewhere' }]);
    await act(async () => { await f.hook.getCurrent().refresh(); });
    expect(Reflect.get(f.hook.getCurrent(), 'modelParticipants')).toMatchObject([{ birth: { kind: 'started',
        session: { serverId: f.serverId, sessionId: 'bound-elsewhere' } }, canRetry: false }]);
    await f.hook.unmount();
});

it('projects the latest failed model attempt, retires superseded facts and lets a bound roster Session win', async () => {
    const f = await fixture();
    const first = modelParticipant(f.serverId, 'first-slot');
    const second = modelParticipant(f.serverId, 'second-slot');
    homes.answer(f.serverId, `POST ${f.path}/participants/invite`, { select: input => {
        const request = DiscussionInviteRequestV1Schema.parse(input);
        if (request.participant.kind !== 'model') throw new Error('Expected model invitation');
        f.setParticipants([first, second]);
        return { body: { ...f.mutation(), modelParticipant: request.participant.participantSlotId === 'first-slot' ? first : second } };
    } });
    await act(async () => { await f.hook.getCurrent().inviteExecutable({ kind: 'model', launch: first.launch }, { participantSlotId: 'first-slot' }); });
    const firstOperation = f.hook.getCurrent().operation;
    expect(firstOperation.kind).toBe('failed');
    expect(Reflect.get(f.hook.getCurrent(), 'modelParticipants')).toMatchObject([
        { participantSlotId: 'first-slot', birth: { kind: 'failed', errorCode: 'errorCode' in firstOperation ? firstOperation.errorCode : null }, canRetry: true },
        { participantSlotId: 'second-slot', birth: { kind: 'unknown', reason: 'not_observed' } },
    ]);
    await act(async () => { await f.hook.getCurrent().inviteExecutable({ kind: 'model', launch: second.launch }, { participantSlotId: 'second-slot' }); });
    expect(Reflect.get(f.hook.getCurrent(), 'modelParticipants')).toMatchObject([
        { participantSlotId: 'first-slot', birth: { kind: 'unknown', reason: 'not_observed' } },
        { participantSlotId: 'second-slot', birth: { kind: 'failed' } },
    ]);
    // A row retry uses that row's retained launch/slot, not the latest other-row intent.
    await act(async () => { await f.hook.getCurrent().inviteExecutable({ kind: 'model', launch: first.launch }, { participantSlotId: 'first-slot' }); });
    expect(homes.requestsFor(`${f.path}/participants/invite`).map(request => DiscussionInviteRequestV1Schema.parse(request.input).participant))
        .toEqual([first, second, first].map(row => ({ ...row.participant, launch: row.launch })));
    f.setParticipants([{ ...first, sessionId: 'bound-session' }, second]);
    await act(async () => { await f.hook.getCurrent().refresh(); });
    expect(Reflect.get(f.hook.getCurrent(), 'modelParticipants')).toMatchObject([{ birth: { kind: 'started',
        session: { serverId: f.serverId, sessionId: 'bound-session' } }, canRetry: false },
        { participantSlotId: 'second-slot', birth: { kind: 'unknown', reason: 'not_observed' } }]);
    await act(async () => { f.setEnabled(false); await f.hook.rerender(); });
    f.setParticipants([first, second]);
    await act(async () => { f.setEnabled(true); await f.hook.rerender(); });
    await vi.waitFor(() => expect(f.hook.getCurrent().roster?.participants).toHaveLength(2));
    expect(Reflect.get(f.hook.getCurrent(), 'modelParticipants')).toMatchObject([
        { birth: { kind: 'unknown', reason: 'not_observed' } }, { birth: { kind: 'unknown', reason: 'not_observed' } },
    ]);
    await f.hook.unmount();
});

it.each(['account', 'discussion'] as const)('retires local starting evidence when the captured %s changes', async boundary => {
    const f = await fixture();
    const model = modelParticipant(f.serverId);
    f.setParticipants([model]);
    await act(async () => { await f.hook.getCurrent().refresh(); });
    const held = createDeferred<void>();
    homes.answer(f.serverId, `POST ${f.path}/participants/invite`, { respondAfter: held.promise, dispatchThenFail: true });
    let invitation: ReturnType<ReturnType<typeof f.hook.getCurrent>['inviteExecutable']> | undefined;
    await act(async () => { invitation = f.hook.getCurrent().inviteExecutable({ kind: 'model', launch: model.launch },
        { participantSlotId: model.participant.participantSlotId }); });
    try {
        await vi.waitFor(() => expect(homes.requestsFor(`${f.path}/participants/invite`)).toHaveLength(1));
        expect(Reflect.get(f.hook.getCurrent(), 'modelParticipants')).toMatchObject([{ birth: { kind: 'starting' }, canRetry: false }]);
        if (boundary === 'account') await act(async () => { await homes.switchAccount(f.serverId, 'bob', { currentAccount: true }); });
        else await f.hook.rerender('another-discussion');
        held.resolve();
        await act(async () => { await invitation; });
        expect(Reflect.get(f.hook.getCurrent(), 'modelParticipants')).toEqual([]);
        expect(f.hook.getCurrent().operation).toEqual({ kind: 'idle' });
    } finally {
        held.resolve();
        await act(async () => { await invitation; });
        await f.hook.unmount();
    }
});

it('ignores a late retired HTTP rejection after the same Discussion is reopened and another slot is retried', async () => {
    const f = await fixture();
    const first = modelParticipant(f.serverId, 'first-slot');
    const second = modelParticipant(f.serverId, 'second-slot');
    f.setParticipants([first, second]);
    await act(async () => { await f.hook.getCurrent().refresh(); });
    const held = createDeferred<void>();
    // The remote operation outlives local cancellation; only this genuine HTTP
    // boundary ignores AbortSignal, then rejects once the test releases it.
    homes.answer(f.serverId, `POST ${f.path}/participants/invite`, { select: async input => {
        const request = DiscussionInviteRequestV1Schema.parse(input);
        if (request.participant.kind === 'model' && request.participant.participantSlotId === 'first-slot') {
            await held.promise;
            throw new TypeError('Connection lost after cancellation');
        }
        return { dispatchThenFail: true };
    } });
    let retired: ReturnType<ReturnType<typeof f.hook.getCurrent>['inviteExecutable']> | undefined;
    await act(async () => { retired = f.hook.getCurrent().inviteExecutable({ kind: 'model', launch: first.launch }, { participantSlotId: 'first-slot' }); });
    try {
        await vi.waitFor(() => expect(homes.requestsFor(`${f.path}/participants/invite`)).toHaveLength(1));
        f.setEnabled(false); await f.hook.rerender();
        f.setEnabled(true); await f.hook.rerender();
        await act(async () => { await f.hook.getCurrent().inviteExecutable({ kind: 'model', launch: second.launch }, { participantSlotId: 'second-slot' }); });
        held.resolve();
        await act(async () => { await retired; });
        expect(Reflect.get(f.hook.getCurrent(), 'modelParticipants')).toMatchObject([
            { participantSlotId: 'first-slot', birth: { kind: 'unknown', reason: 'not_observed' } },
            { participantSlotId: 'second-slot', birth: { kind: 'unknown', reason: 'outcome_unknown' } },
        ]);
    } finally {
        held.resolve();
        await act(async () => { await retired; });
        await f.hook.unmount();
    }
});

it('offers owner resolution and never leaves after an unknown transfer until its exact retry is acknowledged', async () => {
    const f = await fixture();
    const writes: string[] = [];
    let first = true;
    homes.answer(f.serverId, `PUT ${f.path}/owner`, { select: () => {
        writes.push('transfer'); f.setOwner('bob');
        if (first) { first = false; return { dispatchThenFail: true }; }
        return { body: f.mutation(false) };
    } });
    homes.answer(f.serverId, `POST ${f.path}/leave`, { select: () => {
        writes.push('leave');
        return { body: DiscussionLeaveResponseV1Schema.parse({ discussionId: 'committed-thread', access: null, changed: true }) };
    } });
    await act(async () => { await f.hook.getCurrent().requestLeave(); });
    expect(f.hook.getCurrent().ownerLeave).toMatchObject({ kind: 'transfer_or_archive', canArchive: true,
        transferCandidates: [{ accountId: 'bob' }] });
    expect(writes).toEqual([]);
    await act(async () => { expect(f.hook.getCurrent().cancelLeave()).toBe(true); });
    expect(f.hook.getCurrent().ownerLeave.kind).toBe('closed');
    await act(async () => { await f.hook.getCurrent().requestLeave(); });
    await act(async () => { await f.hook.getCurrent().transferAndLeave('bob'); });
    expect(f.hook.getCurrent().operation).toMatchObject({ kind: 'checking', action: 'transfer', errorCode: 'outcome_unknown' });
    expect(writes).toEqual(['transfer']);
    await act(async () => { expect(f.hook.getCurrent().cancelLeave()).toBe(false); });
    expect(f.hook.getCurrent().ownerLeave.kind).toBe('transfer_or_archive');
    await act(async () => { await f.hook.getCurrent().retry(); });
    expect(writes).toEqual(['transfer', 'transfer', 'leave']);
    expect(f.hook.getCurrent().operation).toMatchObject({ kind: 'succeeded', action: 'leave' });
    expect(homes.requestsFor(`${f.path}/owner`).map(row => row.input)).toEqual([{ accountId: 'bob' }, { accountId: 'bob' }]);
    await f.hook.unmount();
});

it('keeps an ordinary approval request distinct from transfer success and sends no leave', async () => {
    const f = await fixture();
    await homes.requireUiApproval(f.serverId, 'discussion.owner.transfer');
    await act(async () => { await f.hook.getCurrent().requestLeave(); await f.hook.getCurrent().transferAndLeave('bob'); });
    expect(f.hook.getCurrent().operation).toMatchObject({ kind: 'approval_pending', action: 'transfer', artifactId: expect.any(String) });
    expect(homes.requestsFor(`${f.path}/owner`)).toEqual([]);
    expect(homes.requestsFor(`${f.path}/leave`)).toEqual([]);
    f.setEnabled(false); await f.hook.rerender();
    f.setEnabled(true); await f.hook.rerender();
    await vi.waitFor(() => expect(f.hook.getCurrent().roster).not.toBeNull());
    expect(f.hook.getCurrent().operation).toMatchObject({ kind: 'approval_pending', action: 'transfer' });
    expect(f.hook.getCurrent().ownerLeave).toMatchObject({ kind: 'transfer_or_archive', canCancel: false });
    await act(async () => { await f.hook.getCurrent().retry(); });
    expect(homes.requestsFor(`${f.path}/leave`)).toEqual([]);
    await f.hook.unmount();
});

it('retries only Leave after ownership transfer was acknowledged but the Leave response was lost', async () => {
    const f = await fixture();
    const writes: string[] = [];
    let loseLeave = true;
    homes.answer(f.serverId, `PUT ${f.path}/owner`, { select: () => {
        writes.push('transfer'); f.setOwner('bob'); return { body: f.mutation() };
    } });
    homes.answer(f.serverId, `POST ${f.path}/leave`, { select: () => {
        writes.push('leave');
        if (loseLeave) { loseLeave = false; return { dispatchThenFail: true }; }
        return { body: DiscussionLeaveResponseV1Schema.parse({ discussionId: 'committed-thread', access: null, changed: false }) };
    } });
    await act(async () => { await f.hook.getCurrent().transferAndLeave('bob'); });
    expect(f.hook.getCurrent().operation).toMatchObject({ kind: 'checking', action: 'leave' });
    await act(async () => { await f.hook.getCurrent().retry(); });
    expect(writes).toEqual(['transfer', 'leave', 'leave']);
    expect(f.hook.getCurrent().operation).toMatchObject({ kind: 'succeeded', action: 'leave', remainingAccess: null });
    await f.hook.unmount();
});

it('does not treat an unchanged owner as an acknowledged transfer', async () => {
    const f = await fixture();
    homes.answer(f.serverId, `PUT ${f.path}/owner`, { body: f.mutation(false) });
    await act(async () => { await f.hook.getCurrent().requestLeave(); await f.hook.getCurrent().transferAndLeave('alice'); });
    expect(f.hook.getCurrent().operation).toMatchObject({ kind: 'failed', action: 'transfer', errorCode: 'discussion_owner_transfer_required' });
    expect(homes.requestsFor(`${f.path}/leave`)).toEqual([]);
    await f.hook.unmount();
});

it('opens an independently invited Session by captured address and removes only its Discussion binding', async () => {
    const f = await fixture();
    homes.answer(f.serverId, `DELETE ${f.path}/participants`, { body: f.mutation() });
    const participant = f.hook.getCurrent().roster!.participants[0]!;
    expect(f.hook.getCurrent().sessionAddress(participant)).toEqual({ serverId: f.serverId, sessionId: 'independent-session' });
    await act(async () => { await f.hook.getCurrent().remove(participant.participant); });
    expect(f.hook.getCurrent().operation).toMatchObject({ kind: 'succeeded', action: 'remove' });
    expect(homes.requestsFor(`${f.path}/participants`).filter(row => row.input !== null).map(row => row.input))
        .toEqual([{ participant: { kind: 'session', sessionId: 'independent-session' } }]);
    expect(homes.requests.filter(row => /\/sessions\/independent-session/.test(row.path))).toEqual([]);
    await f.hook.unmount();
});

it('archives as an explicit owner alternative without pretending the owner left', async () => {
    const f = await fixture();
    const discussion = f.thread.stored()!.discussion;
    homes.answer(f.serverId, `POST ${f.path}/archive`, { body: { discussion: { ...discussion,
        archivedAt: 2, capabilities: { ...discussion.capabilities, archive: false, restore: true } } } });
    await act(async () => { await f.hook.getCurrent().requestLeave(); await f.hook.getCurrent().archiveInsteadOfLeave(); });
    expect(f.hook.getCurrent().operation).toMatchObject({ kind: 'succeeded', action: 'archive' });
    expect(f.hook.getCurrent().ownerLeave.kind).toBe('closed');
    expect(homes.requestsFor(`${f.path}/leave`)).toEqual([]);
    expect(homes.requestsFor(`${f.path}/owner`)).toEqual([]);
    await f.hook.unmount();
});

it('reports inherited access after a nonowner leaves their direct invitation', async () => {
    const f = await fixture();
    f.setOwner('bob');
    await act(async () => { await f.hook.getCurrent().refresh(); });
    homes.answer(f.serverId, `POST ${f.path}/leave`, { body: DiscussionLeaveResponseV1Schema.parse({
        discussionId: 'committed-thread', access: 'view', changed: true,
    }) });
    await act(async () => { await f.hook.getCurrent().requestLeave(); });
    expect(f.hook.getCurrent().operation).toMatchObject({ kind: 'succeeded', action: 'leave', remainingAccess: 'view' });
    expect(f.hook.getCurrent().roster?.discussionId).toBe('committed-thread');
    expect(f.hook.getCurrent().ownerLeave.kind).toBe('closed');
    await f.hook.unmount();
});

it('keeps one model slot across an uncertain reservation retry and does not acknowledge an unstarted Session', async () => {
    const f = await fixture();
    const { buildExecutableModelParticipantSelectionFromAuthoringDraft } = await import('@/components/sessions/authoring/executableParticipantPicker');
    const { buildNewSessionAuthoringDraftFromTempData } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
    const draft = buildNewSessionAuthoringDraftFromTempData({ prompt: '', directory: '/workspace',
        executionTarget: { kind: 'machine', target: { serverId: f.serverId, machineId: 'unavailable-machine' } },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
    const selection = buildExecutableModelParticipantSelectionFromAuthoringDraft({ draft, permissionMode: 'read-only', configurationUpdatedAtMs: 1 });
    homes.answer(f.serverId, `POST ${f.path}/participants/invite`, { dispatchThenFail: true });
    await act(async () => { await f.hook.getCurrent().inviteExecutable(selection); });
    expect(f.hook.getCurrent().operation).toMatchObject({ kind: 'checking', action: 'invite' });
    await act(async () => { await f.hook.getCurrent().retry(); });
    expect(f.hook.getCurrent().operation).toMatchObject({ kind: 'checking', action: 'invite' });
    const requests = homes.requestsFor(`${f.path}/participants/invite`);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.input).toEqual(requests[1]!.input);
    expect(requests[0]!.input).toMatchObject({ participant: { kind: 'model', participantSlotId: expect.any(String), launch: selection.launch } });
    await f.hook.unmount();
});
