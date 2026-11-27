import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { changeTextTestInstance, renderScreen } from '@/dev/testkit';
import { ActionInputFormModal } from '@/components/plugins/actions/ActionInputFormModal';
import { registerAuthoredAccountActionRelease } from '../../../../../cli/src/plugins/runtime/accountPluginActions.testkit';
import { installAxiosFastifyAdapter } from '../../../../../cli/src/testkit/http/axiosAdapter';
import { createCliActionExecutor } from '../../../../../cli/src/session/actions/createCliActionExecutor';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createPluginContributedActionController } from '@/components/plugins/actions/pluginContributedActionController';
import { buildV2PluginProjectionById } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import { executeAccountActionAtRuntimeHost } from '@/components/plugins/surfaces/accountActionPlacement';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { createAccountTokenForTests } from './homeGovernanceHarness';
import { createHomeHubArtifactHttpBoundary } from './homeHubArtifactHttpBoundary';
import { createExternalActionAccountHttpBoundary } from './externalActionAccountHttpBoundary';
import { installPortableAccountPluginReleaseForTest } from './portableAccountPlugin';
import { restoreServerAccountForTest } from './serverAccountConnectionHarness';
import { installSessionOpsNetworkBoundary } from './sessionOpsNetworkBoundary';
import { buildDeferredDaemonProjectionSections, PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('socket.io-client', async importOriginal => (
    await import('./sessionOpsNetworkBoundary')
).createSessionOpsSocketIoClientBoundary(importOriginal));
// Browser transport is the physical boundary; all placement and carrier code stays real.
vi.mock('@/utils/platform/tauri/transferFetch', () => ({ resolveTauriRuntimeFetch: async () => null }));

it('compares the filled W30 UI form with real dispatch and preserves validator refusals in Technical details', async () => {
    const home = await mkdtemp(join(tmpdir(), 'portable-browser-dispatch-'));
    const app = fastify();
    const network = await installSessionOpsNetworkBoundary();
    const plugin = definePlugin({ id: 'qa.w30-portable', version: '0.1.0', actions: {
        note: { title: 'W30 portable note', surfaces: ['ui', 'cli', 'agent', 'plugin'], scopes: ['global'],
            placementBindings: ['commandPalette'], dangerLevel: 'safe',
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } },
            inputSchema: defineProtocolObject({ note: defineProtocolString() }, { policy: 'closed' }),
            run: async input => ({ note: input.note, marker: 'w30-portable' }),
        },
    } });
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    let installed: Awaited<ReturnType<typeof installPortableAccountPluginReleaseForTest>> | undefined;
    let restore: (() => void) | undefined;
    try {
        await writeFile(join(home, 'package.json'), JSON.stringify({ name: plugin.manifest.id }));
        const entryPath = join(home, 'account.ts');
        await writeFile(entryPath, `import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
export const { manifest, activateAccount: activate } = definePlugin({id:'qa.w30-portable',version:'0.1.0',actions:{note:{
title:'W30 portable note',surfaces:['ui','cli','agent','plugin'],scopes:['global'],placementBindings:['commandPalette'],dangerLevel:'safe',
execution:{target:'account',account:{artifactId:'account-runtime',exportName:'activate'}},
inputSchema:defineProtocolObject({note:defineProtocolString()},{policy:'closed'}),run:async input=>({note:input.note,marker:'w30-portable'})}}});`);
        await registerAuthoredAccountActionRelease(app, 'owner', { primary: {
            manifest: plugin.manifest, projectRoot: home, entryPath, activateExport: 'activate',
        } });
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
        await app.ready();
        restore = installAxiosFastifyAdapter({ app, origin: 'http://portable-dispatch.test' });
        const executor = createCliActionExecutor({ token: 'fixture', credentials: {
            token: 'fixture', encryption: null, credentialProvenance: 'stored_session' },
            happyHomeDir: home, sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'portable-dispatch',
            serverHttpBaseUrl: 'http://portable-dispatch.test' });
        let validatedInput: unknown;
        let failureOverride: ReturnType<typeof ActionExecuteResultSchema.parse> | undefined;
        let boundary: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>> | undefined;
        const accountId = 'portable-browser';
        const fallback = createHomeHubArtifactHttpBoundary(accountId);
        const httpPaths: string[] = [];
        let sentInput: unknown;
        connection = await restoreServerAccountForTest({ serverUrl: 'http://portable-browser.test', serverIdentityId: 'srv_portable_browser', accountId,
            credentials: { token: createAccountTokenForTests(accountId, { currentAccount: true }) },
            request: async (url, init) => {
                const parsedUrl = new URL(String(url));
                httpPaths.push(parsedUrl.pathname);
                if (parsedUrl.pathname === '/v1/actions/action.invoke') {
                    const body: unknown = JSON.parse(String(init?.body));
                    const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
                    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : body);
                    sentInput = envelope.input;
                }
                return await boundary?.handle(parsedUrl, init) ?? fallback.request(url, init);
            } });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected Account lifetime');
        boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'http://portable-browser.test',
            serverIdentityId: 'srv_portable_browser', accountId, machineId: 'portable-machine', installationId: 'portable-installation', actionId: 'action.invoke',
            tokenEpoch: 0, requesterInvocation: 'required', execute: async (input, context) => {
                validatedInput = input;
                const result = failureOverride ?? await executor.execute('action.invoke', input, { surface: context.invocation.surface,
                    authority: context.invocation.authority, actionCaller: context.invocation.caller });
                return result.ok ? result.result : result;
            }, failure: result => {
                const parsed = ActionExecuteResultSchema.safeParse(result);
                return parsed.success && !parsed.data.ok ? parsed.data : null;
            } });
        installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
            activate: plugin.activateAccount, accountLifetime: lifetime, publishProjection: true });
        const { readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
        const projection = readPluginAccountAvailability(lifetime.scope).readAccountUiProjection();
        if (!projection) throw new Error('Expected released Account projection');
        const snapshot = buildDeferredDaemonProjectionSections({ protocolVersion: 1, projectionDigest: 'a'.repeat(64), projection: {
            v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [],
            actionsById: Object.fromEntries(Object.entries(projection.actionsById).map(([id, action]) => [id,
                PluginProjectedActionV2Schema.parse(Object.fromEntries(Object.entries(action)
                    .filter(([key]) => Object.hasOwn(PluginProjectedActionV2Schema.shape, key)))),
            ])),
        } });
        network.setRpcResponder(async request => {
            const read = (request.payload as { sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } })?.sectionRead;
            return read ? snapshot.read(read.digest, read.offset, read.includeDigests) : snapshot.manifest;
        });
        const { createMachineFixture } = await import('../fixtures/machineFixtures');
        const { publishMachineInventoryForTest } = await import('./machinePresence');
        const machine = createMachineFixture({ id: boundary.machine.id, installationId: boundary.machine.installationId,
            installationPublicKey: boundary.machine.installationPublicKey, access: boundary.machine.access });
        await publishMachineInventoryForTest(lifetime.scope, [machine]);
        const { loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        const loaded = await loadDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId: lifetime.scope.serverId,
            accountLifetime: lifetime, sections: ['actionsById'], reuseFreshReady: true });
        if (loaded?.kind !== 'ready') throw new Error(JSON.stringify({ stage: 'fixture_registry', kind: loaded?.kind,
            reason: loaded && 'reason' in loaded ? loaded.reason : undefined }));
        const controller = createPluginContributedActionController({ resolveCurrent: () => ({
            pluginProjectionById: buildV2PluginProjectionById(projection), pluginUiProjection: projection,
            resolveContributedAction: createPluginUiProjectedActionResolver(projection.actionsById),
            host: { serverId: lifetime.scope.serverId, machineId: null, accountLifetime: lifetime },
        }) });
        const descriptor = controller.list({ placement: 'commandPalette', scope: 'global' })[0];
        if (!descriptor) throw new Error('Expected W30 form declaration');
        const opened = await controller.open(descriptor);
        if (opened.kind !== 'form') throw new Error('Expected schema-derived form');
        const field = opened.form.getFields().find(field => field.path === 'note');
        if (!field) throw new Error('Expected schema-derived note control');
        const screen = await renderScreen(React.createElement(ActionInputFormModal, {
            form: opened.form, onClose: () => undefined,
        }));
        const control = screen.findAllByType('TextInput')[0];
        if (!control) throw new Error('Expected SDK note input control');
        await act(async () => { changeTextTestInstance(control, 'synthetic-note'); });
        const formInput = opened.form.getInput();
        let submitted!: Awaited<ReturnType<typeof opened.form.submit>>;
        await act(async () => { submitted = await opened.form.submit(); });
        await screen.unmount();
        const { readSafeFailureDetails } = await import('@/utils/errors/alertActionFailure');
        if (!validatedInput) throw new Error(JSON.stringify({ stage: 'dispatch_not_reached', kind: submitted.kind,
            methods: network.requests.map(request => request.method), httpPaths,
            ...(submitted.kind === 'settled' ? { code: submitted.outcome.code,
                details: readSafeFailureDetails(submitted.outcome.details) } : {}) }));
        // Boolean comparisons keep submitted values out of failure output.
        expect(sameStrictJsonValue(validatedInput, sentInput)).toBe(true);
        expect(sameStrictJsonValue((validatedInput as { input?: unknown }).input, formInput)).toBe(true);
        expect(submitted.kind === 'settled' && submitted.outcome.ok).toBe(true);
        expect(submitted.kind === 'settled' && submitted.outcome.ok
            && sameStrictJsonValue(submitted.outcome.result, { ...formInput, marker: 'w30-portable' })).toBe(true);

        const invoke = async (input: unknown) => {
            try {
                await executeAccountActionAtRuntimeHost({ accountScope: lifetime.scope,
                    action: { pluginId: plugin.manifest.id, localId: 'note' }, execution: {
                        target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } },
                    input, context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, externalActionTarget: { kind: 'machine', machineId: boundary!.machine.id } },
                    signal: new AbortController().signal, executeLocal: () => { throw new Error('Expected daemon placement'); } });
            } catch (error) {
                if (error instanceof PluginError) return error;
                throw error;
            }
            throw new Error('Expected validator refusal');
        };
        const refused = await invoke({});
        expect(refused.code).toBe('plugin_action_input_schema_invalid');
        expect(refused.data.failureCause).toBeUndefined();
        expect(refused.details).toMatchObject({ issues: expect.arrayContaining([
            expect.objectContaining({ path: ['note'], code: expect.any(String) }),
        ]) });
        // A supplied validator identity must survive; arbitrary issue prose/values must not be presented.
        failureOverride = { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters',
            details: { issues: [{ path: ['note'], code: 'invalid_type', value: 'private', message: 'private' },
                { path: ['nested', 1, 'note'], code: 'too_small', minimum: 'private' }] },
            failureCause: { phase: 'dispatch', errorClass: 'ZodError', errorCode: 'invalid_parameters', httpStatus: null } };
        const identified = await invoke({});
        expect(identified.data.failureCause).toEqual(failureOverride.failureCause);
        const presentation = presentActionExecutionFailure({ errorCode: identified.code, details: identified.details,
            failureCause: identified.data.failureCause });
        expect(presentation.technicalDetails).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'errorClass', value: 'ZodError' }),
            expect.objectContaining({ key: 'issues.0.path', value: '["note"]' }),
            expect.objectContaining({ key: 'issues.0.code', value: 'invalid_type' }),
            expect.objectContaining({ key: 'issues.1.path', value: '["nested",1,"note"]' }),
            expect.objectContaining({ key: 'issues.1.code', value: 'too_small' }),
        ]));
        expect(JSON.stringify(presentation.technicalDetails).includes('private')).toBe(false);
    } finally {
        await installed?.dispose(); await connection?.dispose(); restore?.();
        await app.close(); await network.dispose(); await rm(home, { recursive: true, force: true });
    }
});
