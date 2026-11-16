import { createHydratedPlainMachineFixture, createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { storage } from '@/sync/domains/state/storage';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import * as React from 'react';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ClipboardWriteResultSchema } from '@happier-dev/protocol/actions/clipboardActionFamily';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { McpServerCatalogRowMutationV1Schema, McpServerCatalogRowMutationResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { resolveServerProfileScopeIdForIdentifier, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainV2SessionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { LocalServiceInventorySnapshotV1Schema, DaemonLocalServiceInventorySnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/inventory/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { act, renderHook, renderWithAppProviders } from '@/dev/testkit';
import type { IModal } from '@/modal/types';
import { LocalServicePublicPreviewSnapshotV1Schema } from '@happier-dev/protocol/local/services/public/v1';
import { ScmChangeDiscardResponseSchema } from '@happier-dev/protocol/scm';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { AccountSettingsV2UpdateRequestSchema} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { type AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { requireActionSuccess } from './frontDoorRuntimeActionExecutor';

describe('native compact admission presentation', () => {
    it('surfaces a native unsupported receipt instead of treating the request as admitted', () => {
        expect(() => requireActionSuccess({ ok: true, result: { status: 'unsupported' } }, 'session.compact'))
            .toThrow(expect.objectContaining({ code: 'unsupported_action', details: { status: 'unsupported' } }));
        for (const status of ['admitted', 'already_pending'] as const) {
            expect(() => requireActionSuccess({ ok: true, result: { status } }, 'session.compact')).not.toThrow();
        }
    });
});

const clipboard = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>());
const publicLinkModal = vi.hoisted(() => ({ confirm: vi.fn<IModal['confirm']>(), show: vi.fn<IModal['show']>() }));
const daemonRpc = vi.hoisted(() => vi.fn<(request: Readonly<{
    serverId?: string; machineId: string; method: string; payload: unknown;
}>) => Promise<unknown>>());
// Clipboard, Machine RPC and Home network/credential ports are genuine system boundaries.
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    confirmResult: false, spies: { confirm: publicLinkModal.confirm, show: publicLinkModal.show },
}).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// The daemon RPC transport is the external Machine boundary; its request/response codec and runtime Action owner stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: daemonRpc }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { LocalServicePublicPreviewControls } = await import('@/components/sessions/localServices/LocalServicePublicPreviewControls');
const { createLocalServicePublicPreviewActions } = await import('@/components/sessions/localServices/publicPreviewActions');
const { applyLocalServicePublicPreviewSnapshot, createLocalServicePublicPreviewState } = await import('@/sync/domains/local/services/publicPreview/store');
const {
    createFrontDoorActionExecute,
    createFrontDoorRuntimeActionExecutor,
    createFrontDoorUiActionExecutor,
} = await import('./frontDoorRuntimeActionExecutor');
const { scopedHomeActionExecutor } = await import('./scopedHomeActionExecutor');
// Keep cold executable graph loading out of each invocation's behavior deadline.
await import('./defaultActionExecutor');
await import('@/components/approvals/useMountedActionExecution');
await import('@/components/sessions/actions/sessionActionExecution');

describe('composed UI Action front-door adapters', () => {
    beforeEach(async () => {
        await homes.reset(); clipboard.mockReset(); daemonRpc.mockReset();
        publicLinkModal.confirm.mockReset().mockResolvedValue(false);
        publicLinkModal.show.mockReset();
        vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
    });
    afterEach(() => standardCleanup());

    it.each(['wake', 'blocked'] as const)('keeps new Session Send with Home managed runtime admission (%s)', async disposition => {
        const serverIdentityId = 'srv_send_wake';
        const serverId = await homes.addHome({ name: 'Send wake Home', serverUrl: 'https://send-wake.test',
            serverIdentityId, accountId: 'alice', currentAccount: true });
        await setServerProfileIdentityForUrl('https://send-wake.test', serverIdentityId);
        const machine = createHydratedPlainMachineFixture({ id: 'asleep-guest', accountId: 'alice', machine: {
            active: false, isShared: false, managedMachineRef: { homeId: serverIdentityId, managedId: 'managed-guest' },
        } });
        const row = createPlainMachineRowFixture({ id: machine.id, accountId: 'alice', machine });
        homes.answer(serverId, '/v1/machines', { body: [row] });
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, id => id === row.id ? row : null).json(),
        }) });
        storage.setState({ profileScope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice' } });
        storage.getState().applyMachines([machine], false, { sourceServerId: serverId, sourceAccountId: 'alice' });
        const actionPath = '/v1/actions/session.spawn_new';
        const failureCause = { phase: 'machines.managed.wake', errorClass: 'Error', errorCode: 'target_unavailable',
            nativeErrorReason: 'controller_unavailable', httpStatus: null };
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            if (disposition === 'blocked') return { status: 409, body: {
                error: 'invalid_request', code: 'target_unavailable', requestId: request.envelope.requestId, failureCause,
            } };
            return { body: { v: 1, token: 'send-wake-proof', binding: {
                serverIdentityId, accountId: 'alice', authentication: { kind: 'account', tokenEpoch: 0 },
                actionId: 'session.spawn_new', requestId: request.envelope.requestId,
                target: request.envelope.target, machineId: row.id, installationId: row.installationId,
                custodianAccountId: 'alice', accountEncryptionMode: 'plain', machineRuntimeDemand: 'required',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            } } };
        } });
        homes.answer(serverId, actionPath, { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(request.executionAuthorization?.token).toBe('send-wake-proof');
            expect(request.envelope).toMatchObject({ target: { kind: 'machine', machineId: row.id }, input: {
                agentInstallConsent: { vendorRecipe: true }, initialInput: { text: 'Wake and run' },
            } });
            return { body: { v: 1, actionId: 'session.spawn_new', requestId: request.envelope.requestId,
                execution: { ok: true, result: projectSessionSpawnNewActionResultV1({
                    type: 'success', disposition: 'created', sessionId: 'after-wake',
                    executionTarget: { serverId, machineId: row.id }, organizationPlacement: { folderId: null, tagIds: [] },
                    initialInput: { status: 'accepted', localId: 'send-wake-input' },
                }) } } };
        } });
        // Home and Machine transports are external boundaries. The real UI entry,
        // Action routing, custody codec and result projection stay composed.
        daemonRpc.mockResolvedValue({ type: 'error', code: 'machine_offline', retryable: true });
        const { executeSessionSpawnNewAction } = await import('./sessionSpawnNewAction');
        const spawn = SessionSpawnNewInputV2Schema.parse({
            creationKey: `send-${disposition}`, executionTarget: { serverId, machineId: row.id },
            directory: { kind: 'path', path: '/repo' }, organizationPlacement: { folderId: null, tagIds: [] },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            initialInput: { text: 'Wake and run' }, agentInstallConsent: { vendorRecipe: true },
        });
        if (!spawn.creationKey) throw new Error('Expected a creation key');
        const result = await executeSessionSpawnNewAction({ ...spawn, creationKey: spawn.creationKey },
            { surface: 'ui', serverId, expectedAccountId: 'alice' });
        expect(result, JSON.stringify(result)).toMatchObject(disposition === 'blocked'
            ? { ok: false, errorCode: 'target_unavailable', failureCause }
            : { ok: true, result: { type: 'success', sessionId: 'after-wake' } });
        expect(homes.requestsFor(`${actionPath}/execution-authorization`)).toHaveLength(1);
        expect(homes.requestsFor(actionPath)).toHaveLength(disposition === 'blocked' ? 0 : 1);
        expect(daemonRpc).not.toHaveBeenCalled();
    });

    it('retains the complete Browser download refusal at the file-save UI boundary', async () => {
        const serverId = await homes.addHome({ name: 'Download Home', serverUrl: 'https://download-home.test',
            serverIdentityId: 'srv_download_home', accountId: 'alice', currentAccount: true });
        const { requestSaveFile } = await import('@/sync/runtime/files/requestSaveFile');
        const result = await requestSaveFile({ fileName: 'download.bin', source: { kind: 'browserDownload',
            reference: { machineId: 'machine', browserSessionId: 'missing-browser', viewId: 'missing-view', downloadId: 'download' },
        } }, { serverId, accountId: 'alice' });
        expect(result).toMatchObject({ status: 'failed', ok: false, errorCode: 'browser_download_unavailable',
            error: 'browser_download_unavailable' });
    });

    it('keeps the prepared Voice target through the full-context confirmed handoff when the primary Session changes', async () => {
        const serverId = await homes.addHome({ name: 'Prepared target Home', serverUrl: 'https://prepared-voice-target.test',
            serverIdentityId: 'srv_prepared_voice_target', accountId: 'alice', currentAccount: true });
        homes.answer(serverId, 'GET /v2/sessions/original', { body: {
            session: createPlainV2SessionRecordFixture({ id: 'original' }),
        } });
        homes.answer(serverId, 'GET /v2/account/settings', { body: {
            version: 1, content: { t: 'plain', v: { voice: { canApproveRequests: true } } },
        } });
        const { resolveVoiceActionSessionReference } = await import('@/voice/tools/actionImpl/resolveVoiceActionSessionReference');
        const delivered: string[] = [];
        const execute = createFrontDoorActionExecute(undefined, {
            // The production Voice adapter preserves exact qualified references
            // without fabricating an admitted corpus or mocking resolution.
            resolveSessionReference: ({ sessionId, sessionTitle, context, signal }) =>
                resolveVoiceActionSessionReference({ sessionId, sessionTitle, serverId: context.serverId, signal }),
            // The Session message transport is external; target resolution,
            // captured Account authority, preparation and confirmation stay real.
            sessionSendMessage: async ({ sessionId }) => {
                delivered.push(sessionId);
                return { status: 'accepted', localId: `message-${sessionId}` };
            },
        });
        const context = { surface: 'voice', serverId, defaultSessionId: 'original',
            actionRequestId: 'read-back-original' } as const;
        const prepared = await execute.prepare('session.message.send', {
            sessionId: { selector: 'self' }, message: 'The exact operation I reviewed.',
        }, context, { reviewOnly: true });
        expect(prepared, JSON.stringify(prepared)).toMatchObject({ kind: 'ready', operation: { sessionTargetsV1: {
            targets: [{ serverId, sessionId: 'original' }],
        } } });
        if (prepared.kind !== 'ready' || !prepared.operation) throw new Error('Expected prepared target snapshot');
        expect(delivered).toEqual([]);
        const result = await execute.confirmed(prepared.operation.actionId, prepared.operation.normalizedInput, {
            ...context, defaultSessionId: 'replacement',
            sessionTargetsV1: prepared.operation.sessionTargetsV1,
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        expect(delivered).toEqual(['original']);
        expect(homes.artifacts(serverId).list()).toEqual([]);
    });

    it('prepares and confirms through the captured Account host on a non-UI surface without borrowing focused Voice policy', async () => {
        const serverId = await homes.addHome({ name: 'Requested Home', serverUrl: 'https://confirmed-voice-home.test',
            serverIdentityId: 'srv_confirmed_voice_home', accountId: 'alice', currentAccount: true });
        await setServerProfileIdentityForUrl('https://confirmed-voice-home.test', 'srv_confirmed_voice_home');
        const focusedHome = await homes.addHome({ name: 'Focused Home', serverUrl: 'https://focused-voice-home.test',
            accountId: 'bob', currentAccount: true });
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'voice', true)).toBe(true);
        homes.answer(serverId, '/v1/features', { body: features });
        let content: Extract<AccountSettingsStoredContentEnvelope, { t: 'plain' }> = {
            t: 'plain', v: { voice: { canApproveRequests: true } },
        };
        let version = 1;
        homes.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { version, content } }) });
        homes.answer(focusedHome, 'GET /v2/account/settings', { body: {
            version: 1, content: { t: 'plain', v: { voice: { canApproveRequests: false } } },
        } });
        homes.answer(serverId, 'POST /v2/account/settings', { select: raw => {
            const update = AccountSettingsV2UpdateRequestSchema.parse(raw);
            expect(update.expectedVersion).toBe(version);
            if (update.content?.t !== 'plain') throw new Error('Expected captured Plain Account');
            content = update.content;
            return { body: { success: true, version: ++version } };
        } });
        const actionId = 'settings.set';
        const input = { anchor: 'voiceConversations.canApproveRequests', value: false };
        const context = { surface: 'voice', serverId, actionRequestId: 'confirmed-non-ui' } as const;
        const execute = createFrontDoorActionExecute();
        const prepared = await execute.prepare(actionId, input, context, { reviewOnly: true });
        expect(prepared).toMatchObject({ kind: 'ready', operation: {
            actionId, normalizedInput: input, inputDigest: expect.any(String), summary: expect.any(String),
            safety: 'danger', canConfirmInFlow: true,
        } });
        expect(version).toBe(1);
        expect(homes.artifacts(serverId).list()).toEqual([]);
        // Native origination consumes the same captured authority. Invalid
        // operation input must not become a spurious authority refusal.
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { readOriginalAccountActionAuthentication } = await import('@/sync/api/externalActionAccountTransport');
        const nativeAccount = await captureLazyActionAccountContext(serverId);
        try {
            expect(nativeAccount.serverIdentityId).toBe('srv_confirmed_voice_home');
            expect(readOriginalAccountActionAuthentication(nativeAccount.credentials.token)).not.toBeNull();
        } finally { nativeAccount.dispose(); }
        expect(await execute('machines.setup.plan', {}, { ...context, actionRequestId: 'native-input-refusal' }))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        if (prepared.kind !== 'ready' || !prepared.operation) throw new Error('Expected normalized host operation');
        expect(await execute.confirmed(actionId, prepared.operation.normalizedInput, context))
            .toMatchObject({ ok: true, result: { anchor: input.anchor, value: false } });
        expect(version).toBe(2);
        expect(homes.artifacts(serverId).list()).toEqual([]);
        expect(homes.requests.filter(request => request.serverId === focusedHome && request.method === 'POST')).toEqual([]);
    });

    it('executes a confirmed present-user delete through the Session lifecycle wrapper without asking again', async () => {
        const serverId = await homes.addHome({ name: 'Sessions', serverUrl: 'https://confirmed-session.test',
            serverIdentityId: 'confirmed-session', accountId: 'alice' });
        homes.answer(serverId, 'DELETE /v1/sessions/session-1', { body: { success: true } });
        const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
        expect(await executeSessionLifecycleAction('session.delete', 'session-1', {
            serverId, expectedAccountId: 'alice', confirmed: true,
        })).toEqual({ success: true });
        expect(homes.requestsFor('/v1/sessions/session-1')).toHaveLength(1);
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
    });

    it('uses the designed SCM review once through the shared invoker without a second dialog or approval', async () => {
        const serverId = await homes.addHome({ name: 'SCM', serverUrl: 'https://confirmed-scm.test',
            serverIdentityId: 'confirmed-scm', accountId: 'alice' });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const { invokeUiScmAction } = await import('@/sync/ops/scm/scmActionInvocation');
        const effects: unknown[] = [];
        const executor = createDefaultActionExecutor({ scmActionExecute: async ({ input }) => {
            effects.push(input);
            return { success: true };
        } });
        const input = { cwd: '/repo', entries: [{ path: 'reviewed.ts', kind: 'modified' }] };
        const pending = invokeUiScmAction({ actionId: 'scm.change.discard', input,
            schema: ScmChangeDiscardResponseSchema, executor: createFrontDoorActionExecute(executor), confirmed: true,
            context: { serverId, expectedAccountId: 'alice',
                externalActionTarget: { kind: 'machine', machineId: 'machine-1' } } });
        input.entries[0]!.path = 'changed-after-confirmation.ts';
        expect(await pending).toEqual({ success: true });
        expect(effects).toEqual([expect.objectContaining({ cwd: '/repo', entries: [{ path: 'reviewed.ts', kind: 'modified' }] })]);
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
    });

    it('preserves a declined shared-policy confirmation as a typed failure without a webhook effect', async () => {
        const transport = vi.fn(async () => ({ kind: 'discarded', revision: 4 }));
        const settings = ActionsSettingsV1Schema.parse({ v: 1 });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            pluginWebhookAction: transport,
            readActionsSettings: () => settings,
            presentUserActionConfirmation: async () => false,
        }));
        const host = { execute: ((actionId, input, context) => executor.execute(actionId, input, {
            ...context, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: 'discard-press',
        })) satisfies typeof executor.execute };
        await expect(createFrontDoorUiActionExecutor(host)('plugin.webhook.delivery.discard', {
            deliveryId: 'delivery-1', expectedRevision: 3,
        })).rejects.toMatchObject({ code: 'approval_canceled' });
        expect(transport).not.toHaveBeenCalled();
    });

    it.each(['ui', 'scoped', 'mounted'] as const)('executes a confirmed present-user delete through %s while the Agent caller still asks through the real policy', async bridge => {
        const serverId = await homes.addHome({ name: 'MCP', serverUrl: 'https://confirmed-mcp.test',
            serverIdentityId: 'confirmed-mcp', accountId: 'alice' });
        onTestFailed(() => console.error('Confirmed MCP boundary paths', homes.requests.map(request => request.path)));
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 0 }) });
        homes.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
        homes.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
        const catalog = { v: 1, servers: [{ id: 'throwaway', name: 'throwaway', transport: 'stdio',
            stdio: { command: 'mcp-tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] };
        homes.answer(serverId, 'GET /v1/account/entity-rows/mcp', { body: { status: 'present', revision: 3,
            content: { t: 'plain', v: catalog } } });
        homes.answer(serverId, 'POST /v1/account/entity-rows/mcp', { select: value => {
            const mutation = McpServerCatalogRowMutationV1Schema.parse(value);
            expect(mutation.content).toMatchObject({ t: 'plain', v: { v: 1, servers: [], bindings: [] } });
            return { body: McpServerCatalogRowMutationResponseV1Schema.parse({ status: 'updated', revision: 4, cursor: 4 }) };
        } });
        const input = { serverId: 'throwaway', removeBindings: true, expectedRevision: 3 };
        const confirmed = { confirmed: true as const };
        const executeUi = createFrontDoorUiActionExecutor(undefined, { serverId, expectedAccountId: 'alice' });
        const scoped = bridge === 'scoped' ? await scopedHomeActionExecutor({
            serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice',
        }).confirmed('mcp.servers.delete', input, { surface: 'ui', serverId, expectedAccountId: 'alice' }) : null;
        if (scoped && !scoped.ok) throw new Error('Confirmed scoped delete failed');
        const mounted = bridge === 'mounted' ? await (async () => {
            const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
            const hook = await renderHook(() => useMountedActionExecution({
                serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice',
            }));
            await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
            return hook.getCurrent().executeValue('mcp.servers.delete', input, confirmed);
        })() : undefined;
        const result = scoped?.ok ? scoped.result : bridge === 'mounted' ? mounted
            : await executeUi('mcp.servers.delete', input, confirmed);
        expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.delete'].parse(result)).toMatchObject({ status: 'updated', revision: 4 });
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
        const writes = homes.requestsFor('/v1/account/entity-rows/mcp').filter(request =>
            McpServerCatalogRowMutationV1Schema.safeParse(request.input).success).length;
        expect(writes).toBe(1);
        const controller = new AbortController();
        const agent = createFrontDoorActionExecute()('mcp.servers.delete', input, {
            serverId, expectedAccountId: 'alice', surface: 'agent', authority: 'account_automation',
            defaultSessionId: 'agent-session', defaultSessionMachineId: 'agent-machine', actionRequestId: 'agent-delete-mcp',
            actionCaller: { kind: 'host' }, signal: controller.signal,
        });
        try {
            await vi.waitFor(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
            const artifact = homes.artifacts(serverId).list()[0]!;
            expect(StoredApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifact.id)!)))
                .toMatchObject({ status: 'open', actionId: 'mcp.servers.delete', requestedSurface: 'agent' });
            expect(homes.requestsFor('/v1/account/entity-rows/mcp').filter(request =>
                McpServerCatalogRowMutationV1Schema.safeParse(request.input).success)).toHaveLength(writes);
        } finally { controller.abort(); await agent; }
    });

    it.each([true, false])('retains mounted operands through lazy admission and in-place Ask after draft mutation (confirm=%s)', async (confirm) => {
        const serverId = await homes.addHome({ name: 'Mounted custody', serverUrl: 'https://mounted-custody.test',
            serverIdentityId: 'mounted-custody', accountId: 'alice' });
        await homes.requireUiApproval(serverId, ['mcp.servers.delete']);
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 0 }) });
        homes.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
        homes.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
        const catalog = { v: 1, servers: [{ id: 'throwaway', name: 'throwaway', transport: 'stdio',
            stdio: { command: 'mcp-tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] };
        homes.answer(serverId, 'GET /v1/account/entity-rows/mcp', { body: { status: 'present', revision: 3, content: { t: 'plain', v: catalog } } });
        homes.answer(serverId, 'POST /v1/account/entity-rows/mcp', { select: value => {
            expect(McpServerCatalogRowMutationV1Schema.parse(value)).toMatchObject({ expectedRevision: 3,
                content: { t: 'plain', v: { servers: [], bindings: [] } } });
            return { body: { status: 'updated', revision: 4, cursor: 4 } };
        } });
        const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
        // Coordination 2026-11-15 23:05: the own-UI Ask retains the original
        // operation in its native presenter, without an approval Artifact.
        let answer: ((confirmed: boolean) => void) | undefined;
        const presentUserActionConfirmation = vi.fn<NonNullable<ActionExecutorDeps['presentUserActionConfirmation']>>(async () =>
            new Promise<boolean>(resolve => { answer = resolve; }));
        const executorOptions = { presentUserActionConfirmation };
        const hook = await renderHook(() => useMountedActionExecution({
            serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice',
        }, { executorOptions }));
        const input = { serverId: 'throwaway', removeBindings: true, expectedRevision: 3 };
        let operation: ReturnType<ReturnType<typeof hook.getCurrent>['execute']> | undefined;
        await act(async () => {
            operation = hook.getCurrent().execute('mcp.servers.delete', input);
            input.expectedRevision = 99;
        });
        try {
            await vi.waitFor(() => expect(presentUserActionConfirmation).toHaveBeenCalledTimes(1));
            expect(presentUserActionConfirmation).toHaveBeenCalledWith(expect.objectContaining({
                actionId: 'mcp.servers.delete', input: expect.objectContaining({ expectedRevision: 3 }),
            }));
            expect(homes.artifacts(serverId).list()).toHaveLength(0);
            expect(hook.getCurrent().approval.approvalId).toBeNull();
            expect(homes.requestsFor('/v1/account/entity-rows/mcp').filter(request => request.method === 'POST')).toHaveLength(0);
            input.expectedRevision = 100;
            await act(async () => { answer!(confirm); await operation!; });
            expect(await operation!).toMatchObject(confirm
                ? { ok: true, result: { status: 'updated', revision: 4 } }
                : { ok: false, errorCode: 'approval_canceled' });
            expect(homes.artifacts(serverId).list()).toHaveLength(0);
            expect(homes.requestsFor('/v1/account/entity-rows/mcp').filter(request => request.method === 'POST')).toHaveLength(confirm ? 1 : 0);
        } finally {
            answer?.(false);
            hook.getCurrent().cancel();
            await hook.unmount();
            await operation!;
        }
    });

    it('executes the UI adapter through the default clipboard registration and produces the consumer result shape', async () => {
        const serverId = await homes.addHome({ name: 'Clipboard', serverUrl: 'https://clipboard-front-door.test', accountId: 'alice' });
        const text = '{\n  "diagnosis": "ready 🔐"\n}\n';
        const copied: string[] = [];
        clipboard.mockImplementation(async value => { copied.push(value); return true; });
        const action = createFrontDoorUiActionExecutor(undefined, { serverId, expectedAccountId: 'alice' });
        expect(ClipboardWriteResultSchema.parse(await action('clipboard.write', { text }))).toEqual({ status: 'copied' });
        const uiResult = await action('clipboard.write', { text: '' });
        expect(ClipboardWriteResultSchema.parse(uiResult)).toEqual({ status: 'copied' });
        expect(copied).toEqual([text, '']);
    });

    it.each([
        { operation: 'create', explicitAsk: false, waived: false, accepted: true },
        { operation: 'revoke', explicitAsk: false, waived: false, accepted: true },
        { operation: 'revoke', explicitAsk: true, waived: false, accepted: true },
        { operation: 'revoke', explicitAsk: true, waived: false, accepted: false },
        { operation: 'revoke', explicitAsk: false, waived: false, accepted: false },
        { operation: 'revoke', explicitAsk: false, waived: true, accepted: false },
    ] as const)('consumes the public-link $operation confirmation once (Ask: $explicitAsk, waived: $waived, accepted: $accepted)', async ({ operation, explicitAsk, waived, accepted }) => {
        const serverId = await homes.addHome({ name: 'Public links', serverUrl: `https://public-link-${operation}.test`, accountId: 'alice' });
        if (explicitAsk) await homes.requireUiApproval(serverId, ['localServices.publicPreview.revoke']);
        if (waived) {
            homes.answer(serverId, 'GET /v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'localServices.publicPreview.revoke': ['ui'] } },
            } } } });
            const focusedHome = await homes.addHome({ name: 'Foreign focused Home', serverUrl: 'https://foreign-public-link.test',
                accountId: 'bob', currentAccount: true });
            await homes.requireUiApproval(focusedHome, ['localServices.publicPreview.revoke']);
        }
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'localServices.publicPreview', true)).toBe(true);
        homes.answer(serverId, '/v1/features', { body: features });
        const exposure = { exposureId: 'exposure-1', previewId: 'preview-1', machineId: 'machine-1', sessionId: 'session-1',
            mode: 'secret_link' as const, state: 'active' as const, publicUrl: 'https://preview.test/s/exposure-1',
            issuedAt: Date.now(), expiresAt: Date.now() + 600_000, auditEventIds: ['audit-1'], rateLimitProfileId: 'default' };
        const snapshot = LocalServicePublicPreviewSnapshotV1Schema.parse({ v: 1, machineId: 'machine-1', sessionId: 'session-1',
            previewId: 'preview-1', generatedAt: Date.now(), refreshState: 'idle',
            policy: { enabled: true, allowedModes: ['secret_link'], maxTtlMs: 600_000, maxConcurrentExposures: 1,
                dnsTlsRequired: true, auditRequired: true, rateLimitProfileIds: ['default'] },
            exposures: operation === 'revoke' ? [exposure] : [], diagnostics: [] });
        daemonRpc.mockResolvedValue(operation === 'create' ? { protocolVersion: 1, exposure, snapshot: { ...snapshot, exposures: [exposure] } }
            : { protocolVersion: 1, exposureId: exposure.exposureId, revokedAt: Date.now(), snapshot: { ...snapshot, exposures: [] } });
        publicLinkModal.confirm.mockResolvedValue(accepted);
        publicLinkModal.show.mockImplementation(config => {
            // Native modal is the system boundary; select only options the real sheet offered.
            const props = (config as unknown as { props: {
                modeChoices: readonly { mode: string }[]; ttlChoices: readonly { ttlMs: number }[];
                onResolve(value: { mode: string; ttlMs: number }): void;
            } }).props;
            props.onResolve({ mode: props.modeChoices[0]!.mode, ttlMs: props.ttlChoices[0]!.ttlMs });
            return 'public-link-sheet';
        });
        const outcomes: unknown[] = [];
        const execute = createFrontDoorRuntimeActionExecutor();
        const rendered = await renderWithAppProviders(React.createElement(LocalServicePublicPreviewControls, {
            launchTargets: [], browserTarget: { kind: 'localServicePreview', machineId: 'machine-1', sessionId: 'session-1', targetId: 'preview-1' },
            serviceTitle: 'Dashboard', state: applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), snapshot),
            actions: createLocalServicePublicPreviewActions({ runtimeActionExecute: async (request, options) => {
                const outcome = await execute(request, options); outcomes.push(outcome); return outcome;
            }, serverId,
                expectedAccountId: 'alice', copyToClipboard: async () => true }),
        }));
        try {
            const testID = operation === 'create' ? 'local-service-public-preview-controls-target:preview-1-create'
                : 'local-service-public-preview-controls-exposure:exposure-1-revoke';
            await act(async () => {
                rendered.tree.root.findAll(node => node.props.testID === testID && typeof node.props.onPress === 'function')[0]!.props.onPress();
                await vi.waitFor(() => expect(outcomes).toHaveLength(1));
            });
            if (!accepted && !waived) {
                expect(outcomes[0]).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
                expect(daemonRpc).not.toHaveBeenCalled();
            } else {
                expect(outcomes[0]).toMatchObject({ protocolVersion: 1 });
                expect(daemonRpc).toHaveBeenCalledTimes(1);
                expect(daemonRpc.mock.calls[0]?.[0].method).toBe(operation === 'create'
                    ? RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE : RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE);
            }
            expect(publicLinkModal.show).toHaveBeenCalledTimes(operation === 'create' ? 1 : 0);
            expect(publicLinkModal.confirm).toHaveBeenCalledTimes(operation === 'revoke' && !waived ? 1 : 0);
            if (operation === 'revoke' && !waived) {
                expect(publicLinkModal.confirm.mock.calls[0]?.[1]).toContain('https://preview.test/');
                expect(publicLinkModal.confirm.mock.calls[0]?.[1]).not.toContain(exposure.exposureId);
            }
            expect(homes.artifacts(serverId).list()).toHaveLength(0);
        } finally { await rendered.unmount(); }
    });

    it('unwraps the runtime inventory result from the default registration after the Machine codec validates it', async () => {
        const serverId = await homes.addHome({ name: 'Inventory', serverUrl: 'https://inventory-front-door.test', accountId: 'alice' });
        const snapshot = LocalServiceInventorySnapshotV1Schema.parse({ v: 1, machineId: 'inventory-machine',
            generatedAt: 41, refreshState: 'idle', entries: [], diagnostics: [] });
        daemonRpc.mockImplementation(async request => {
            expect(request).toMatchObject({ serverId, machineId: snapshot.machineId,
                method: RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT, payload: { machineId: snapshot.machineId } });
            return DaemonLocalServiceInventorySnapshotResponseV1Schema.parse({ protocolVersion: 1, snapshot });
        });
        const result = await createFrontDoorRuntimeActionExecutor()({ actionId: 'localServices.inventory.list',
            input: { machineId: snapshot.machineId }, context: { surface: 'ui', serverId } });
        expect(LocalServiceInventorySnapshotV1Schema.parse(result)).toEqual(snapshot);
    });

    it('preserves admission failures and rejects platform failures without executing disabled or cancelled work', async () => {
        const serverId = await homes.addHome({ name: 'Clipboard', serverUrl: 'https://clipboard-front-door.test', accountId: 'alice' });
        const wrongAccount = createFrontDoorUiActionExecutor(undefined, { serverId, expectedAccountId: 'bob' });
        await expect(wrongAccount('clipboard.write', { text: 'wrong account' })).rejects.toMatchObject({ message: 'action_account_scope_changed', code: 'action_account_scope_changed' });
        expect(clipboard).not.toHaveBeenCalled();
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'clipboard.write': { enabled: false }, 'localServices.inventory.list': { enabled: false },
            } }),
        } }, version: 1 } });
        const bridge = createFrontDoorRuntimeActionExecutor();
        const disabled = await bridge({ actionId: 'localServices.inventory.list', input: {}, context: {
            surface: 'ui', serverId,
        } });
        expect(ActionExecuteFailureSchema.parse(disabled)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        await expect(createFrontDoorUiActionExecutor(undefined, { serverId })('clipboard.write', { text: 'disabled' }))
            .rejects.toMatchObject({ message: 'action_disabled', code: 'action_disabled' });
        expect(clipboard).not.toHaveBeenCalled();

        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 2 } });
        const action = createFrontDoorUiActionExecutor(undefined, { serverId, expectedAccountId: 'alice' });
        const controller = new AbortController();
        controller.abort();
        await expect(action('clipboard.write', { text: 'cancelled' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(clipboard).not.toHaveBeenCalled();
        clipboard.mockRejectedValueOnce(new Error('Native clipboard unavailable'));
        await expect(action('clipboard.write', { text: 'platform failure' })).rejects.toMatchObject({ message: 'clipboard_unavailable' });
    });

    it('uses canonical settings admission before a host read can join retained Resource output', async () => {
        const serverId = await homes.addHome({ name: 'Host reads', serverUrl: 'https://host-reads-front-door.test', accountId: 'alice' });
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'settings.get': { enabled: false } } }),
        } }, version: 1 } });
        const execute = createFrontDoorActionExecute();
        expect(await execute.prepare('settings.get', { anchor: 'themePreference' }, {
            surface: 'plugin', serverId, actionCaller: { kind: 'plugin', pluginId: 'acme.preview' },
        })).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_disabled' } });
    });
});
