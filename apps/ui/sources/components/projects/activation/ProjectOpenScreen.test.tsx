import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { OpenProjectInputV1Schema, type OpenProjectInputV1, type OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { ProjectOpenControllerOptions } from './projectOpenController';
import type { SessionDraftRepositoryStorage } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { SessionDraftRecordV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { SessionDraftMutateRequestV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ActionOperationMachineTransportV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { createApiSessionDraftsTransport } from '@/sync/api/account/apiSessionDrafts';
import { buildProjectOpenDraft, projectOpenChoiceStateFromDraft, resolveProjectOpenDefaults } from './projectOpenChoices';

installApprovalCommonModuleMocks({ modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: false }).module });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
type OpenEffect = (input: OpenProjectInputV1) => Promise<OpenProjectResultV1>;
let openEffect: OpenEffect;
let operationTransport: ActionOperationMachineTransportV1 | undefined;
let account: LazyActionAccountContext;
let homeId: string;
installSessionActionRpcBoundary((request, context) => {
    const prefix = 'machine:';
    if (!request.method.startsWith(prefix) || !operationTransport) throw new Error(`Unexpected Project RPC: ${request.method}`);
    return operationTransport({ serverId: 'srv_project_home', machineId: 'machine', method: request.method.slice(prefix.length),
        payload: request.params, signal: context.signal });
});
const [{ createProjectOpenController }, { createDefaultActionExecutor }, { captureLazyActionAccountContext },
    { createSessionDraftRepository }, { createSessionDraftCipher }] = await Promise.all([
    import('./projectOpenController'), import('@/sync/ops/actions/defaultActionExecutor'),
    import('@/sync/ops/actions/actionAccountContext'), import('@/sync/ops/sessionDrafts/sessionDraftRepository'),
    import('@/sync/encryption/sessionDraftEncryption'),
]);
await loadSyncSingletonForTests();
beforeEach(async () => {
    await homes.reset();
    await loadSyncSingletonForTests();
    openEffect = async () => { throw new Error('Unexpected Project Open effect'); };
    operationTransport = undefined;
    homeId = await homes.addHome({ name: 'Project Open', serverUrl: 'https://home.test', serverIdentityId: 'srv_project_home',
        accountId: 'account', currentAccount: true });
    account = await captureLazyActionAccountContext(homeId);
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://home.test', serverIdentityId: 'srv_project_home',
        accountId: 'account', machineId: 'machine', actionId: 'projects.open', tokenEpoch: 0,
        execute: input => openEffect(OpenProjectInputV1Schema.parse(input)) });
    for (const path of ['/v1/machines', '/v1/machines/read-batch', '/v1/machines/machine',
        '/v1/actions/projects.open/execution-authorization', '/v1/actions/projects.open']) {
        homes.answer(homeId, path, { select: async (_input, request) => {
            const response = await boundary.handle(new URL(request.url), request.init);
            if (!response) throw new Error(`Unexpected Project HTTP boundary: ${path}`);
            return { status: response.status, body: await response.json() };
        } });
    }
});
afterEach(async () => { await homes.reset(); });
const folder: OpenProjectInputV1 = { serverId: 'srv_project_home', machineId: 'machine', source: { kind: 'folder', path: '/repo' }, materialization: { kind: 'attach' } };
const opened: OpenProjectResultV1 = { kind: 'opened', workspace: { serverId: 'srv_project_home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/repo' }, directory: '/repo', setup: 'approvalRequired' };
function draftRepository(storage?: SessionDraftRepositoryStorage) {
    const values = new Map<string, string>();
    let sequence = 100;
    let row: SessionDraftRecordV2 | null = null;
    return createSessionDraftRepository({ storage: storage ?? { getString: key => values.get(key), getAllKeys: () => [...values.keys()], set: (key, value) => values.set(key, value), delete: key => values.delete(key) },
        randomUUID: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
        cipher: createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => { throw new Error('Open has no Session'); }, randomBytes: size => new Uint8Array(size) }),
        scope: { serverId: 'srv_project_home', accountId: 'account' }, syncEnabled: true,
        // The authenticated draft HTTP row/CAS is the boundary, not repository logic.
        transport: createApiSessionDraftsTransport({ request: async (path, init) => {
            let response: unknown;
            if (path === '/v2/account/session-drafts/read') response = row
                ? { status: row.content ? 'present' : 'deleted', record: row } : { status: 'absent' };
            else if (path === '/v2/account/session-drafts/list') response = { items: row ? [row] : [] };
            else if (path === '/v2/account/session-drafts/mutate') {
                const request = SessionDraftMutateRequestV2Schema.parse(JSON.parse(String(init?.body)));
                if (request.expectedRevision !== (row?.revision ?? 'absent')) response = { status: 'conflict', current: row ?? { status: 'absent' } };
                else {
                    row = { address: request.address, revision: (row?.revision ?? -1) + 1, content: request.content, createdAt: 1, updatedAt: 2 };
                    response = { status: 'updated', record: row };
                }
            } else throw new Error(`Unexpected draft HTTP path: ${path}`);
            return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
        } }) });
}
function harness(transport: OpenEffect, repository = draftRepository(),
    onOpened?: ProjectOpenControllerOptions['onOpened'], operationRead?: ActionOperationMachineTransportV1) {
    const navigation: unknown[] = [];
    // Only Home HTTP/native effect and Socket.IO replies vary; the bound UI executor stays real.
    openEffect = transport;
    operationTransport = operationRead;
    const executor = createDefaultActionExecutor();
    return { navigation, controller: createProjectOpenController({ executor, initialDraft: folder,
        repository, scope: { serverId: 'srv_project_home', accountId: 'account' }, draftId: '00000000-0000-4000-8000-000000000050',
        captureLifetime: () => account.accountLifetime, onOpened: onOpened ?? (result => { navigation.push(result); }) }) };
}
function delayedTransport() {
    let resolve!: (result: OpenProjectResultV1) => void;
    let begin!: () => void;
    const started = new Promise<void>(done => { begin = done; });
    const transport: OpenEffect = async () => {
        const pending = new Promise<OpenProjectResultV1>(done => { resolve = done; });
        begin();
        return pending;
    };
    return { transport, started, resolve: (result: OpenProjectResultV1) => resolve(result) };
}
describe('Project Open screen behavior', () => {
    it('publishes one changed draft and no equal writes through the repository', () => {
        const repository = draftRepository();
        const { controller } = harness(async () => opened, repository);
        let publications = 0;
        const unsubscribe = controller.subscribe(() => { publications += 1; });
        publications = 0;
        try {
            const next = { ...folder, source: { kind: 'folder' as const, path: '/next' } };
            controller.setDraft(next);
            expect.soft(publications).toBe(1);
            expect(controller.getSnapshot().draft).toEqual(next);
            const settled = controller.getSnapshot();
            publications = 0;
            controller.setDraft({ ...next });
            expect.soft(publications).toBe(0);
            expect.soft(controller.getSnapshot()).toBe(settled);

            repository.writeProjectOpenDraft({ scope: { serverId: 'srv_project_home', accountId: 'account' },
                draftId: '00000000-0000-4000-8000-000000000050', patch: { selection: folder } });
            expect(controller.getSnapshot().draft).toEqual(folder);
            expect.soft(publications).toBe(1);
        } finally { unsubscribe(); controller.dispose(); }
    });

    it('keeps unsubscribed draft writes current without replacing equal snapshots', () => {
        const { controller } = harness(async () => opened);
        try {
            const next = { ...folder, source: { kind: 'folder' as const, path: '/next' } };
            controller.setDraft(next);
            expect(controller.getSnapshot().draft).toEqual(next);
            const settled = controller.getSnapshot();
            controller.setDraft({ ...next });
            expect(controller.getSnapshot()).toBe(settled);
        } finally { controller.dispose(); }
    });

    it('flushes a fresh folder Use existing draft before admitting Open once', async () => {
        const durable = new Map<string, string>();
        const persistence = createSessionDraftPersistenceStorage({
            legacy: { getAllKeys: () => [], getString: () => undefined, delete: () => {} },
            records: {
                list: async () => new Map(durable), read: async key => durable.get(key),
                updateMany: async (keys, update) => {
                    const next = update(new Map(keys.map((key) => [key, durable.get(key)])));
                    for (const [key, value] of next.values) {
                        if (value === undefined) durable.delete(key);
                        else durable.set(key, value);
                    }
                    return next.result;
                },
            },
        });
        await persistence.prepare();
        const repository = draftRepository(persistence);
        const requests: OpenProjectInputV1[] = [];
        const scope = { serverId: 'srv_project_home', accountId: 'account' };
        const address = { kind: 'projectOpen', draftId: '00000000-0000-4000-8000-000000000050' } as const;
        const { controller, navigation } = harness(async input => {
            expect(repository.getSessionDraftSnapshot(scope, address)?.status).toBe('clean');
            requests.push(input);
            return opened;
        }, repository);
        const choice = projectOpenChoiceStateFromDraft({ serverId: scope.serverId }, [], '/home/happier');
        const selected = { ...choice, machineId: 'machine', subject: { kind: 'folder' as const, path: '/repo' } };
        controller.setDraft(buildProjectOpenDraft({ ...selected, ...resolveProjectOpenDefaults(selected) }));
        await controller.submit();
        expect(controller.getSnapshot().result).toEqual(opened);
        expect(requests).toEqual([folder]);
        expect(navigation).toEqual([opened]);
        expect(durable.size).toBe(1);
        controller.dispose();
    });
    it('retains a typed throttle and retry instant without replay, allowing a new explicit Open', async () => {
        let effects = 0;
        const refusal = { kind: 'refused', code: 'REMOTE_RATE_LIMITED', retryNotBeforeMs: 1900000000000,
            remediation: { kind: 'retry', action: 'connect_github' } } as const;
        const { controller, navigation } = harness(async () => { effects += 1; return effects === 1 ? refusal : opened; });
        await controller.submit();
        expect(controller.getSnapshot()).toMatchObject({ pending: false, draft: folder, result: refusal, canCheck: false });
        expect(effects).toBe(1);
        expect(navigation).toEqual([]);
        await controller.submit();
        expect(effects).toBe(2);
        expect(navigation).toEqual([opened]);
    });
    it.each([opened, { kind: 'refused', code: 'invalid_directory' }, { kind: 'outcomeUnknown', operationId: 'original-attempt' }] as const)
        ('checks the original attempt without replaying Open (%j)', async settlement => {
        let effects = 0;
        const requests: unknown[] = [];
        const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'original-attempt', revision: 3,
            actionId: 'projects.open', state: 'succeeded', scope: { accountId: 'account', machineId: 'machine' },
            title: 'Open a project', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported', result: settlement };
        const repository = draftRepository();
        const { controller, navigation } = harness(async () => { effects += 1; return { kind: 'outcomeUnknown', operationId: 'original-attempt' }; },
            repository, undefined, async request => { requests.push(request); return { kind: 'found', operation }; });
        await controller.submit();
        expect(controller.getSnapshot()).toMatchObject({ canCheck: true });
        await controller.check();
        expect(requests).toEqual([expect.objectContaining({ serverId: 'srv_project_home', machineId: 'machine',
            method: 'actionOperation.get.v2', payload: { operationId: 'original-attempt' } })]);
        expect(effects).toBe(1);
        expect(controller.getSnapshot().result).toEqual(settlement);
        expect(navigation).toEqual(settlement.kind === 'opened' ? [opened] : []);
        if (settlement.kind === 'outcomeUnknown') {
            await controller.submit();
            expect(effects).toBe(1);
        } else {
            expect(repository.getSessionDraftSnapshot({ serverId: 'srv_project_home', accountId: 'account' },
                { kind: 'projectOpen', draftId: '00000000-0000-4000-8000-000000000050' })?.document)
                .toMatchObject({ uncertainInputs: { value: [] } });
        }
    });
    it('keeps unknown evidence when no original handle or no original observation is available', async () => {
        let reads = 0;
        const operationRead: ActionOperationMachineTransportV1 = async () => { reads += 1; return { kind: 'not_found' }; };
        const withoutHandle = harness(async () => ({ kind: 'outcomeUnknown' }), draftRepository(), undefined, operationRead);
        await withoutHandle.controller.submit();
        expect(withoutHandle.controller.getSnapshot()).toMatchObject({ canCheck: false });
        await withoutHandle.controller.check();
        expect(reads).toBe(0);
        const retained = harness(async () => ({ kind: 'outcomeUnknown', operationId: 'original-attempt' }), draftRepository(), undefined, operationRead);
        await retained.controller.submit();
        retained.controller.setDraft({ ...folder, machineId: 'another-machine' });
        await retained.controller.check();
        expect(reads).toBe(1);
        expect(retained.controller.getSnapshot().result).toEqual({ kind: 'outcomeUnknown', operationId: 'original-attempt' });
        expect(retained.navigation).toEqual([]);
    });
    it.each(['retired', 'mismatched', 'edited'] as const)('coalesces Check and rejects a %s observation without clearing the original fence', async kind => {
        let release!: (value: unknown) => void;
        let begin!: () => void;
        const started = new Promise<void>(resolve => { begin = resolve; });
        let reads = 0;
        const { controller, navigation } = harness(async () => ({ kind: 'outcomeUnknown', operationId: 'original-attempt' }), draftRepository(),
            undefined, async () => {
                reads += 1; begin(); return await new Promise(resolve => { release = resolve; });
            });
        await controller.submit();
        const first = controller.check();
        const second = controller.check();
        await started;
        if (kind === 'retired') controller.cancel();
        if (kind === 'edited') controller.setDraft({ ...folder, machineId: 'another-machine' });
        release({ kind: 'found', operation: { version: 1, operationId: kind !== 'mismatched' ? 'original-attempt' : 'other-attempt', revision: 3,
            actionId: 'projects.open', state: 'succeeded', scope: { accountId: kind !== 'mismatched' ? 'account' : 'other-account', machineId: 'machine' },
            title: 'Open a project', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported', result: opened } });
        await Promise.all([first, second]);
        expect(reads).toBe(1);
        expect(navigation).toEqual([]);
        expect(controller.getSnapshot()).toMatchObject({ pending: false, checking: false });
        expect(controller.getSnapshot().result).toEqual({ kind: 'outcomeUnknown', operationId: 'original-attempt' });
        await controller.submit();
        expect(controller.getSnapshot().result).toEqual({ kind: 'outcomeUnknown', operationId: 'original-attempt' });
    });
    it('observes a retained original target after edits without focusing it over the new selection', async () => {
        const repository = draftRepository();
        let effects = 0;
        const operationRead: ActionOperationMachineTransportV1 = async request => {
            expect(request).toMatchObject({ serverId: 'srv_project_home', machineId: 'machine', payload: { operationId: 'original-attempt' } });
            return { kind: 'found', operation: { version: 1, operationId: 'original-attempt', revision: 3,
                actionId: 'projects.open', state: 'succeeded', scope: { accountId: 'account', machineId: 'machine' },
                title: 'Open a project', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported', result: opened } };
        };
        const first = harness(async () => { effects += 1; return { kind: 'outcomeUnknown', operationId: 'original-attempt' }; },
            repository, undefined, operationRead);
        await first.controller.submit();
        first.controller.dispose();
        const retained = harness(async () => { effects += 1; return opened; }, repository, undefined, operationRead);
        expect(retained.controller.getSnapshot().canCheck).toBe(true);
        retained.controller.setDraft({ ...folder, machineId: 'another-machine' });
        await retained.controller.check();
        expect(effects).toBe(1);
        expect(retained.navigation).toEqual([]);
        expect(retained.controller.getSnapshot()).toMatchObject({ draft: { machineId: 'another-machine' },
            canCheck: false, result: null, retiredAttempt: { input: folder, result: opened } });
    });
    it.each([opened, { kind: 'refused', code: 'source_unavailable' }] as const)('delegates captured Source admission to Open without a UI preflight (%j)', async settlement => {
        const source = { id: 'source', revision: 1, name: 'Original', audience: [], createdByAccountId: 'account',
            repository: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://forge.example' },
                repository: { nameWithOwner: 'group/repo', cloneUrl: 'https://forge.example/group/repo.git' }, protocol: 'https' },
            defaultRef: 'main', subdir: 'packages/app' } satisfies ProjectSourceV1;
        const requests: OpenProjectInputV1[] = [];
        const { controller, navigation } = harness(async input => { requests.push(input); return settlement; });
        const draft: OpenProjectInputV1 = { serverId: 'srv_project_home', machineId: 'machine',
            source: { kind: 'source', id: source.id, revision: source.revision, selector: source.repository, defaultRef: source.defaultRef, subdir: source.subdir },
            ref: 'main', subdir: 'packages/app',
            materialization: { kind: 'clone', destinationParentPath: '/tmp', destinationDirectoryName: 'repo' } };
        controller.setDraft(draft);
        await controller.submit();
        expect(controller.getSnapshot().draft).toEqual(draft);
        expect(homes.requests.filter(request => request.path.startsWith('/v1/projects/sources/'))).toHaveLength(0);
        expect(requests).toEqual([draft]);
        expect(controller.getSnapshot().result).toEqual(settlement);
        expect(navigation).toEqual(settlement.kind === 'opened' ? [opened] : []);
    });
    it('does not seed over an unavailable requested retained identity', async () => {
        const repository = draftRepository();
        let effects = 0;
        openEffect = async () => { effects += 1; return opened; };
        const controller = createProjectOpenController({ repository, scope: { serverId: 'srv_project_home', accountId: 'account' },
            draftId: '00000000-0000-4000-8000-000000000099', seedIfMissing: false,
            captureLifetime: () => account.accountLifetime, executor: createDefaultActionExecutor(),
            onOpened: () => { throw new Error('No retained acknowledgement'); } });
        controller.setDraft(folder);
        await controller.submit();
        expect(effects).toBe(0);
        expect(repository.getSessionDraftSnapshot({ serverId: 'srv_project_home', accountId: 'account' },
            { kind: 'projectOpen', draftId: '00000000-0000-4000-8000-000000000099' })).toBeNull();
    });
    it('keeps choices nonexecuting and opens only an accepted browse address after confirmation', async () => {
        const requests: unknown[] = [];
        const { controller, navigation } = harness(async input => { requests.push(input); return opened; });
        controller.setDraft({ ...folder, ref: 'feature' });
        expect(requests).toEqual([]);
        await controller.submit();
        expect(requests).toEqual([{ ...folder, ref: 'feature' }]);
        expect(navigation).toEqual([opened]);
        expect(controller.getSnapshot()).toMatchObject({ pending: false, result: opened });
        await controller.submit();
        expect(requests).toHaveLength(1);
        expect(navigation).toEqual([opened, opened]);
    });
    it('retains a retired attempt without publishing its address into the next draft', async () => {
        const delay = delayedTransport();
        const { controller, navigation } = harness(delay.transport);
        const pending = controller.submit();
        await delay.started;
        controller.setDraft({ ...folder, machineId: 'another-machine' });
        delay.resolve(opened);
        await pending;
        expect(navigation).toEqual([]);
        expect(controller.getSnapshot()).toMatchObject({ draft: { machineId: 'another-machine' }, retiredAttempt: { input: folder, result: opened } });
    });
    it('keeps a late unknown handle visible for inspection of the retired original attempt', async () => {
        const delay = delayedTransport();
        const { controller, navigation } = harness(delay.transport);
        const pending = controller.submit();
        await delay.started;
        controller.setDraft({ ...folder, machineId: 'another-machine' });
        delay.resolve({ kind: 'outcomeUnknown', operationId: 'original-attempt' });
        await pending;
        expect(navigation).toEqual([]);
        expect(controller.getSnapshot()).toMatchObject({ pending: false, canCheck: true,
            result: { kind: 'outcomeUnknown', operationId: 'original-attempt' }, uncertainInput: folder });
    });
    it.each(['structured', 'empty'] as const)('keeps Open blocked after a %s Home HTTP 502', async response => {
        const openPath = '/v1/actions/projects.open';
        homes.answer(homeId, `POST ${openPath}`, {
            select: input => {
                if (response === 'empty') return { status: 502 };
                const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(input);
                return { status: 502, body: {
                    error: 'invalid_request',
                    code: 'action_outcome_unknown',
                    requestId: envelope.requestId,
                    diagnostic: { reason: 'daemon_acknowledgement_lost' },
                } };
            },
        });
        const { controller, navigation } = harness(async () => { throw new Error('Unexpected Project Open effect'); });
        try {
            await controller.submit();
            expect(controller.getSnapshot()).toMatchObject({
                pending: false, canCheck: false, result: { kind: 'outcomeUnknown' }, uncertainInput: folder,
            });
            await controller.submit();
            expect(homes.requests.filter(request => request.method === 'POST' && request.path === openPath)).toHaveLength(1);
            expect(navigation).toEqual([]);
        } finally {
            controller.dispose();
        }
    });
    it('retires a focus-only accepted retry when its mounted client leaves during row hydration', async () => {
        const repository = draftRepository();
        const first = harness(async () => opened, repository);
        await first.controller.submit();
        first.controller.cancel();
        let effects = 0;
        let release!: () => void;
        let begin!: () => void;
        const started = new Promise<void>(done => { begin = done; });
        const hydrated = new Promise<void>(done => { release = done; });
        const focused: OpenProjectResultV1[] = [];
        openEffect = async () => { effects += 1; return opened; };
        const controller = createProjectOpenController({ repository, scope: { serverId: 'srv_project_home', accountId: 'account' },
            draftId: '00000000-0000-4000-8000-000000000050', captureLifetime: () => account.accountLifetime,
            executor: createDefaultActionExecutor(),
            // Accepted-row HTTP hydration and client navigation are boundaries, not another Open effect.
            onOpened: async (result, isCurrent) => { begin(); await hydrated; if (isCurrent()) focused.push(result); } });
        const pending = controller.submit();
        await started;
        controller.cancel();
        release();
        await pending;
        expect(effects).toBe(0);
        expect(focused).toEqual([]);
        expect(controller.getSnapshot()).toMatchObject({ pending: false, result: opened });
    });
    it('settles pending after choices change during accepted-row hydration without replacing the new draft', async () => {
        let release!: () => void;
        let begin!: () => void;
        let effects = 0;
        const started = new Promise<void>(done => { begin = done; });
        const hydrated = new Promise<void>(done => { release = done; });
        const focused: OpenProjectResultV1[] = [];
        const { controller } = harness(async () => { effects += 1; return opened; }, draftRepository(),
            async (result, isCurrent) => { begin(); await hydrated; if (isCurrent()) focused.push(result); });
        const pending = controller.submit();
        await started;
        controller.setDraft({ ...folder, machineId: 'another-machine' });
        release();
        await pending;
        expect(controller.getSnapshot()).toMatchObject({ pending: false, draft: { machineId: 'another-machine' }, result: null });
        expect(focused).toEqual([]);
        expect(effects).toBe(1);
    });
    it('keeps the draft and exact result after its Home lifetime retires or is canceled', async () => {
        const delay = delayedTransport();
        const { controller, navigation } = harness(delay.transport);
        const pending = controller.submit();
        await delay.started;
        await homes.addHome({ name: 'Another Home', serverUrl: 'https://another-home.test', serverIdentityId: 'srv_another_project_home',
            accountId: 'account', currentAccount: true });
        controller.cancel();
        delay.resolve(opened);
        await pending;
        expect(navigation).toEqual([]);
        expect(controller.getSnapshot()).toMatchObject({ draft: folder, retiredAttempt: { input: folder, result: opened } });
    });
    it('does not replay unknown acceptance even after a semantically identical draft edit', async () => {
        let effects = 0;
        const { controller, navigation } = harness(async () => { effects += 1; return { kind: 'outcomeUnknown' }; });
        await controller.submit();
        controller.setDraft({ ...folder });
        await controller.submit();
        controller.setDraft({ serverId: 'srv_project_home' });
        await controller.submit();
        expect(controller.getSnapshot().result).toEqual({ kind: 'outcomeUnknown' });
        controller.setDraft({ ...folder });
        controller.cancel();
        expect(effects).toBe(1);
        expect(navigation).toEqual([]);
        expect(controller.getSnapshot().draft).toEqual(folder);
    });
    it('keeps an unknown operation fenced after remount and metadata-only Source revision changes', async () => {
        let effects = 0;
        const repository = draftRepository();
        const source: OpenProjectInputV1 = { ...folder, materialization: { kind: 'clone', destinationParentPath: '/parent', destinationDirectoryName: 'repo' }, source: { kind: 'source', id: 'source', revision: 1,
            selector: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'owner/repo', visibility: 'private' }, protocol: 'https' }, defaultRef: 'main' } };
        if (source.source.kind !== 'source') throw new Error('Expected captured Source fixture');
        const first = harness(async () => { effects += 1; throw new Error('ack lost'); }, repository);
        first.controller.setDraft(source);
        await first.controller.submit();
        first.controller.cancel();
        const second = harness(async () => { effects += 1; return opened; }, repository);
        if (source.source.kind !== 'source') throw new Error('Expected captured Source fixture');
        second.controller.setDraft({ ...source, source: { ...source.source, revision: 2 } });
        await second.controller.submit();
        expect(effects).toBe(1);
        expect(second.navigation).toEqual([]);
        expect(second.controller.getSnapshot().result).toEqual({ kind: 'outcomeUnknown' });
    });
    it('refuses effect admission when the retained draft cannot be durably saved', async () => {
        let effects = 0;
        const values = new Map<string, string>();
        const repository = draftRepository({ getString: key => values.get(key), getAllKeys: () => [...values.keys()], set: (key, value) => values.set(key, value),
            delete: key => values.delete(key), flush: async () => { throw new Error('storage unavailable'); } });
        const { controller } = harness(async () => { effects += 1; return opened; }, repository);
        await controller.submit();
        expect(effects).toBe(0);
        expect(controller.getSnapshot()).toMatchObject({ draft: folder, result: { ok: false, errorCode: 'project_open_draft_unavailable' } });
    });
    it('preserves an offline/refused draft and never focuses an unqualified Machine result', async () => {
        const refused = harness(async () => ({ kind: 'refused', code: 'machine_offline' }));
        await refused.controller.submit();
        expect(refused.controller.getSnapshot()).toMatchObject({ draft: folder, result: { kind: 'refused', code: 'machine_offline' } });
        const mismatch = harness(async () => ({ ...opened, workspace: { ...opened.workspace, machineId: 'foreign' } }));
        await mismatch.controller.submit();
        expect(mismatch.navigation).toEqual([]);
    });
    it('does not navigate when choices retire while accepted-outcome durability is pending', async () => {
        const values = new Map<string, string>();
        let block = false;
        let release!: () => void;
        let begin!: () => void;
        const storing = new Promise<void>(done => { begin = done; });
        const stored = new Promise<void>(done => { release = done; });
        const repository = draftRepository({ getString: key => values.get(key), getAllKeys: () => [...values.keys()], set: (key, value) => values.set(key, value),
            delete: key => values.delete(key), flush: async () => {
                if (!block) return;
                begin();
                await stored;
            } });
        const delay = delayedTransport();
        const { controller, navigation } = harness(delay.transport, repository);
        const pending = controller.submit();
        await delay.started;
        block = true;
        delay.resolve(opened);
        await storing;
        controller.setDraft({ ...folder, machineId: 'another-machine' });
        block = false;
        release();
        await pending;
        expect(navigation).toEqual([]);
        expect(controller.getSnapshot().draft).toMatchObject({ machineId: 'another-machine' });
    });
    it('publishes unknown safely if settlement and its recovery write both lose durable storage', async () => {
        const values = new Map<string, string>();
        let fail = false;
        const repository = draftRepository({ getString: key => values.get(key), getAllKeys: () => [...values.keys()], set: (key, value) => {
            if (fail) throw new Error('Storage unavailable');
            values.set(key, value);
        }, delete: key => values.delete(key) });
        const delay = delayedTransport();
        const { controller, navigation } = harness(delay.transport, repository);
        const pending = controller.submit();
        await delay.started;
        fail = true;
        delay.resolve(opened);
        await expect(pending).resolves.toBeUndefined();
        expect(controller.getSnapshot()).toMatchObject({ pending: false, result: { kind: 'outcomeUnknown' } });
        expect(navigation).toEqual([]);
    });
});
