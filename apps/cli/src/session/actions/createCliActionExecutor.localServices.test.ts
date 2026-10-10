import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL, type ActionExecutorContext, type ActionId } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createLocalServiceActionConfirmationNonceV1, LocalServiceActionRequestV1Schema,
    LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from '@/cli/actions/compiledCommands';
import { runCompiledActionCliCommand } from '@/cli/actions/executeCommand';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

const { io } = vi.hoisted(() => ({ io: vi.fn() }));
// Socket.IO and HTTP are the only replaced boundaries; Action policy, credential
// selection, targeted request framing and Machine content codecs remain real.
vi.mock('socket.io-client', () => ({ io }));

function receivingMachineBoundary(response: unknown, actionId: ActionId = 'localServices.launcher.start', askFirst = false,
    surface: 'cli' | 'agent' | 'mcp' = 'cli') {
    const requests: Array<unknown> = [];
    io.mockImplementation(() => createApiSessionSocketStub({ emitWithAck(event, payload) {
        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
        requests.push(payload);
        return { ok: true, result: response };
    } }));
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url === 'https://selected-home.example/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        expect(url).toBe('https://selected-home.example/v1/machines/machine-a');
        return { status: 200, data: { machine: { id: 'machine-a', kind: 'persistent', storageMode: 'plain',
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null } } };
    });
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
    const approvalActions: string[] = [];
    const { executor } = createCliActionExecutorHarness({ credentials, token: credentials.token, mode: 'plain', ctx: null,
        sessionId: 'session-a', serverId: 'home-a', serverHttpBaseUrl: 'https://selected-home.example',
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(askFirst ? null : {
            v: 1, approvalWaivedSurfaces: { [actionId]: [surface] },
        }), getAccountSettings: () => null },
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
            features: { localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true },
                actions: { enabled: true }, managed: { enabled: true }, preview: { enabled: true }, publicPreview: { enabled: true } },
                browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {},
        }) }),
    }, {
        // Only Artifact persistence is replaced. CLI Ask-first returns this
        // custody immediately; supported per-Action Account settings admit transport.
        approvalsCreate: async ({ request }) => {
            approvalActions.push(request.actionId);
            expect(request).toMatchObject({ executionOriginV1: { surface, serverId: 'home-a',
                machineId: 'machine-a', requestId: 'cli-service-invocation' } });
            return { artifactId: 'reviewed-service-approval' };
        },
    });
    // The invoking CLI host has captured this exact Home/Machine and invocation
    // identity; none are fields of the semantic Action request or authority waiver.
    const context: ActionExecutorContext = { surface, authority: 'present_user', serverId: 'home-a',
        runtimeAccountId: 'owner', actionRequestId: 'cli-service-invocation', defaultSessionId: 'session-a',
        externalActionTarget: { kind: 'machine', machineId: 'machine-a' } };
    return { executor, requests, get, context, approvalActions };
}

describe('credentialed CLI Local Services runtime dispatch', () => {
    afterEach(() => vi.restoreAllMocks());

    it('compiles service discovery and renders actual state through the credentialed Action executor', async () => {
        const snapshot = { v: 1, machineId: 'machine-a', updatedAt: 1, targets: [{ id: 'service-web', machineId: 'machine-a',
            source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'instance-web' },
            title: 'Web', state: 'available', serviceState: 'running', readiness: 'not_reported', endpointKind: 'none', confidence: 'high', actions: [] }] };
        const { executor, requests } = receivingMachineBoundary({ protocolVersion: 1, snapshot }, 'localServices.launcher.snapshot');
        const path = ['services', 'launcher', 'snapshot'];
        const command = findCompiledActionCliCommand(path, listCompiledActionCliCommands());
        expect(command?.path).toEqual(path);
        if (!command) return;
        const output = captureConsoleText();
        try {
            await runCompiledActionCliCommand({ command, argv: [...path, '--server-id', 'home-a', '--machine-id', 'machine-a', '--scope', 'workspace', '--workspace-root', '/accepted'],
                deps: { readCredentialsForServerIdFn: async () => ({ token: 'test-token', encryption: null }),
                    getServerProfileFn: async () => ({ id: 'home-a', name: 'Selected Home', serverUrl: 'https://selected-home.example',
                        webappUrl: 'https://selected-home.example', createdAt: 1, updatedAt: 1, lastUsedAt: 1 }),
                    createExecutorFn: () => ({
                    execute: (actionId, input, context) => executor.execute(actionId, input, { ...context, runtimeAccountId: 'owner' }),
                    resolveSessionTarget: async () => ({ ok: false as const, code: 'not_found' as const }),
                }) } });
            expect(output.text()).toContain('Web');
            expect(output.text()).toContain('running');
            expect(output.text()).toContain('machine-a');
            expect(output.text()).not.toContain('"targets"');
            expect(requests).toHaveLength(1);
        } finally { output.restore(); process.exitCode = undefined; }
    });

    it.each(['cli', 'agent', 'mcp'] as const)('reads source-qualified launcher state through %s without an answering client', async surface => {
        const snapshot = { v: 1, machineId: 'machine-a', updatedAt: 1, targets: [] };
        const { executor, requests, context } = receivingMachineBoundary({ protocolVersion: 1, snapshot }, 'localServices.launcher.snapshot', false, surface);
        const input = { machineId: 'machine-a', scope: 'workspace' as const, workspaceRoot: '/accepted' };
        expect(await executor.execute('localServices.launcher.snapshot', input, context)).toEqual({ ok: true, result: snapshot });
        expect(requests).toEqual([expect.objectContaining({ method: `machine-a:${RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT}`, params: input })]);
    });

    it.each(['localServices.publicPreview.create', 'localServices.publicPreview.revoke'] as const)('preserves a receiving typed refusal for headless %s', async actionId => {
        const refused = { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
        const { executor, requests, context } = receivingMachineBoundary(refused, actionId);
        const input = { machineId: 'machine-a', sessionId: 'session-a', previewId: 'preview-a',
            ...(actionId === 'localServices.publicPreview.create' ? { mode: 'public' as const, ttlMs: 60000, confirmation: { acknowledged: true as const } } : { exposureId: 'exposure-a' }) };
        expect(await executor.execute(actionId, input, context)).toEqual(refused);
        expect(requests).toEqual([expect.objectContaining({ method: `machine-a:${actionId === 'localServices.publicPreview.create'
            ? RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE : RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE}`, params: input })]);
    });

    it.each(['cli', 'agent', 'mcp'] as const)('returns public exposure state to %s with the canonical URL disclosure policy', async surface => {
        const exposure = { exposureId: 'exposure-a', previewId: 'preview-a', sessionId: 'session-a', machineId: 'machine-a',
            mode: 'secret_link', state: 'active', publicUrl: 'https://share.example.test/secret', issuedAt: 1, expiresAt: 60001,
            rateLimitProfileId: 'default', auditEventIds: [] };
        const snapshot = { v: 1, machineId: 'machine-a', generatedAt: 1, refreshState: 'idle',
            policy: { enabled: true, allowedModes: ['secret_link'], dnsTlsRequired: true, auditRequired: true, rateLimitProfileIds: [] }, exposures: [exposure], diagnostics: [] };
        const { executor, requests, context } = receivingMachineBoundary({ protocolVersion: 1, snapshot }, 'localServices.publicPreview.status', false, surface);
        const result = await executor.execute('localServices.publicPreview.status', { machineId: 'machine-a', sessionId: 'session-a', previewId: 'preview-a' }, context);
        expect(result).toMatchObject({ ok: true, result: { exposures: [{ exposureId: 'exposure-a', state: 'active', expiresAt: 60001,
            publicUrl: surface === 'agent' ? REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL : exposure.publicUrl }] } });
        expect(requests).toHaveLength(1);
    });

    it.each([
        ['localServices.inventory.list', RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT],
        ['localServices.inventory.refresh', RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH],
        ['localServices.preview.status', RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT],
    ] as const)('reads %s through its existing exact Machine snapshot boundary', async (actionId, method) => {
        const snapshot = actionId === 'localServices.preview.status'
            ? { v: 1, machineId: 'machine-a', generatedAt: 1, refreshState: 'idle', resources: [], previews: [], diagnostics: [] }
            : { v: 1, machineId: 'machine-a', generatedAt: 1, refreshState: 'idle', entries: [], diagnostics: [] };
        const { executor, requests, context } = receivingMachineBoundary({ protocolVersion: 1, snapshot }, actionId);
        expect(await executor.execute(actionId, { machineId: 'machine-a' }, context)).toEqual({ ok: true, result: snapshot });
        expect(requests).toEqual([expect.objectContaining({ method: `machine-a:${method}`, params: { machineId: 'machine-a' } })]);
    });

    it('registers private preview metadata and clears scoped history without performing navigation or Stop', async () => {
        const registration = { protocolVersion: 1, status: 'unavailable', targetId: 'service-web', reasonCode: 'target_unavailable' };
        const first = receivingMachineBoundary(registration, 'localServices.launcher.registerPreview');
        const input = { machineId: 'machine-a', targetId: 'service-web', scope: 'workspace' as const, workspaceRoot: '/accepted' };
        expect(await first.executor.execute('localServices.launcher.registerPreview', input, first.context)).toEqual({ ok: true, result: registration });
        expect(first.requests).toEqual([expect.objectContaining({ method: `machine-a:${RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW}`, params: input })]);
        vi.restoreAllMocks();
        const cleared = { protocolVersion: 1, cleared: 2, snapshot: { v: 1, machineId: 'machine-a', updatedAt: 1, targets: [] } };
        const second = receivingMachineBoundary(cleared, 'localServices.launcher.history.clear');
        expect(await second.executor.execute('localServices.launcher.history.clear', input, second.context)).toEqual({ ok: true, result: cleared });
        expect(second.requests).toEqual([expect.objectContaining({ method: `machine-a:${RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR}`, params: input })]);
    });

    it('rejects unexpected authority fields before sending a service discovery request', async () => {
        const { executor, requests, context } = receivingMachineBoundary(null, 'localServices.inventory.list');
        expect(await executor.execute('localServices.inventory.list', { machineId: 'machine-a', actorAccountId: 'forged' }, context))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(requests).toEqual([]);
    });

    it.each(['localServices.preview.openOrCreate', 'localServices.preview.revoke'] as const)('keeps %s on the exact sessionless service binding', async actionId => {
        const refused = { ok: false, errorCode: 'service_unavailable', error: 'service_unavailable' };
        const { executor, requests, context } = receivingMachineBoundary(refused, actionId);
        const input = { machineId: 'machine-a', serviceTarget: { kind: 'managed_service' as const, machineId: 'machine-a',
            managedServiceId: 'instance-web', cwd: '/accepted', declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest' as const, name: 'web' } } },
            ...(actionId === 'localServices.preview.revoke' ? { previewId: 'preview-a' } : {}) };
        expect(await executor.execute(actionId, input, context)).toEqual(refused);
        expect(requests).toEqual([expect.objectContaining({ method: `machine-a:${actionId === 'localServices.preview.openOrCreate'
            ? RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE : RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE}`, params: input })]);
    });

    it.each(['inventoryEntryId', 'managedServiceId', 'launchTargetId'] as const)('preserves the private-preview %s selector and initial path', async selector => {
        const refused = { ok: false, errorCode: 'service_unavailable', error: 'service_unavailable' };
        const { executor, requests, context } = receivingMachineBoundary(refused, 'localServices.preview.openOrCreate');
        const input = { machineId: 'machine-a', sessionId: 'session-a', [selector]: 'current-target',
            initialPath: { pathname: '/accepted', search: '?view=web' } };
        expect(await executor.execute('localServices.preview.openOrCreate', input, context)).toEqual(refused);
        expect(requests).toEqual([expect.objectContaining({ params: input })]);
    });

    it.each(['review', 'approval_rejected'] as const)('uses the exact current Home/Machine and preserves receiving %s with Project provenance', async outcome => {
        const review = DaemonLocalServiceLauncherStartResponseV1Schema.parse({ protocolVersion: 1,
            machineId: 'machine-a', targetId: 'project-service:selected', status: 'denied',
            reasonCode: 'project_service_effect_review_required', reviewedEffect: { command: { cwd: '/accepted', source: 'current-file' } },
            reviewedEffectDigest: 'b'.repeat(64), snapshot: { v: 1, machineId: 'machine-a', updatedAt: 1, targets: [] } });
        const rejection = { ok: false as const, errorCode: 'approval_rejected', error: 'approval_rejected' };
        const response = outcome === 'review' ? review : rejection;
        const { executor, requests, get, context } = receivingMachineBoundary(response);
        const input = { machineId: 'machine-a', targetId: 'project-service:selected',
            workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/accepted' },
            declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest' as const, name: 'web' } },
            expectedEffectDigest: 'a'.repeat(64) };
        expect(await executor.execute('localServices.launcher.start', input, context))
            .toEqual(outcome === 'review' ? { ok: true, result: review } : rejection);
        expect(get).toHaveBeenCalled();
        expect(requests).toEqual([expect.objectContaining({ method: `machine-a:${RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START}`,
            params: { v: 1, kind: 'targeted_action_rpc', input, target: { kind: 'machine', machineId: 'machine-a' }, defaultSessionId: 'session-a' } })]);
    });
    it('sends Stop for the exact owned occurrence through its canonical Action RPC and preserves its typed refusal', async () => {
        const response = LocalServiceActionResultV1Schema.parse({ v: 1, requestId: 'stop-current', action: 'stop_managed',
            status: 'denied', reasonCode: 'managed_service_stop_unavailable', auditEvents: [] });
        const { executor, requests, get, context } = receivingMachineBoundary(response, 'localServices.actions.stopManaged');
        const reviewed = LocalServiceActionRequestV1Schema.parse({ requestId: 'stop-current', action: 'stop_managed',
            confirmationNonce: 'placeholder', target: { kind: 'managed_service', managedServiceId: 'actual-instance',
                machineId: 'machine-a', workspaceId: 'accepted', cwd: '/accepted/web',
                declaration: { workspaceRefId: 'accepted', selection: { kind: 'native',
                    source: { kind: 'native', tool: 'package_script', file: 'web/package.json', target: 'dev' } } } } });
        const input = { ...reviewed, confirmationNonce: createLocalServiceActionConfirmationNonceV1(reviewed) };
        expect(await executor.execute('localServices.actions.stopManaged', input, context))
            .toEqual({ ok: true, result: response });
        expect(get).toHaveBeenCalled();
        expect(requests).toEqual([expect.objectContaining({ method: `machine-a:${RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_STOP_MANAGED}`,
            params: { v: 1, kind: 'targeted_action_rpc', input, target: { kind: 'machine', machineId: 'machine-a' }, defaultSessionId: 'session-a' } })]);
    });
    it('returns the default CLI approval Artifact without issuing a Machine effect', async () => {
        const { executor, requests, get, context, approvalActions } = receivingMachineBoundary(null, 'localServices.launcher.start', true);
        expect(await executor.execute('localServices.launcher.start', { machineId: 'machine-a', targetId: 'project-service:selected' }, context))
            .toEqual({ ok: true, result: { kind: 'approval_request_created', artifactId: 'reviewed-service-approval', actionId: 'localServices.launcher.start' } });
        expect(approvalActions).toEqual(['localServices.launcher.start']);
        expect(requests).toEqual([]);
        expect(get).not.toHaveBeenCalled();
    });
    it.each([
        ['localServices.actions.copyUrl', 'copy_url'],
        ['localServices.actions.openPreview', 'open_preview'],
    ] as const)('does not present %s permission as a completed client effect without an answering client', async (actionId, action) => {
        const permission = LocalServiceActionResultV1Schema.parse({ v: 1, requestId: 'client-effect', action,
            status: 'succeeded', auditEvents: [] });
        const { executor, requests, get, context } = receivingMachineBoundary(permission, actionId);
        const input = LocalServiceActionRequestV1Schema.parse({ requestId: 'client-effect', action,
            target: { kind: 'managed_service', managedServiceId: 'actual-instance', machineId: 'machine-a',
                workspaceId: 'accepted', cwd: '/accepted/web' } });
        expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: false, errorCode: 'action_disabled',
            details: { reason: 'unsupported_surface', surface: 'cli' } });
        expect(requests).toEqual([]);
        expect(get).not.toHaveBeenCalled();
    });
    it.each([
        ['localServices.actions.copyUrl', 'copy_url'],
        ['localServices.actions.openPreview', 'open_preview'],
        ['localServices.launcher.openPreview', null],
        ['localServices.publicPreview.copyUrl', null],
    ] as const)('keeps answering-client effect %s headless fail-closed', async (actionId, action) => {
        const { executor, requests, get, context } = receivingMachineBoundary(null, actionId, false, 'agent');
        const input = action ? LocalServiceActionRequestV1Schema.parse({ requestId: 'agent-client-effect', action,
            target: { kind: 'managed_service', managedServiceId: 'actual-instance', machineId: 'machine-a',
                workspaceId: 'accepted', cwd: '/accepted/web' } })
            : { machineId: 'machine-a', targetId: 'service-web', previewId: 'preview-a', exposureId: 'exposure-a' };
        expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        expect(requests).toEqual([]);
        expect(get).not.toHaveBeenCalled();
    });
});
