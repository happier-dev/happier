import { beforeEach, describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import type { OpenProjectInputV1, OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { createProjectOpenController, type ProjectOpenControllerOptions } from './projectOpenController';
import { installFileFindAccountBoundaryMocks } from '@/components/appShell/panes/fileFindSeedTestHelpers';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createSessionDraftRepository, type SessionDraftRepositoryStorage } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { createSessionDraftCipher } from '@/sync/encryption/sessionDraftEncryption';
import type { SessionDraftRecordV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { createProjectSourceActionDeps } from '@/sync/api/projects/projectSourceActions';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

installFileFindAccountBoundaryMocks('home', 'account');
const folder: OpenProjectInputV1 = { serverId: 'home', machineId: 'machine', source: { kind: 'folder', path: '/repo' }, materialization: { kind: 'attach' } };
const opened: OpenProjectResultV1 = { kind: 'opened', workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/repo' }, directory: '/repo', setup: 'approvalRequired' };
function draftRepository(storage?: SessionDraftRepositoryStorage) {
    const values = new Map<string, string>();
    let sequence = 100;
    let row: SessionDraftRecordV2 | null = null;
    return createSessionDraftRepository({ storage: storage ?? { getString: key => values.get(key), set: (key, value) => values.set(key, value), delete: key => values.delete(key) },
        randomUUID: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
        cipher: createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => { throw new Error('Open has no Session'); }, randomBytes: size => new Uint8Array(size) }),
        scope: { serverId: 'home', accountId: 'account' }, syncEnabled: true,
        // The authenticated draft HTTP row/CAS is the boundary, not repository logic.
        transport: { read: async () => row ? { status: row.content ? 'present' : 'deleted', record: row } : { status: 'absent' },
            list: async () => ({ items: row ? [row] : [] }), mutate: async request => {
                if (request.expectedRevision !== (row?.revision ?? 'absent')) return { status: 'conflict', current: row ?? { status: 'absent' } };
                row = { address: request.address, revision: (row?.revision ?? -1) + 1, content: request.content, createdAt: 1, updatedAt: 2 };
                return { status: 'updated', record: row };
            } } });
}
function harness(transport: NonNullable<ActionExecutorDeps['projectsOpen']>, repository = draftRepository(),
    onOpened?: ProjectOpenControllerOptions['onOpened'], sourceRead?: ActionExecutorDeps['projectSourcesRead'],
    operationRead?: ActionExecutorDeps['actionOperationAction']) {
    const navigation: unknown[] = [];
    const executor = createActionExecutor({
        // Authenticated Machine RPC is the boundary; Action admission stays real.
        projectsOpen: transport,
        ...(sourceRead ? { projectSourcesRead: sourceRead } : {}),
        ...(operationRead ? { actionOperationAction: operationRead } : {}),
        sessionSpawnNew: async () => { throw new Error('Open cannot start a Session'); },
        composerIngress: async () => { throw new Error('Open cannot submit a composer'); },
    } as unknown as ActionExecutorDeps);
    return { navigation, controller: createProjectOpenController({ executor, initialDraft: folder,
        repository, scope: { serverId: 'home', accountId: 'account' }, draftId: '00000000-0000-4000-8000-000000000050',
        captureLifetime: captureActiveServerAccountScopeLifetime, onOpened: onOpened ?? (result => { navigation.push(result); }) }) };
}
function delayedTransport() {
    let resolve!: (result: OpenProjectResultV1) => void;
    let begin!: () => void;
    const started = new Promise<void>(done => { begin = done; });
    const transport: NonNullable<ActionExecutorDeps['projectsOpen']> = async () => {
        const pending = new Promise<OpenProjectResultV1>(done => { resolve = done; });
        begin();
        return pending;
    };
    return { transport, started, resolve: (result: OpenProjectResultV1) => resolve(result) };
}
describe('Project Open screen behavior', () => {
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
    beforeEach(() => installFileFindAccountBoundaryMocks('home', 'account'));
    it.each([opened, { kind: 'refused', code: 'invalid_directory' }, { kind: 'outcomeUnknown', operationId: 'original-attempt' }] as const)
        ('checks the original attempt without replaying Open (%j)', async settlement => {
        let effects = 0;
        const requests: unknown[] = [];
        const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'original-attempt', revision: 3,
            actionId: 'projects.open', state: 'succeeded', scope: { accountId: 'account', machineId: 'machine' },
            title: 'Open a project', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported', result: settlement };
        const repository = draftRepository();
        const { controller, navigation } = harness(async () => { effects += 1; return { kind: 'outcomeUnknown', operationId: 'original-attempt' }; },
            repository, undefined, undefined, args => executeActionOperationActionV1({ ...args,
                transport: async request => { requests.push(request); return { kind: 'found', operation }; } }));
        await controller.submit();
        expect(controller.getSnapshot()).toMatchObject({ canCheck: true });
        await controller.check();
        expect(requests).toEqual([expect.objectContaining({ serverId: 'home', machineId: 'machine',
            method: 'actionOperation.get.v2', payload: { operationId: 'original-attempt' } })]);
        expect(effects).toBe(1);
        expect(controller.getSnapshot().result).toEqual(settlement);
        expect(navigation).toEqual(settlement.kind === 'opened' ? [opened] : []);
        if (settlement.kind === 'outcomeUnknown') {
            await controller.submit();
            expect(effects).toBe(1);
        } else {
            expect(repository.getSessionDraftSnapshot({ serverId: 'home', accountId: 'account' },
                { kind: 'projectOpen', draftId: '00000000-0000-4000-8000-000000000050' })?.document)
                .toMatchObject({ uncertainInputs: { value: [] } });
        }
    });
    it('keeps unknown evidence when no original handle or no original observation is available', async () => {
        let reads = 0;
        const operationRead: NonNullable<ActionExecutorDeps['actionOperationAction']> = args => executeActionOperationActionV1({ ...args,
            transport: async () => { reads += 1; return { kind: 'not_found' }; } });
        const withoutHandle = harness(async () => ({ kind: 'outcomeUnknown' }), draftRepository(), undefined, undefined, operationRead);
        await withoutHandle.controller.submit();
        expect(withoutHandle.controller.getSnapshot()).toMatchObject({ canCheck: false });
        await withoutHandle.controller.check();
        expect(reads).toBe(0);
        const retained = harness(async () => ({ kind: 'outcomeUnknown', operationId: 'original-attempt' }), draftRepository(), undefined, undefined, operationRead);
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
            undefined, undefined, args => executeActionOperationActionV1({ ...args, transport: async () => {
                reads += 1; begin(); return await new Promise(resolve => { release = resolve; });
            } }));
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
        const operationRead: NonNullable<ActionExecutorDeps['actionOperationAction']> = args => executeActionOperationActionV1({ ...args,
            transport: async request => {
                expect(request).toMatchObject({ serverId: 'home', machineId: 'machine', payload: { operationId: 'original-attempt' } });
                return { kind: 'found', operation: { version: 1, operationId: 'original-attempt', revision: 3,
                    actionId: 'projects.open', state: 'succeeded', scope: { accountId: 'account', machineId: 'machine' },
                    title: 'Open a project', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported', result: opened } };
            } });
        const first = harness(async () => { effects += 1; return { kind: 'outcomeUnknown', operationId: 'original-attempt' }; },
            repository, undefined, undefined, operationRead);
        await first.controller.submit();
        first.controller.dispose();
        const retained = harness(async () => { effects += 1; return opened; }, repository, undefined, undefined, operationRead);
        expect(retained.controller.getSnapshot().canCheck).toBe(true);
        retained.controller.setDraft({ ...folder, machineId: 'another-machine' });
        await retained.controller.check();
        expect(effects).toBe(1);
        expect(retained.navigation).toEqual([]);
        expect(retained.controller.getSnapshot()).toMatchObject({ draft: { machineId: 'another-machine' },
            canCheck: false, result: null, retiredAttempt: { input: folder, result: opened } });
    });
    it.each(['metadata', 'override', 'selector', 'revoked'] as const)('keeps the captured Source draft through fresh admission (%s)', async change => {
        const source: ProjectSourceV1 = { id: 'source', revision: 1, name: 'Original', audience: [], createdByAccountId: 'account',
            repository: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://forge.example' },
                repository: { nameWithOwner: 'group/repo', cloneUrl: 'https://forge.example/group/repo.git' }, protocol: 'https' },
            defaultRef: 'main', subdir: 'packages/app' };
        const current: ProjectSourceV1 = { ...source, revision: 9, name: 'Renamed', attachments: [],
            ...(change === 'override' ? { defaultRef: 'other', subdir: 'other' } : {}),
            ...(change === 'selector' ? { repository: { ...source.repository, protocol: 'ssh' } } : {}) };
        const sourceDeps = createProjectSourceActionDeps({ serverId: 'home', accountId: 'account', assertCurrent: () => {},
            credentialAuthorityKind: 'account', workflowArtifacts: { read: async () => null },
            request: async () => new Response(JSON.stringify(change === 'revoked' ? { ok: false, error: 'source_unavailable' }
                : { ok: true, source: current, canManage: true }), { status: change === 'revoked' ? 404 : 200 }) });
        let effects = 0;
        const { controller, navigation } = harness(async () => { effects += 1; return opened; }, draftRepository(), undefined, sourceDeps.projectSourcesRead);
        const draft: OpenProjectInputV1 = { serverId: 'home', machineId: 'machine',
            source: { kind: 'source', id: source.id, revision: source.revision, selector: source.repository, defaultRef: source.defaultRef, subdir: source.subdir },
            ...(change === 'override' ? { ref: 'main', subdir: 'packages/app' } : {}),
            materialization: { kind: 'clone', destinationParentPath: '/tmp', destinationDirectoryName: 'repo' } };
        controller.setDraft(draft);
        await controller.submit();
        expect(controller.getSnapshot().draft).toEqual(draft);
        if (change === 'metadata' || change === 'override') {
            expect(effects).toBe(1);
            expect(navigation).toEqual([opened]);
        } else {
            expect(effects).toBe(0);
            expect(navigation).toEqual([]);
            expect(controller.getSnapshot().result).toEqual({ kind: 'refused', code: change === 'selector' ? 'source_selection_changed' : 'source_unavailable' });
        }
    });
    it('does not seed over an unavailable requested retained identity', async () => {
        const repository = draftRepository();
        let effects = 0;
        const controller = createProjectOpenController({ repository, scope: { serverId: 'home', accountId: 'account' },
            draftId: '00000000-0000-4000-8000-000000000099', seedIfMissing: false,
            captureLifetime: captureActiveServerAccountScopeLifetime, executor: { execute: async () => { effects += 1; return { ok: true, result: opened }; } },
            onOpened: () => { throw new Error('No retained acknowledgement'); } });
        controller.setDraft(folder);
        await controller.submit();
        expect(effects).toBe(0);
        expect(repository.getSessionDraftSnapshot({ serverId: 'home', accountId: 'account' },
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
        const controller = createProjectOpenController({ repository, scope: { serverId: 'home', accountId: 'account' },
            draftId: '00000000-0000-4000-8000-000000000050', captureLifetime: captureActiveServerAccountScopeLifetime,
            executor: { execute: async () => { effects += 1; return { ok: true, result: opened }; } },
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
        installFileFindAccountBoundaryMocks('another-home', 'account');
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
        controller.setDraft({ serverId: 'home' });
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
        const sourceDeps = createProjectSourceActionDeps({ serverId: 'home', accountId: 'account', assertCurrent: () => {},
            credentialAuthorityKind: 'account', workflowArtifacts: { read: async () => null },
            request: async () => new Response(JSON.stringify({ ok: true, canManage: true,
                source: { id: 'source', revision: 1, name: 'Repo', createdByAccountId: 'account', audience: [],
                    repository: source.source.kind === 'source' ? source.source.selector : {}, defaultRef: 'main' } })) });
        const first = harness(async () => { effects += 1; throw new Error('ack lost'); }, repository, undefined, sourceDeps.projectSourcesRead);
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
        const repository = draftRepository({ getString: key => values.get(key), set: (key, value) => values.set(key, value),
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
        const repository = draftRepository({ getString: key => values.get(key), set: (key, value) => values.set(key, value),
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
        const repository = draftRepository({ getString: key => values.get(key), set: (key, value) => {
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
