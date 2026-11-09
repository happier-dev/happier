import { describe, expect, it, vi } from 'vitest';
import axios, { type AxiosAdapter } from 'axios';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { CreateOrUpdateSessionOrganizationTagRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import type { SessionOrganizationTag } from '@happier-dev/protocol/sessions/organization/tags';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import type { V2SessionRecord } from '@happier-dev/protocol/sessions/control/contract';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

import { fixture, homes } from './sessionSpaceMembership.testHelpers';

await loadSyncSingletonForTests();
// Load the real executor graph during collection, rather than charging its cold transform
// time to the first operation's timeout.
await import('@/sync/ops/actions/scopedHomeActionExecutor');
await import('@/sync/ops/actions/defaultActionExecutor');
// The real CLI executor runs in this composed test, but its Node-only daemon
// graph belongs to the CLI compiler program (as in testkit/browserDaemonRuntime).
const { createClientActionReverseDispatcher } = await vi.importActual<{
    createClientActionReverseDispatcher(getClient: () => Readonly<{
        hasConnectedClientRpcHandler(method: string): boolean;
        callConnectedClientRpc(method: string, payload: unknown, options: Readonly<{ onIssued(): void }>):
            Promise<Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; errorCode: string }>>;
    }>): NonNullable<ActionExecutorDeps['clientActionExecute']>;
}>('../../../../../cli/src/session/actions/clientActionReverseDispatch');
const { createActionSettingsProvider } = await vi.importActual<{
    createActionSettingsProvider(input: Readonly<{ getAccountSettings(): AccountSettings }>): Readonly<{
        getAccountSettings(): AccountSettings;
        getActionsSettings(): AccountSettings['actionsSettingsV1'];
    }>;
}>('../../../../../cli/src/settings/actionsSettingsProvider');
const { createUiClientActionReverseHandler } = await import('@/sync/ops/actions/clientActionReverseDispatch');
const { createCliActionExecutorFromCredentials } = await vi.importActual<{
    createCliActionExecutorFromCredentials(input: Readonly<{
        credentials: Readonly<{ token: string; encryption: null; credentialProvenance: 'stored_session' }>;
        serverId: string;
        serverApiUrl: string;
        serverIdentityId: string;
        machineId: string;
        actionsSettingsProvider: ReturnType<typeof createActionSettingsProvider>;
        clientActionExecute: NonNullable<ActionExecutorDeps['clientActionExecute']>;
    }>): Pick<ReturnType<typeof createActionExecutor>, 'execute'>;
}>('../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials');
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

    it('overlapping first preparations remain valid relations without an Account-settings write', async () => {
        const f = await fixture();
        const settings = f.read().raw;
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
        expect(second).toMatchObject({ ok: true });
        if (!first.ok || !second.ok) throw new Error('Missing prepared membership');
        const tags = f.read().tags.filter(tag => [first.tagId, second.tagId].includes(tag.tagId));
        expect(tags).toHaveLength(2);
        for (const tag of tags) expect(tag.display).toEqual({ t: 'plain', v: {
            kind: 'space_membership', spaceId: 'a', spaceSettingsTarget: f.target,
        } });
        expect(f.read().raw).toEqual(settings);
        f.read().assigned.push(first.tagId, second.tagId);
        expect(await f.execute('session.space_membership.set', f.input('b', 'move', 'a'), f.context)).toMatchObject({ ok: true });
        expect(f.read().assigned).not.toContain(first.tagId);
        expect(f.read().assigned).not.toContain(second.tagId);
        expect(f.read().assigned).toHaveLength(2);
    });
    it('continues the CLI and background Agent through the answering Account client and honors the standard refusal policy', async () => {
        const f = await fixture();
        const { createSessionRecordFixture } = await vi.importActual<{
            createSessionRecordFixture(overrides: Partial<V2SessionRecord>): V2SessionRecord;
        }>('../../../../../cli/src/testkit/backends/sessionFixtures');
        const background = createSessionRecordFixture({ id: 'background', active: true, encryptionMode: 'plain',
            machineId: 'membership-machine', metadata: JSON.stringify({ machineId: 'membership-machine', path: '/repo' }) });
        homes.answer(f.serverId, 'POST /v2/sessions/lookup-by-tags', { body: { sessions: [background] } });
        homes.answer(f.serverId, 'GET /v2/sessions/background', { body: { session: background } });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://membership.example');
        if (!credentials) throw new Error('Expected the plaintext Membership fixture credentials');
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
            const cli = createCliActionExecutorFromCredentials({
                credentials: { token: credentials.token, encryption: null, credentialProvenance: 'stored_session' }, serverId: f.serverId,
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
    it('dispatches reachable menu Add, explicit Move and Remove through the same semantic Action executor', async () => {
        const f = await fixture();
        const { resolveSessionListSpaceMembershipDrop } = await import('@/components/sessions/shell/drag/resolveSessionListEntityDrop');
        const { buildSessionSpaceMembershipMenu } = await import('@/components/sessions/organization/sessionSpaceMembershipMenu');
        const menu = buildSessionSpaceMembershipMenu([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
        const leafIds = (items: typeof menu.items): string[] => items.flatMap(item => item.submenu ? leafIds(item.submenu.items) : [item.id]);
        const choices = leafIds(menu.items).flatMap(id => menu.choices.get(id) ?? []);
        const selected = [choices.find(choice => choice.operation === 'add' && choice.spaceId === 'a'),
            choices.find(choice => choice.operation === 'move' && choice.spaceId === 'b' && choice.sourceSpaceId === 'a'),
            choices.find(choice => choice.operation === 'remove' && choice.spaceId === 'b')];
        const context = { scope: f.target, latestItems: [{ type: 'session' as const, sessionId: 's', serverId: f.serverId,
            storageKind: 'persisted' as const, groupKey: 'project', groupKind: 'project' as const, folderId: null }],
        sessionListGroupOrderV1: {}, setSessionListGroupOrderV1: async () => { throw new Error('Membership never reorders hierarchy'); },
        spaceMembershipTargets: ['a', 'b'].map(spaceId => ({ spaceId, spaceSettingsTarget: f.target, name: spaceId })) };
        const item = { kind: 'session' as const, scope: f.target, address: { serverId: f.serverId, sessionId: 's' } };
        for (const choice of selected) {
            if (!choice) throw new Error('Expected a reachable menu choice');
            const input = { ...choice, sessionId: 's', spaceSettingsTarget: f.target };
            const admission = resolveSessionListSpaceMembershipDrop({ item, input, context,
                preview: (name, operation) => ({ verb: operation, target: name }), reason: code => ({ code, message: code }) });
            expect(admission.status).toBe('allowed');
            if (admission.status !== 'allowed') throw new Error('Expected an admitted Space destination');
            expect(admission.effect.actionId).toBe('session.space_membership.set');
            expect(await f.execute('session.space_membership.set', admission.effect.input, f.context)).toMatchObject({ ok: true });
        }
        expect(f.read().assigned).toEqual(['ordinary']);
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

    it('seals a cross-Home tag relation with the existing E2EE envelope without changing catalog settings', async () => {
        const f = await fixture();
        const settings = f.read().raw;
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
        expect(f.read().raw).toEqual(settings);
        expect(f.read().assigned).toEqual(['ordinary']);
    });
});
