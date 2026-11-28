import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliSettingsDeclarationActionFixture as createCliSettingsDeclarationAction } from './settingsDeclarationAction.test-support';
import { AccountSettingsV2UpdateRequestSchema, API_TOKEN_FULL_GRANT_V1, ExternalActionExecutionAuthorizationV1Schema,
    type AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';

afterEach(() => vi.restoreAllMocks());

describe('headless settings conditional writes', () => {
    it('delivers every full declaration through byte-budgeted discovery without changing unbudgeted discovery', async () => {
        const action = createCliSettingsDeclarationAction({});
        const complete = SettingsDeclarationActionOutputSchemasV1['settings.list'].parse(
            await action({ actionId: 'settings.list', input: {}, context: { surface: 'cli' } }));
        const items = [];
        let cursor: number | undefined;
        do {
            const page = SettingsDeclarationActionOutputSchemasV1['settings.list'].parse(
                await action({ actionId: 'settings.list', input: { maxBytes: 64 * 1024, ...(cursor ? { cursor } : {}) }, context: { surface: 'cli' } }));
            expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024);
            expect(page).toMatchObject({ total: complete.items.length });
            items.push(...page.items);
            cursor = page.nextCursor;
        } while (cursor);
        expect(items).toEqual(complete.items);
        expect(complete).toEqual({ items: complete.items });
    });
    it('omits the mounted Voice edit from discovery without hiding present-user scalar settings', async () => {
        const action = createCliSettingsDeclarationAction({});
        const discovery = await action({ actionId: 'settings.list', input: { pageId: 'voiceConversations' }, context: { surface: 'cli' } });
        expect(discovery).toMatchObject({ items: expect.not.arrayContaining([
            expect.objectContaining({ anchor: 'voiceConversations.edit' }),
        ]) });
        const transcript = await action({ actionId: 'settings.list', input: { pageId: 'transcript' }, context: { surface: 'cli' } });
        expect(transcript).toMatchObject({ items: expect.arrayContaining([
            expect.objectContaining({ anchor: 'transcript.showToolCalls', readable: true, writable: true }),
        ]) });
    });
    it('refuses a captured App draft target before reading or mutating Home settings', async () => {
        const read = vi.spyOn(axios, 'get');
        const write = vi.spyOn(axios, 'post');
        const action = createCliSettingsDeclarationAction({ serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test' });
        for (const actionId of ['settings.get', 'settings.set'] as const) {
            expect(await action({ actionId, input: { anchor: 'appearance.atmosphereSource',
                ...(actionId === 'settings.set' ? { value: 'none' } : {}), target: { kind: 'public_profile_draft', serverId: 'home-a' } },
                context: { surface: 'cli', serverId: 'home-a' } }))
                .toMatchObject({ ok: false, errorCode: 'unavailable', details: { reason: 'client_unavailable' } });
        }
        expect(read).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        const discovery = await action({ actionId: 'settings.list', input: { pageId: 'appearance' }, context: { surface: 'cli' } });
        expect(discovery).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
            anchor: 'appearance.atmospherePictureLibrary', readable: false, writable: false, unavailableReason: 'unsupported_host',
        })]) });
    });
    it('routes catalog-dependent atmosphere and private Project settings to an answering client', async () => {
        const action = createCliSettingsDeclarationAction({});
        for (const anchor of ['appearance.homeAtmosphere', 'appearance.atmosphereLooks', 'appearance.projectAtmosphere']) {
            expect(await action({ actionId: 'settings.get', input: { anchor,
                ...(anchor === 'appearance.projectAtmosphere' ? { target: { kind: 'project', serverId: 'home-a', projectKey: 'project-a' } } : {}) },
                context: { surface: 'agent', serverId: 'home-a' } })).toMatchObject({ ok: false, errorCode: 'unavailable',
                    details: { reason: 'client_unavailable', recovery: { kind: 'connect_client' } } });
        }
    });
    it('patches Workflow Lines through the headless Agent setting and preserves retained collection choices', async () => {
        const baseline = {
            sessionListDensity: 'cozy',
            collectionDisplayPreferencesV1: {
                workflow: { presentation: 'table', lines: 1, details: { trigger: false } },
                workflowRun: { lines: 2 },
            },
        };
        let content: AccountSettingsStoredContentEnvelope = { t: 'plain', v: baseline };
        let version = 1;
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content, version } };
            throw new Error(`Unexpected HTTP read: ${url}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
            if (!url.endsWith('/v2/account/settings')) throw new Error(`Unexpected HTTP write: ${url}`);
            const request = AccountSettingsV2UpdateRequestSchema.parse(raw);
            expect(request.expectedVersion).toBe(version);
            if (!request.content) throw new Error('Expected stored Account settings');
            content = request.content;
            return { status: 200, data: { success: true, version: ++version } };
        });
        const token = `test.${Buffer.from(JSON.stringify({ sub: 'collection-display-test' })).toString('base64url')}.test`;
        const action = createCliSettingsDeclarationAction({ credentials: { token, encryption: null }, serverId: 'collection-home' });
        const anchor = 'appearance.collectionDisplay';
        const context = { surface: 'agent' } as const;
        const value = { kind: 'workflow', lines: 3, details: { steps: true } };
        const workflow = { presentation: 'table', lines: 3, details: { trigger: false, steps: true } };
        expect(await action({ actionId: 'settings.set', input: { anchor, value }, context }))
            .toMatchObject({ anchor });
        expect(await action({ actionId: 'settings.get', input: { anchor }, context })).toMatchObject({
            anchor, value: { workflow, workflowRun: { lines: 2 }, sessionWork: { lines: 2 } },
        });
        expect(content).toEqual({ t: 'plain', v: { ...baseline, collectionDisplayPreferencesV1: {
            ...baseline.collectionDisplayPreferencesV1, workflow,
        } } });
    });
    it('reads and writes the opt-in latest Session message without changing other Row details', async () => {
        const baseline = { collectionDisplayPreferencesV1: { sessionWork: { details: { progress: false } } } };
        let content: AccountSettingsStoredContentEnvelope = { t: 'plain', v: baseline };
        let version = 1;
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content, version } };
            throw new Error(`Unexpected HTTP read: ${url}`);
        });
        const write = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
            if (!url.endsWith('/v2/account/settings')) throw new Error(`Unexpected HTTP write: ${url}`);
            const request = AccountSettingsV2UpdateRequestSchema.parse(raw);
            expect(request.expectedVersion).toBe(version);
            if (!request.content) throw new Error('Expected stored Account settings');
            content = request.content;
            return { status: 200, data: { success: true, version: ++version } };
        });
        const token = `test.${Buffer.from(JSON.stringify({ sub: 'collection-latest-message-test' })).toString('base64url')}.test`;
        const action = createCliSettingsDeclarationAction({ credentials: { token, encryption: null }, serverId: 'collection-home' });
        const anchor = 'appearance.collectionDisplay';
        const context = { surface: 'agent' } as const;
        const read = () => action({ actionId: 'settings.get', input: { anchor }, context });

        expect(await read()).toMatchObject({
            value: { sessionWork: { details: { latestMessage: false, currentWork: true, progress: false } } },
        });
        for (const latestMessage of [true, false]) {
            const value = { kind: 'sessionWork', details: { latestMessage } };
            expect(await action({ actionId: 'settings.set', input: { anchor, value }, context })).toMatchObject({ anchor });
            expect(await read()).toMatchObject({
                value: { sessionWork: { details: { latestMessage, currentWork: true, progress: false } } },
            });
            expect(content).toEqual({ t: 'plain', v: { collectionDisplayPreferencesV1: {
                sessionWork: { details: { progress: false, latestMessage } },
            } } });
        }
        expect(write).toHaveBeenCalledTimes(2);
    });

    it('refuses a read-only reset before reading or writing Account material', async () => {
        const read = vi.spyOn(axios, 'get');
        const write = vi.spyOn(axios, 'post');
        const action = createCliSettingsDeclarationAction({ serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test' });
        expect(await action({ actionId: 'settings.reset', input: { anchor: 'homeAdministration.serverSettings.HAPPIER_CANONICAL_SERVER_URL',
            target: { kind: 'home', serverId: 'home-a' } },
            context: { surface: 'cli' } })).toMatchObject({ ok: false, errorCode: 'setting_read_only' });
        expect(read).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });

    it.each(['settings.workflowRuns.maxActiveRunsPerMachine', 'coordination.autoFollowAssigned'])
        ('keeps non-Account reset unsupported for %s without borrowing an owner', async anchor => {
            const read = vi.spyOn(axios, 'get');
            const write = vi.spyOn(axios, 'post');
            const action = createCliSettingsDeclarationAction({});
            expect(await action({ actionId: 'settings.reset', input: { anchor }, context: { surface: 'cli' } }))
                .toMatchObject({ ok: false, errorCode: 'setting_reset_unsupported' });
            expect(read).not.toHaveBeenCalled();
            expect(write).not.toHaveBeenCalled();
        });
    it.each([
        { actionId: 'settings.get', input: { anchor: 'delegation.workDepthLimit', includeVersion: true } },
        { actionId: 'settings.set', input: { anchor: 'delegation.workDepthLimit', value: 2, expectedSettingsVersion: 4 } },
        { actionId: 'settings.set', input: { anchor: 'delegation.workDepthLimit', value: 2, reversal: { kind: 'capture' } } },
        { actionId: 'settings.get', input: { anchor: 'notifications.machineOffline', key: 'machine' } },
        { actionId: 'settings.set', input: { anchor: 'notifications.machineOffline', key: 'machine', value: true } },
    ] as const)('requires Account credentials before the headless conditional owner can read or mutate', async request => {
        const action = createCliSettingsDeclarationAction({});
        expect(await action({ ...request, context: { surface: 'agent' } }))
            .toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    });
    it('never borrows daemon credentials for an external conditional preference read', async () => {
        const read = vi.spyOn(axios, 'get');
        const write = vi.spyOn(axios, 'post');
        const action = createCliSettingsDeclarationAction({ credentials: { token: 'daemon', encryption: null } });
        for (const input of [{ anchor: 'usage.coachPreferences', includeVersion: true },
            { anchor: 'notifications.machineOffline', key: 'machine' }]) {
            expect(await action({ actionId: 'settings.get', input,
                context: { surface: 'agent', externalActionCredential: { accountId: 'account', principalId: 'principal',
                    credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 } } }))
                .toMatchObject({ ok: false, errorCode: 'requester_account_material_unavailable' });
        }
    });
    it('uses the current Account material for a same-Account Session Action authorization', async () => {
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const token = `${encode({ alg: 'none' })}.${encode({ sub: 'owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`;
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
            serverIdentityId: 'home', accountId: 'owner', principalId: 'owner', credentialId: 'credential',
            custodianAccountId: 'owner', installationId: 'installation', grant: API_TOKEN_FULL_GRANT_V1,
            machineId: 'machine', actionId: 'settings.get', requestId: 'request',
            requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
        } });
        const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
            content: { t: 'plain', v: {} }, version: 1,
        } });
        const action = createCliSettingsDeclarationAction({ credentials: { token, encryption: null } });
        const controller = new AbortController();

        expect(await action({ actionId: 'settings.get', input: { anchor: 'appearance.atmospherePlanetDigits' },
            context: { surface: 'agent', signal: controller.signal, externalActionExecutionAuthorization: authorization } }))
            .toEqual({ anchor: 'appearance.atmospherePlanetDigits', value: true });
        expect(get).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));

        const foreignToken = `${encode({ alg: 'none' })}.${encode({ sub: 'custodian', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`;
        const foreignAction = createCliSettingsDeclarationAction({ credentials: { token: foreignToken, encryption: null } });
        expect(await foreignAction({ actionId: 'settings.get', input: { anchor: 'appearance.atmospherePlanetDigits' },
            context: { surface: 'agent', externalActionExecutionAuthorization: authorization } }))
            .toMatchObject({ ok: false, errorCode: 'requester_account_material_unavailable' });
    });
});
