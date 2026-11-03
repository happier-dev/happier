import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionsCatalogV1Schema, ProviderConnectionsRowMutationV1Schema,
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    sealProviderConnectionsContentV1, openProviderConnectionsContentV1,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { createExperimentalProviderModelProjectionFixture, createProviderModelProjectionFixture, createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

// Only Socket transport is substituted; Action admission and scoped Machine routing stay real.
const providerHarness = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(providerHarness);

const account = createProviderSettingsAccountHarness();
// Warm the real Sync graph after transport installation, outside a test hook's budget.
await loadSyncSingletonForTests();
afterEach(async () => {
    standardCleanup();
    await account.reset();
    providerHarness.reset();
});

function catalogFixture() {
    return ProviderConnectionsCatalogV1Schema.parse({
        ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: ['a', 'b'].map(id => ({
            v: 1, id: `pc_${id}`, source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
            role: 'named', displayName: `Connection ${id}`, displayNameMode: 'custom',
            revision: 1, createdAt: 1, updatedAt: 1,
        })),
        modelPickerVisibilityByConnectionId: { pc_b: false },
        manualModelsByConnectionId: { pc_a: [{ id: 'model-a', name: 'Model A', addedAt: 1 }] },
    });
}

async function executeSourceVisibility(serverId: string, accountId: string, shown: boolean | null) {
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
    return createDefaultActionExecutor().execute('providers.models.source_visibility.set', {
        action: 'setConnectionVisibility', connectionId: 'pc_a', shown,
    }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId, expectedAccountId: accountId });
}

describe('Provider Account source visibility Action', () => {
    it('carries requester Account custody for foreign-worker picker, current selection, source browse and refresh without raw catalog reads', async () => {
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
        const machine = createMachineFixture({ id: 'foreign-worker', activeAt: Date.now(),
            installationId: 'foreign-installation', installationPublicKey: encodeBase64(installation.publicKey),
            access: { custodian: { accountId: 'worker-custodian', displayName: 'Worker owner' },
                role: 'use', resourceMode: 'plain', accessState: 'ready' },
        });
        const serverIdentityId = 'srv_requester_projection';
        const { serverId, accountId } = await account.restore({ catalog: catalogFixture(), machines: [machine,
            ...Array.from({ length: 100 }, (_, index) => createMachineFixture({ id: `unrelated-worker-${index}` })),
        ],
            currentAccount: true, serverIdentityId, waivedActions: ['providers.models.refresh'] });
        const home = account.home.findByServerUrl('https://provider-settings-account.test');
        if (!home?.token) throw new Error('Expected requester Home credentials');
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const currentSelection = { agentTargetKey, providerConnectionId: 'pc_a', modelId: 'model-a' };
        const projected = createExperimentalProviderModelProjectionFixture({ agentTargetKey, modelId: 'requester-model' });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, () => {
            throw createProviderErrorV1('provider_authorization_changed', { machineId: machine.id });
        });
        // Authenticated HTTP is the system boundary. Keep Action dispatch,
        // fresh Machine custody, sealing and strict response decoding real.
        for (const actionId of ['providers.models.projection', 'providers.models.refresh'] as const) {
            account.home.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'requester-root', binding: {
                    accountId, authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId,
                    machineId: machine.id, installationId: machine.installationId, custodianAccountId: 'worker-custodian',
                    accountEncryptionMode: 'plain', actionId, requestId: request.envelope.requestId,
                    target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                } }) };
            } });
            account.home.answer(serverId, `/v1/actions/${actionId}`, { select: body => {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                expect(openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                    purpose: { kind: 'external_action' }, machineId: machine.id, installationId: 'foreign-installation',
                    serverIdentityId, installationPrivateKey: installation.secretKey })).toEqual({ token: home.token });
                expect(JSON.stringify(request)).not.toContain(home.token);
                return { body: { v: 1, actionId, requestId: request.envelope.requestId,
                    execution: { ok: true, result: projected } } };
            } });
        }
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const censusReadsBeforePicker = account.home.requests.filter(request => new URL(request.path, home.serverUrl).pathname === '/v1/machines').length;
        for (const selectors of [{}, { currentSelection }, { sourceConnectionId: 'pc_a' }, { forceRefresh: true as const }]) {
            const actionId = 'forceRefresh' in selectors ? 'providers.models.refresh' : 'providers.models.projection';
            expect(await executor.execute(actionId, { machineId: machine.id, agentTargetKey, ...selectors },
                { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId, expectedAccountId: accountId }))
                .toEqual({ ok: true, result: projected });
        }
        expect(providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toHaveLength(0);
        expect(account.home.requests.filter(request => new URL(request.path, home.serverUrl).pathname === '/v1/machines')).toHaveLength(censusReadsBeforePicker);
        const reads = account.home.requestsFor('/v1/actions/providers.models.projection');
        expect(reads).toHaveLength(3);
        expect(account.home.requestsFor('/v1/actions/providers.models.refresh')).toHaveLength(1);
        expect(reads.map(read => ExternalActionExecutionAuthorizationRequestV1Schema.parse(read.input).envelope))
            .toMatchObject([{ input: { machineId: machine.id, agentTargetKey } },
                { input: { currentSelection } }, { input: { sourceConnectionId: 'pc_a' } }]);
        const error = createProviderErrorV1('provider_authorization_changed', { machineId: machine.id, connectionId: 'pc_a' });
        account.home.answer(serverId, '/v1/actions/providers.models.projection', { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { body: { v: 1, actionId: 'providers.models.projection', requestId: request.envelope.requestId,
                execution: { ok: false, errorCode: error.code, error: error.code, details: error } } };
        } });
        expect(await executor.execute('providers.models.projection', { machineId: machine.id, agentTargetKey, currentSelection },
            { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId, expectedAccountId: accountId }))
            .toEqual({ ok: false, errorCode: error.code, error: error.code, details: error });
        expect(providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toHaveLength(0);
    });

    it('refuses foreign-worker model discovery without an installation key before private or raw projection dispatch', async () => {
        const machine = createMachineFixture({ id: 'foreign-worker', activeAt: Date.now(),
            installationId: 'foreign-installation',
            access: { custodian: { accountId: 'worker-custodian', displayName: 'Worker owner' },
                role: 'use', resourceMode: 'plain', accessState: 'ready' },
        });
        const { serverId, accountId } = await account.restore({ catalog: catalogFixture(), machines: [machine],
            currentAccount: true, serverIdentityId: 'srv_requester_projection' });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, () => {
            throw createProviderErrorV1('provider_authorization_changed', { machineId: machine.id });
        });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('providers.models.projection', {
            machineId: machine.id, agentTargetKey: 'agent:happier.agent.codex/codex',
        }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId, expectedAccountId: accountId }))
            .toMatchObject({ ok: false });
        expect(providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toHaveLength(0);
        expect(account.home.requestsFor('/v1/actions/providers.models.projection')).toHaveLength(0);
    });

    it.each(['same', 'other-machine', 'other-source', 'management', 'forced-refresh'] as const)(
        'shares only the exact admitted descriptive model question: %s', async variant => {
        const machine = createMachineFixture({ id: 'machine-a', activeAt: Date.now() });
        const otherMachine = createMachineFixture({ id: 'machine-b', activeAt: Date.now() });
        const { serverId, accountId } = await account.restore({ catalog: catalogFixture(), machines: [machine, otherMachine],
            waivedActions: ['providers.models.refresh'] });
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, async (_request, next) => {
            await blocked;
            return next();
        });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const read = (second: boolean) => createDefaultActionExecutor().execute(
            variant === 'forced-refresh' ? 'providers.models.refresh' : 'providers.models.projection', {
            machineId: second && variant === 'other-machine' ? otherMachine.id : machine.id,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            ...(second && variant === 'other-source' ? { sourceConnectionId: 'pc_a' } : {}),
            ...(second && variant === 'management' ? { mode: 'management' } : {}),
            ...(variant === 'forced-refresh' ? { forceRefresh: true } : {}),
        }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId, expectedAccountId: accountId });
        const reads = [read(false), read(true)];
        try {
            await vi.waitFor(() => expect(providerHarness.state.requests.some(request =>
                request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toBe(true));
            await flushHookEffects({ cycles: 2, turns: 3 });
        } finally {
            release();
        }
        expect(await Promise.all(reads)).toMatchObject([{ ok: true }, { ok: true }]);
        expect(providerHarness.state.requests.filter(request =>
            request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toHaveLength(variant === 'same' ? 1 : 2);
    });

    it('cancels one admitted model borrower without cancelling the surviving reader', async () => {
        const machine = createMachineFixture({ id: 'machine-a', activeAt: Date.now() });
        const { serverId, accountId } = await account.restore({ catalog: catalogFixture(), machines: [machine] });
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, async (_request, next) => {
            await blocked;
            return next();
        });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const controller = new AbortController();
        const read = (signal?: AbortSignal) => createDefaultActionExecutor().execute('providers.models.projection', {
            machineId: machine.id, agentTargetKey: 'agent:happier.agent.codex/codex',
        }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId,
            expectedAccountId: accountId, signal });
        // Observe both promises immediately so an abort cannot become an unhandled rejection.
        const reads = Promise.allSettled([read(controller.signal), read()]);
        try {
            await vi.waitFor(() => expect(providerHarness.state.requests.some(request =>
                request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toBe(true));
            await flushHookEffects({ cycles: 2, turns: 3 });
            controller.abort();
        } finally { release(); }
        const [cancelled, surviving] = await reads;
        expect(cancelled.status === 'rejected' || !cancelled.value.ok).toBe(true);
        expect(surviving).toMatchObject({ status: 'fulfilled', value: { ok: true } });
        expect(providerHarness.state.requests.filter(request =>
            request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toHaveLength(1);
    });

    it('cancels the first model borrower during request-id preparation before physical dispatch', async () => {
        const machine = createMachineFixture({ id: 'machine-a', activeAt: Date.now() });
        const { serverId, accountId } = await account.restore({ catalog: catalogFixture(), machines: [machine] });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const controller = new AbortController();
        const dispatched: string[] = [];
        const firstExecutor = createDefaultActionExecutor({ onProviderRpcDispatched: () => dispatched.push('first') });
        const secondExecutor = createDefaultActionExecutor({ onProviderRpcDispatched: () => dispatched.push('second') });
        const randomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
        let beforeDispatch: number | null = null;
        // Request-id generation is the OS boundary after encoding, immediately before onIssued.
        const randomBoundary = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementationOnce(() => {
            beforeDispatch = providerHarness.state.requests.filter(request =>
                request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION).length;
            controller.abort();
            return randomUUID();
        });
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            actionCaller: { kind: 'host' as const }, serverId, expectedAccountId: accountId };
        try {
            const input = { machineId: machine.id, agentTargetKey: 'agent:happier.agent.codex/codex' };
            const [first, second] = await Promise.allSettled([
                firstExecutor.execute('providers.models.projection', input, { ...context, signal: controller.signal }),
                secondExecutor.execute('providers.models.projection', input, context),
            ]);
            expect(beforeDispatch).toBe(0);
            expect(first.status === 'rejected' || !first.value.ok).toBe(true);
            expect(second).toMatchObject({ status: 'fulfilled', value: { ok: true } });
            expect(dispatched).toEqual(['second']);
            expect(providerHarness.state.requests.filter(request =>
                request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toHaveLength(1);
        } finally { randomBoundary.mockRestore(); }
    });

    it.each(['providers.models.projection', 'providers.models.refresh'] as const)(
        'projects experimental Team models in one batch without consulting personal consent for %s', async actionId => {
            const machine = createMachineFixture({ id: 'machine-a', activeAt: Date.now() });
            const { serverId, accountId } = await account.restore({ catalog: catalogFixture(), machines: [machine],
                waivedActions: ['providers.models.refresh'] });
            const agentTargetKey = 'agent:happier.agent.codex/codex';
            const experimental = createExperimentalProviderModelProjectionFixture({ agentTargetKey, modelId: 'model-a' });
            const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
                id: 'resource-a', teamId: 'team-a', displayName: 'Team gateway', resourceRevision: 1,
                readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
                directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', sourcePresentation: null,
                providerModels: [{
                    selection: { kind: 'team_credential_provider_model', resourceId: 'resource-a', teamId: 'team-a',
                        expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey, modelId: 'model-a' },
                    descriptor: { id: 'model-a', name: 'Model A' },
                    application: { agentTargetKey, implementationIdentity: { pluginId: 'acme.gateway', localId: 'gateway' },
                        endpointTemplateId: 'responses', protocol: 'openai-responses' },
                    compatibility: experimental.groups[0]!.rows[0]!.compatibility,
                    sourceRevision: 'source-a', availability: 'available',
                }],
            });
            const projection = createProviderModelProjectionFixture({ agentTargetKey, groups: [], teamCredentialResources: [resource] });
            providerHarness.setResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, projection);
            const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
            const executor = createDefaultActionExecutor();
            const read = () => executor.execute(actionId, { machineId: machine.id, agentTargetKey, teamCredentialResources: [resource],
                ...(actionId === 'providers.models.refresh' ? { forceRefresh: true } : {}) },
                { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId, expectedAccountId: accountId });
            const personalReads = account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1).length;
            expect(await read()).toMatchObject({ ok: true, result: {
                status: 'success', teamCredentialResources: [{ providerModels: [{ compatibility: { confirmed: false } }] }],
            } });
            account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { body: { status: 'absent' } });
            expect(await read()).toMatchObject({ ok: true, result: {
                status: 'success', teamCredentialResources: [{ providerModels: [{ compatibility: { confirmed: false } }] }],
            } });
            expect(account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)).toHaveLength(personalReads);
        },
    );

    it('projects a Machine transport timeout as a retryable Machine check, without claiming a Provider outage', async () => {
        const machine = createMachineFixture({ id: 'machine-a', activeAt: Date.now() });
        const { serverId, accountId } = await account.restore({ catalog: catalogFixture(), machines: [machine] });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, async () => {
            throw Object.assign(new Error('Machine row request timed out'), { code: 'MACHINE_RPC_TIMEOUT' });
        });
        const { describeProviderModels } = await import('@/providers/actions/client');
        const { presentProviderError } = await import('@/providers/connection/errorPresentation');
        let failure: unknown;
        try {
            await describeProviderModels({ machineId: machine.id, agentTargetKey: 'agent:happier.agent.claude/claude', serverId });
        } catch (caught) { failure = caught; }
        expect(failure).toEqual(createProviderErrorV1('agent_timeout', { machineId: machine.id }));
        expect(presentProviderError(failure)).toMatchObject({
            titleKey: 'settingsProviders.errors.machineTimeoutTitle', action: 'retry',
        });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('providers.models.projection', {
            machineId: machine.id, agentTargetKey: 'agent:happier.agent.claude/claude',
        }, { surface: 'ui', serverId, expectedAccountId: accountId })).toMatchObject({
            ok: false, errorCode: 'agent_timeout', details: { code: 'agent_timeout', retryable: true },
        });
    });
    it('keeps the real projection RPC open for its owner budget and consumes the source-scoped result', async () => {
        const machine = createMachineFixture({ id: 'machine-a', activeAt: Date.now() });
        const { serverId, accountId } = await account.restore({ catalog: catalogFixture(), machines: [machine] });
        let entered = false;
        let release = () => {};
        const released = new Promise<void>(resolve => { release = resolve; });
        const failure = createProviderErrorV1('provider_endpoint_unavailable', { machineId: machine.id, connectionId: 'pc_a' });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, async () => {
            entered = true;
            await released;
            return { status: 'success', agentTargetKey: 'agent:happier.agent.claude/claude', groups: [],
                refreshFailures: [{ connectionId: 'pc_a', error: failure }] };
        });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const pending = createDefaultActionExecutor().execute('providers.models.projection', {
            machineId: machine.id, agentTargetKey: 'agent:happier.agent.claude/claude',
        }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId, expectedAccountId: accountId });
        try {
            await vi.waitFor(() => expect(entered).toBe(true));
            await vi.advanceTimersByTimeAsync(PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs + 1);
            release();
            await expect(pending).resolves.toMatchObject({ ok: true, result: { status: 'success',
                refreshFailures: [{ connectionId: 'pc_a', error: failure }] } });
        } finally {
            vi.useRealTimers();
            release();
            await pending;
        }
    });
    it('describes the retained Account source admitted by its catalog observer without a machine or Action reseed', async () => {
        const retained = catalogFixture();
        const { serverId, accountId } = await account.restore({ catalog: retained, settings: {
            providerSettingsV1: { ...retained, defaultsByAgentTargetKey: {} },
        } });
        // Model the genuine source-retirement CAS as well as the destination row.
        // A GET-shaped reply to POST cannot acknowledge retirement or update its source.
        let settingsContent: ReturnType<typeof AccountSettingsV2UpdateRequestSchema.parse>['content'] = {
            t: 'plain', v: { providerSettingsV1: { ...retained, defaultsByAgentTargetKey: {} } },
        };
        let settingsVersion = 1;
        account.home.answer(serverId, 'GET /v2/account/settings', {
            select: () => ({ body: { version: settingsVersion, content: settingsContent } }),
        });
        account.home.answer(serverId, 'POST /v2/account/settings', {
            select: input => {
                const mutation = AccountSettingsV2UpdateRequestSchema.parse(input);
                expect(mutation.expectedVersion).toBe(settingsVersion);
                settingsContent = mutation.content;
                settingsVersion += 1;
                return { body: { success: true, version: settingsVersion } };
            },
        });
        let admitted: typeof retained | null = null;
        let revision = 0;
        let rowWrites = 0;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: admitted ? { status: 'present', revision, content: { t: 'plain', v: admitted } }
                : { status: 'absent' } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe('absent');
                expect(mutation.sourceSettingsVersion).toEqual(expect.any(Number));
                if (mutation.content?.t !== 'plain') throw new Error('Expected a retained Plain Account transfer');
                admitted = mutation.content.v;
                revision += 1;
                rowWrites += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const { useProviderCatalogForServer } = await import('@/sync/store/useProviderCatalog');
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const observer = await renderHook(() => useProviderCatalogForServer(serverId));
        await waitForHomeGovernance(() => expect(observer.getCurrent()).toMatchObject({ status: 'ready', revision: 1 }));
        expect(rowWrites).toBe(1);
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            actionCaller: { kind: 'host' as const }, serverId, expectedAccountId: accountId };
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const result = await executor.execute('providers.connections.describe', { connectionId: 'pc_a' }, context);
            expect(result, `describe attempt ${attempt + 1}: ${JSON.stringify(result)}`)
                .toMatchObject({ ok: true, result: { connections: [{ connectionId: 'pc_a', authorized: false }] } });
        }
        expect(admitted).toMatchObject({ connections: retained.connections,
            manualModelsByConnectionId: retained.manualModelsByConnectionId });
        expect(rowWrites).toBe(1);
        expect(providerHarness.state.requests).toEqual([]);
    });
    it.each(['plain', 'e2ee'] as const)('creates, renames, manages manual models and deletes a custom %s Account connection without a machine', async mode => {
        let catalog = catalogFixture();
        const secret = new Uint8Array(32).fill(29);
        const material = mode === 'e2ee' ? { type: 'legacy' as const, secret } : null;
        const { serverId, accountId } = await account.restore({ catalog, waivedActions: [
            'providers.connections.create_custom', 'providers.connections.update', 'providers.connections.delete',
        ], ...(mode === 'e2ee' ? { e2eeSecret: secret } : {}) });
        let revision = 1;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: sealProviderConnectionsContentV1({ mode, material, catalog }) } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(revision);
                expect(mutation.content?.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
                const opened = openProviderConnectionsContentV1({ mode, material, content: mutation.content });
                if (opened.status !== 'opened') throw new Error(`Expected mode-consistent Account mutation: ${opened.status}`);
                catalog = opened.catalog;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            actionCaller: { kind: 'host' as const }, serverId, expectedAccountId: accountId };
        const created = await executor.execute('providers.connections.create_custom', {
            action: 'createCustom', connectionId: 'pc_account', savedSecretId: null, enable: false,
            template: { v: 1, name: 'Account source', endpointTemplates: [{ id: 'chat', protocol: 'openai-chat',
                baseUrl: 'https://example.com/v1', capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown',
                    statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
                catalog: { source: 'manual', manualModelPolicy: 'allowed' } }, manualModels: [],
        }, context);
        expect(created).toMatchObject({ ok: true, result: { status: 'success', action: 'createCustom' } });
        const connection = catalog.connections.find(entry => entry.id === 'pc_account')!;
        expect(await executor.execute('providers.connections.update', { action: 'update', connectionId: connection.id,
            expectedRevision: connection.revision, displayName: 'Renamed', displayNameMode: 'custom' }, context))
            .toMatchObject({ ok: true, result: { status: 'success' } });
        const renamed = catalog.connections.find(entry => entry.id === connection.id)!;
        expect(renamed.displayName).toBe('Renamed');
        expect(await executor.execute('providers.models.manual.add', { action: 'manualAdd', connectionId: renamed.id,
            expectedConnectionRevision: renamed.revision,
            models: [{ id: 'manual-account' }] }, context)).toMatchObject({ ok: true, result: { status: 'success' } });
        expect(catalog.manualModelsByConnectionId[renamed.id]?.map(model => model.id)).toEqual(['manual-account']);
        expect(await executor.execute('providers.connections.describe', { connectionId: renamed.id }, context))
            .toMatchObject({ ok: true, result: { connections: [{ displayName: 'Renamed', authorized: false }] } });
        expect(await executor.execute('providers.models.list', { connectionId: renamed.id }, context))
            .toMatchObject({ ok: true, result: { models: [{ id: 'manual-account', source: 'manual', loadState: 'unknown' }] } });
        expect(await executor.execute('providers.connections.delete', { action: 'delete', connectionId: renamed.id }, context))
            .toMatchObject({ ok: true, result: { status: 'success', deletedConnectionId: renamed.id } });
        expect(catalog.connections.some(entry => entry.id === renamed.id)).toBe(false);
        expect(catalog.manualModelsByConnectionId[renamed.id]).toBeUndefined();
        expect(providerHarness.state.requests).toEqual([]);
    });
    it('hides, shows and resets one source through captured Account row CAS without Settings or Machine writes', async () => {
        let catalog = catalogFixture();
        const original = catalog;
        const { serverId, accountId } = await account.restore({ catalog });
        let revision = 1;
        let rowWrites = 0;
        let settingsWrites = 0;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(revision);
                expect(mutation.referencedSavedSecretIds).toEqual([]);
                expect(mutation.savedSecretRevisions).toEqual([]);
                expect(mutation.content?.t).toBe('plain');
                if (mutation.content?.t !== 'plain') throw new Error('Expected a keyless Plain Account write');
                catalog = mutation.content.v;
                rowWrites += 1;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        account.home.answer(serverId, 'POST /v2/account/settings', {
            select: () => { settingsWrites += 1; return { status: 500, body: { error: 'unexpected_settings_write' } }; },
        });

        for (const shown of [false, true, null]) {
            expect(await executeSourceVisibility(serverId, accountId, shown)).toEqual({
                ok: true, result: { status: 'updated' },
            });
            expect(catalog.modelPickerVisibilityByConnectionId).toEqual({ pc_b: false,
                ...(shown === null ? {} : { pc_a: shown }) });
            expect(catalog.connections).toEqual(original.connections);
            expect(catalog.manualModelsByConnectionId).toEqual(original.manualModelsByConnectionId);
            expect(catalog.accountGrants).toEqual(original.accountGrants);
            expect(catalog.secretBindingsByConnectionId).toEqual(original.secretBindingsByConnectionId);
        }
        expect(rowWrites).toBe(3);
        expect(settingsWrites).toBe(0);
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('returns a row CAS refusal without reporting updated or replaying the source toggle', async () => {
        const catalog = catalogFixture();
        const { serverId, accountId } = await account.restore({ catalog });
        let rowWrites = 0;
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                expect(ProviderConnectionsRowMutationV1Schema.parse(input).expectedRevision).toBe(1);
                rowWrites += 1;
                return { status: 409, body: { status: 'conflict', revision: 2 } };
            },
        });
        expect(await executeSourceVisibility(serverId, accountId, false)).toMatchObject({
            ok: false, details: { status: 'conflict', revision: 2 },
        });
        expect(rowWrites).toBe(1);
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('refuses an incomplete catalog before dispatching any visibility write', async () => {
        const catalog = catalogFixture();
        const { serverId, accountId } = await account.restore({ catalog });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: {
                ...catalog, retainedUnknown: { savedSecretId: formatSharedSavedSecretRefV1('unknown-resource') },
            } } },
        });
        let rowWrites = 0;
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => { rowWrites += 1; return { status: 500, body: { error: 'unexpected_visibility_write' } }; },
        });
        expect(await executeSourceVisibility(serverId, accountId, false)).toMatchObject({
            ok: false, details: { status: 'partial' },
        });
        expect(rowWrites).toBe(0);
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('preserves an unknown post-dispatch outcome without reporting updated or replaying the write', async () => {
        let catalog = catalogFixture();
        const { serverId, accountId } = await account.restore({ catalog });
        let rowWrites = 0;
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(1);
                if (mutation.content?.t !== 'plain') throw new Error('Expected a Plain Account mutation');
                // This server may commit before its response is lost; only the writer owns
                // the uncertain receipt, and the Action must not replay or call it success.
                catalog = mutation.content.v;
                rowWrites += 1;
                return { dispatchThenFail: true };
            },
        });
        expect(await executeSourceVisibility(serverId, accountId, false)).toMatchObject({
            ok: false, errorCode: 'provider_catalog_outcome_unknown',
        });
        expect(catalog.modelPickerVisibilityByConnectionId).toEqual({ pc_a: false, pc_b: false });
        expect(rowWrites).toBe(1);
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('refuses an absent destination without initializing an empty catalog or retiring its source', async () => {
        const catalog = catalogFixture();
        const { serverId, accountId } = await account.restore({ catalog, settings: {
            providerSettingsV1: { ...catalog, defaultsByAgentTargetKey: {} },
        } });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { body: { status: 'absent' } });
        let rowWrites = 0;
        let settingsWrites = 0;
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => { rowWrites += 1; return { status: 500, body: { error: 'unexpected_initialization' } }; },
        });
        account.home.answer(serverId, 'POST /v2/account/settings', {
            select: () => { settingsWrites += 1; return { status: 500, body: { error: 'unexpected_source_retirement' } }; },
        });
        expect(await executeSourceVisibility(serverId, accountId, false)).toMatchObject({
            ok: false, errorCode: 'provider_catalog_unavailable',
            details: { status: 'unavailable', reason: 'authority-not-confirmed' },
        });
        expect(rowWrites).toBe(0);
        expect(settingsWrites).toBe(0);
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('refuses a deleted destination as an unknown connection without reseeding retained source', async () => {
        const catalog = catalogFixture();
        const { serverId, accountId } = await account.restore({ catalog, settings: {
            providerSettingsV1: { ...catalog, defaultsByAgentTargetKey: {} },
        } });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'deleted', revision: 4 },
        });
        let rowWrites = 0;
        let settingsWrites = 0;
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => { rowWrites += 1; return { status: 500, body: { error: 'unexpected_reseed' } }; },
        });
        account.home.answer(serverId, 'POST /v2/account/settings', {
            select: () => { settingsWrites += 1; return { status: 500, body: { error: 'unexpected_source_retirement' } }; },
        });
        expect(await executeSourceVisibility(serverId, accountId, false)).toMatchObject({
            ok: false, errorCode: 'provider_connection_not_found',
        });
        expect(rowWrites).toBe(0);
        expect(settingsWrites).toBe(0);
        expect(providerHarness.state.requests).toEqual([]);
    });
});
