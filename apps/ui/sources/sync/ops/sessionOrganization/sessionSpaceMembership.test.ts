import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { type AxiosAdapter } from 'axios';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { CreateOrUpdateSessionOrganizationTagRequestSchema, MutateSessionTagAssignmentsRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import type { SessionOrganizationTag } from '@happier-dev/protocol/sessions/organization/tags';
import { CollectionSpacesV1Schema, createDefaultCollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Only HTTP and device credentials are replaced; catalog CAS, Action policy, encryption,
// organization projection and the membership owner run through their shipped implementations.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
// Load the real executor graph during collection, rather than charging its cold transform
// time to the first operation's timeout.
const { scopedHomeActionExecutor } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
await import('@/sync/ops/actions/defaultActionExecutor');
const [{ createClientActionReverseDispatcher }, { createCliActionExecutorFromCredentials }, { createActionSettingsProvider },
    { createUiClientActionReverseHandler }] = await Promise.all([
    import('../../../../../cli/src/session/actions/clientActionReverseDispatch'),
    import('../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials'),
    import('../../../../../cli/src/settings/actionsSettingsProvider'),
    import('@/sync/ops/actions/clientActionReverseDispatch'),
]);
beforeEach(async () => homes.reset());
afterEach(() => standardCleanup());

let fixtureNumber = 0;
async function fixture() {
    const accountId = `owner-${++fixtureNumber}`;
    const serverId = await homes.addHome({ name: 'Membership', serverUrl: 'https://membership.example', accountId, active: false });
    let raw: Record<string, unknown> = { collectionSpacesV1: { v: 1, spaces: ['a', 'b', 'c'].map(id => ({
        ...createDefaultCollectionSpaceV1('sessionWork'), id, name: id,
    })) } };
    let version = 1;
    homes.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { version, content: { t: 'plain', v: raw } } }) });
    homes.answer(serverId, 'POST /v2/account/settings', { select: input => {
        const body = AccountSettingsV2UpdateRequestSchema.parse(input);
        if (body.content?.t !== 'plain') throw new Error('Expected plain Account settings');
        if (body.expectedVersion !== version) return { body: { success: false, error: 'version-mismatch',
            currentVersion: version, currentContent: { t: 'plain', v: raw } } };
        raw = body.content.v;
        return { body: { success: true, version: ++version } };
    } });
    let tags: SessionOrganizationTag[] = [{ tagId: 'ordinary', tagKey: 'ordinary', sortKey: null,
        display: { t: 'plain', v: { label: 'Visible' } }, archivedAt: null, createdAt: 1, updatedAt: 1 }];
    let assigned = ['ordinary'];
    homes.answer(serverId, 'GET /v2/session-organization', { select: () => ({ body: { snapshot: {
        schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], orderEntries: [], labels: [], tags,
        tagAssignments: [{ sessionId: 's', tagIds: assigned }],
    } } }) });
    homes.answer(serverId, 'POST /v2/session-organization/tags', { select: input => {
        const request = CreateOrUpdateSessionOrganizationTagRequestSchema.parse(input);
        if (!request.tagId) throw new Error('Missing allocated tag');
        const tag: SessionOrganizationTag = { ...request, tagId: request.tagId, sortKey: request.sortKey ?? null,
            display: request.display ?? null, archivedAt: null, createdAt: 1, updatedAt: 1 };
        tags = [...tags, tag];
        return { body: { tag } };
    } });
    homes.answer(serverId, 'PUT /v2/session-organization/tag-assignments/s', { select: input => {
        const request = MutateSessionTagAssignmentsRequestSchema.parse(input);
        assigned = 'tagIds' in request ? request.tagIds
            : [...new Set([...assigned.filter(id => !request.removeTagIds.includes(id)), ...request.addTagIds])];
        return { body: { sessionId: 's', tagIds: assigned } };
    } });
    const execute = scopedHomeActionExecutor({ serverId, accountId });
    const context = { serverId, expectedAccountId: accountId, surface: 'ui' as const, authority: 'present_user' as const };
    const target = { serverId, accountId };
    const input = (spaceId: string, operation: 'add' | 'move' | 'remove' = 'add', sourceSpaceId?: string) => ({
        sessionId: 's', spaceId, operation, spaceSettingsTarget: target, ...(sourceSpaceId ? { sourceSpaceId } : {}),
    });
    return { serverId, accountId, execute, context, target, input, read: () => ({ assigned, tags, raw }),
        seedPrivate: () => {
            tags.push({ tagId: 'private', tagKey: 'private', sortKey: null, archivedAt: null, createdAt: 1, updatedAt: 1,
                display: { t: 'plain', v: { kind: 'space_membership', spaceId: 'a', spaceSettingsTarget: target } } });
            assigned.push('private');
        }, seedUnknown: () => { assigned.push('unavailable-display'); } };
}

describe('Space membership through the Action front door', () => {
    it('uses held membership tags for repeated Add, Move, Remove and New without snapshot reads', async () => {
        const f = await fixture();
        expect(await f.execute('session.space_membership.set', f.input('a'), f.context)).toMatchObject({ ok: true });
        expect(await f.execute('session.space_membership.set', f.input('b'), f.context)).toMatchObject({ ok: true });
        const snapshots = () => homes.requests.filter(request => request.path.split('?')[0] === '/v2/session-organization');
        const before = snapshots().length;
        expect(before).toBeGreaterThan(0);
        expect(await f.execute('session.space_membership.set', f.input('a'), f.context)).toMatchObject({ ok: true });
        expect(await f.execute('session.space_membership.set', f.input('b', 'move', 'a'), f.context)).toMatchObject({ ok: true });
        const { ensureSessionSpaceMembershipTag } = await import('./sessionSpaceMembership');
        expect(await ensureSessionSpaceMembershipTag({ spaceId: 'b', spaceSettingsTarget: f.target,
            serverId: f.serverId, expectedAccountId: f.accountId })).toMatchObject({ ok: true });
        expect(await f.execute('session.space_membership.set', f.input('b', 'remove'), f.context)).toMatchObject({ ok: true });
        expect(f.read().assigned).toEqual(['ordinary']);
        expect(snapshots()).toHaveLength(before);
    });

    it('overlapping first Add and New preparations return the same accepted catalog membership tag', async () => {
        const f = await fixture();
        let release!: () => void;
        const bothSnapshots = new Promise<void>(resolve => { release = resolve; });
        let reads = 0;
        homes.answer(f.serverId, 'GET /v2/session-organization', { select: () => {
            const snapshot = { schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], orderEntries: [], labels: [],
                tags: [...f.read().tags], tagAssignments: [{ sessionId: 's', tagIds: [...f.read().assigned] }] };
            reads++;
            if (reads === 2) release();
            return { body: { snapshot }, ...(reads <= 2 ? { respondAfter: bothSnapshots } : {}) };
        } });
        const { ensureSessionSpaceMembershipTag } = await import('./sessionSpaceMembership');
        const ensure = () => ensureSessionSpaceMembershipTag({ spaceId: 'a', spaceSettingsTarget: f.target,
            serverId: f.serverId, expectedAccountId: f.accountId });
        const [first, second] = await Promise.all([ensure(), ensure()]);
        expect(first).toMatchObject({ ok: true });
        expect(second).toEqual(first);
        const spaces = (await import('@happier-dev/protocol/collections/spaces/collectionSpacesV1')).resolveCollectionSpacesV1(
            CollectionSpacesV1Schema.parse(f.read().raw.collectionSpacesV1), 'sessionWork');
        expect(spaces.find(space => space.id === 'a')?.membership?.tags).toEqual([
            { ...f.target, tagId: first.ok ? first.tagId : '' },
        ]);
        expect(f.read().assigned).toEqual(['ordinary']);
    });
    it('continues the CLI and background Agent through the answering Account client and honors the standard refusal policy', async () => {
        const f = await fixture();
        const { createSessionRecordFixture } = await import('../../../../../cli/src/testkit/backends/sessionFixtures');
        const background = createSessionRecordFixture({ id: 'background', active: true, encryptionMode: 'plain',
            machineId: 'membership-machine', metadata: JSON.stringify({ machineId: 'membership-machine', path: '/repo' }) });
        homes.answer(f.serverId, 'POST /v2/sessions/lookup-by-tags', { body: { sessions: [background] } });
        homes.answer(f.serverId, 'GET /v2/sessions/background', { body: { session: background } });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://membership.example');
        const receive = createUiClientActionReverseHandler({ serverId: f.serverId, accountId: f.accountId, isCurrent: () => true });
        const methods: string[] = [];
        const reverse = createClientActionReverseDispatcher(() => ({ hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
            callConnectedClientRpc: async (method, payload, options) => {
                methods.push(method);
                if (method !== RPC_METHODS.UI_ACTION_EXECUTE) return { ok: false, errorCode: 'CLIENT_NOT_AVAILABLE' };
                options.onIssued();
                return { ok: true, result: await receive(JSON.parse(JSON.stringify(payload)), { signal: new AbortController().signal }) };
            } }));
        const prior = axios.defaults.adapter;
        const adapter: AxiosAdapter = async config => {
            const response = await homes.request(new URL(String(config.url), config.baseURL ?? 'https://membership.example').href, {
                method: config.method, headers: Object.fromEntries(Object.entries(config.headers.toJSON()).map(([key, value]) => [key, String(value)])),
                ...(config.data === undefined ? {} : { body: typeof config.data === 'string' ? config.data : JSON.stringify(config.data) }),
            });
            return { config, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), data: await response.json() };
        };
        axios.defaults.adapter = adapter;
        try {
            const cli = createCliActionExecutorFromCredentials({ credentials: credentials!, serverId: f.serverId,
                serverApiUrl: 'https://membership.example', serverIdentityId: 'srv_membership', machineId: 'membership-machine',
                actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse(f.read().raw) }), clientActionExecute: reverse });
            const cliResult = await cli.execute('session.space_membership.set', f.input('a'), {
                surface: 'cli', authority: 'present_user', actionRequestId: 'membership-cli',
            });
            expect(cliResult, JSON.stringify(cliResult)).toMatchObject({ ok: true });
            const agentResult = await cli.execute('session.space_membership.set', f.input('b', 'move', 'a'), {
                surface: 'agent', authority: 'account_automation', runtimeAccountId: f.accountId,
                defaultSessionId: 'background', defaultSessionMachineId: 'membership-machine', actionRequestId: 'membership-agent',
                actionCaller: { kind: 'session', sessionId: 'background', starterDepth: 0, turnDepth: 0 },
            });
            expect(agentResult, JSON.stringify({ agentResult, methods, requests: homes.requests.map(request => request.path) })).toMatchObject({ ok: true });
            expect(methods).toEqual([RPC_METHODS.UI_ACTION_EXECUTE, RPC_METHODS.UI_ACTION_EXECUTE]);
            const before = [...f.read().assigned];
            await homes.setActionPolicy(f.serverId, 'session.space_membership.set', 'ui', 'off');
            expect(await f.execute('session.space_membership.set', f.input('b', 'remove'), f.context)).toMatchObject({ ok: false });
            expect(f.read().assigned).toEqual(before);
        } finally { axios.defaults.adapter = prior; }
    });
    it('adds, moves and removes only explicit memberships while ordinary label edits preserve private tags', async () => {
        const f = await fixture();
        const first = await f.execute('session.space_membership.set', f.input('a'), f.context);
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
        expect(await f.execute('session.space_membership.set', f.input('c'), f.context)).toMatchObject({ ok: true });
        const [a, c] = f.read().tags.filter(tag => tag.tagId !== 'ordinary').map(tag => tag.tagId);
        expect(await f.execute('session.space_membership.set', f.input('b', 'move', 'a'), f.context)).toMatchObject({ ok: true,
            result: { smartMatchMayRemain: true } });
        const b = f.read().tags.at(-1)!.tagId;
        expect(f.read().assigned.sort()).toEqual(['ordinary', c!, b].sort());
        expect(f.read().assigned).not.toContain(a);
        const { setSessionTagLabels } = await import('./setSessionTagLabels');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://membership.example');
        expect(credentials).toBeTruthy();
        await setSessionTagLabels({ credentials: credentials!, serverId: f.serverId, sessionId: 's', tags: [] });
        expect(f.read().assigned.sort()).toEqual([c!, b].sort());
        expect(await f.execute('session.space_membership.set', f.input('b', 'remove'), f.context)).toMatchObject({ ok: true,
            result: { smartMatchMayRemain: true } });
        expect(f.read().assigned).toEqual([c]);
    });

    it('editing the ordinary tag presentation preserves held private membership assignments', async () => {
        const f = await fixture(); f.seedPrivate(); f.seedUnknown();
        const { setSessionTagLabels } = await import('./setSessionTagLabels');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://membership.example');
        await setSessionTagLabels({ credentials: credentials!, serverId: f.serverId, sessionId: 's', tags: [] });
        expect(f.read().assigned).toEqual(['private', 'unavailable-display']);
    });

    it('refuses missing, foreign and cancelled destinations without changing assignments', async () => {
        const f = await fixture();
        expect(await f.execute('session.space_membership.set', f.input('deleted'), f.context)).toMatchObject({ ok: false });
        expect(await f.execute('session.space_membership.set', f.input('a'), { ...f.context, expectedAccountId: 'foreign' }))
            .toMatchObject({ ok: false });
        expect(await f.execute('session.space_membership.set', { ...f.input('a'), spaceSettingsTarget: { ...f.target, accountId: 'foreign' } }, f.context))
            .toMatchObject({ ok: false });
        const controller = new AbortController(); controller.abort();
        await expect(f.execute('session.space_membership.set', f.input('a'), { ...f.context, signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        homes.answer(f.serverId, 'GET /v2/session-organization', { status: 404, body: { error: 'Not found' } });
        expect(await f.execute('session.space_membership.set', f.input('a'), f.context))
            .toMatchObject({ ok: false, errorCode: 'space_membership_unavailable' });
        expect(f.read().assigned).toEqual(['ordinary']);
    });

    it('seals an own-Home membership tag with the existing E2EE envelope and qualifies the catalog association', async () => {
        const f = await fixture();
        const accountId = 'encrypted-owner';
        const credentials = { token: createAccountTokenForTests(accountId), secret: Buffer.alloc(32, 7).toString('base64url') };
        const serverId = await homes.addHome({ name: 'Encrypted destination', serverUrl: 'https://encrypted-member.example',
            accountId, accountEncryptionMode: 'e2ee', credentials, active: false });
        let written: SessionOrganizationTag | null = null;
        homes.answer(serverId, 'GET /v2/session-organization', { body: { snapshot: {
            schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], orderEntries: [], labels: [], tags: [], tagAssignments: [],
        } } });
        homes.answer(serverId, 'POST /v2/session-organization/tags', { select: input => {
            const request = CreateOrUpdateSessionOrganizationTagRequestSchema.parse(input);
            if (!request.tagId) throw new Error('Missing allocated tag');
            written = { ...request, tagId: request.tagId, sortKey: null, display: request.display ?? null,
                archivedAt: null, createdAt: 1, updatedAt: 1 };
            return { body: { tag: written } };
        } });
        const { ensureSessionSpaceMembershipTag } = await import('./sessionSpaceMembership');
        const ensured = await ensureSessionSpaceMembershipTag({ spaceId: 'a', spaceSettingsTarget: f.target, serverId, expectedAccountId: accountId });
        expect(ensured).toMatchObject({ ok: true });
        expect(written).toMatchObject({ display: { t: 'encrypted' } });
        const { openSessionOrganizationTagDisplay } = await import('./sessionOrganizationDisplayEnvelope');
        const opened = await openSessionOrganizationTagDisplay({ credentials, tag: written! });
        expect(opened.displayState).toEqual({ status: 'available', value: { kind: 'space_membership', spaceId: 'a', spaceSettingsTarget: f.target } });
        expect(f.read().raw).toMatchObject({ collectionSpacesV1: { spaces: expect.arrayContaining([
            expect.objectContaining({ id: 'a', membership: { mode: 'filter_or_manual', tags: [{ serverId, accountId, tagId: opened.tagId }] } }),
        ]) } });
        expect(f.read().assigned).toEqual(['ordinary']);
    });
});
