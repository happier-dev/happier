import { describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { accountSettingsParse } from '@happier-dev/protocol';
import { TriageSourcesContributionProtocolV1 } from '@happier-dev/triage-protocol/v1';
import type { DaemonPluginMountedInvocationV1 } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { DaemonPluginStructuredMessageActionExecuteResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionOutputV1Schema, normalizePluginReleaseFactsV1 } from '@happier-dev/protocol/plugins/availability';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';
import { createDeferred } from '@/testkit/async/deferred';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { invokeAccountMachineSourceAction } from '@/plugins/runtime/invocation/actions/accountMachineActionTransport';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';

describe('mounted caller admission through the real contributed Action RPC', () => {
    it('refuses unbound raw Machine Actions and correlates composer requests without replacing execution identity', async () => {
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
            manifest: createPluginManifestV2Fixture({ id: 'acme.composer', contributes: { actions: [
                { id: 'install', title: 'Native install', scopes: ['global'], surfaces: ['ui'], dangerLevel: 'safe', placementBindings: [], execution: { target: 'daemon' } },
                { id: 'submit', title: 'Submit', scopes: ['global'], surfaces: ['ui'], dangerLevel: 'safe', placementBindings: ['composer.primary'], execution: { target: 'daemon' } },
            ] } }),
            files: { 'daemon.mjs': `let effects = 0; export function activate(api) {
                api.actions.register('install', () => ({ effects: ++effects }));
                api.actions.register('submit', () => ({ effects: ++effects }));
            }` },
        }] });
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        // The local file sink is the OS boundary; registered ingress and plugin execution stay real.
        const log = vi.spyOn(logger, 'debugLocalFile').mockImplementation(() => {});
        try {
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => fixture.registry, resolveInstalledPackages: async () => [],
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
            const occurrence = fixture.registry.readPluginOccurrenceId?.('acme.composer');
            if (!handler || !occurrence) throw new Error('Expected real authored Action runtime');
            const request = { machineId: 'machine-1', qualifiedActionId: 'acme.composer/install',
                expectedContributorOccurrenceId: occurrence, executionSurface: 'ui', input: {} };
            const submitted = { ...request, qualifiedActionId: 'acme.composer/submit', sessionId: 'requester-session',
                invocation: { kind: 'hostPresentedComposer', currentComposerIntent: {
                    composer: { kind: 'session', sessionId: 'requester-session' }, revision: 1,
                } } };
            const uiRequestId = '70cc64d3-0386-4914-b7d8-713b7879e99f';
            const transportId = 'fd0b0146-17a5-431c-bc69-3a3fa865b1d7';
            const authorityId = '1137cf2a-27cf-481b-b28f-951fc49f9c65';
            const refusedContext = { signal: new AbortController().signal, transportRequestId: `rpc_${transportId}` };
            expect(await handler({ ...request, requestId: uiRequestId, input: { marker: 'PRIVATE_REFUSED_INPUT' } }, refusedContext))
                .toEqual({ ok: false, code: 'plugin_action_unavailable' });
            expect(log.mock.calls).toContainEqual(['[external-action-stage]', {
                actionId: 'action.invoke', rootRequestId: uiRequestId, stage: 'contributed.request', transportRequestId: transportId,
            }]);
            expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_');
            for (const refused of [
                { input: { ...request, requestId: 'PRIVATE_AUTHORED_REQUEST' }, code: 'plugin_action_unavailable' },
                { input: { ...request, requestId: uiRequestId, privatePayload: 'PRIVATE_INVALID_PAYLOAD' }, code: 'plugin_structured_message_action_request_invalid' },
            ]) {
                log.mockClear();
                expect(await handler(refused.input, refusedContext)).toEqual({ ok: false, code: refused.code });
                expect(log.mock.calls.some(([message]) => message === '[external-action-stage]')).toBe(false);
                expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_');
            }
            const cases = [
                { requestId: uiRequestId, actionRequestId: undefined, root: transportId, paired: true },
                { requestId: uiRequestId, actionRequestId: authorityId, root: authorityId, paired: true },
                { requestId: undefined, actionRequestId: undefined, root: transportId, paired: false },
                { requestId: 'PRIVATE_AUTHORED_REQUEST', actionRequestId: undefined, root: transportId, paired: false },
            ];
            let effects = 0;
            for (const candidate of cases) {
                log.mockClear();
                expect(await handler({ ...submitted, input: { marker: 'PRIVATE_ACTION_INPUT' },
                    ...(candidate.requestId ? { requestId: candidate.requestId } : {}),
                }, { signal: new AbortController().signal, transportRequestId: `rpc_${transportId}`,
                    ...(candidate.actionRequestId ? { localActionContext: { actionRequestId: candidate.actionRequestId } } : {}),
                })).toEqual({ ok: true, result: { effects: ++effects } });
                const stages = log.mock.calls.filter(([message]) => message === '[external-action-stage]');
                if (candidate.paired) expect(stages).toContainEqual(['[external-action-stage]', {
                    actionId: 'action.invoke', rootRequestId: uiRequestId, stage: 'contributed.request', transportRequestId: candidate.root,
                }]);
                else expect(stages.some(([, record]) => record && typeof record === 'object'
                    && 'stage' in record && record.stage === 'contributed.request')).toBe(false);
                // Approval/execution keep their admitted identity; the diagnostic pair only lets a reader find it.
                expect(stages).toContainEqual(['[external-action-stage]', expect.objectContaining({
                    actionId: 'action.invoke', rootRequestId: candidate.root, stage: 'contributed.handler.end',
                })]);
                expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_');
            }
        } finally { log.mockRestore(); vi.unstubAllEnvs(); await fixture.dispose(); }
    });

    it.each(['ui', 'cli', 'page', 'source'] as const)('admits an external Account caller from %s and refuses relabeled automation or changed custody before effects', async callerSurface => {
        const executionSurface = callerSurface === 'cli' ? 'cli' : 'ui';
        const mountedSurface = callerSurface === 'page' || callerSurface === 'source';
        const contributionLocalId = callerSurface === 'source' ? 'source' : callerSurface === 'page' ? 'page' : 'aggregate';
        const pluginId = 'com.acme.account-aggregate';
        const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({ id: pluginId, entrypoints: {}, contributes: {
            ui: { renderers: [{ id: 'panel', kind: 'declarative', root: { kind: 'text', text: 'Account page' } }],
                views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, renderer: 'panel' }] },
            targetedPluginContributions: [{ id: 'source', target: { pluginId: 'com.acme.detail-host', pointId: 'details' },
                protocol: { id: 'detail', version: 1 }, operations: {}, surfaces: { detail: { renderer: 'panel' } } }],
            actions: [{ id: 'aggregate', title: 'Aggregate', scopes: ['global'], surfaces: ['ui', 'cli'], dangerLevel: 'safe',
                placementBindings: [], execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } }],
        } }));
        let enabled = true;
        let accountToken = 'account-a';
        let digest = `sha256:${'a'.repeat(64)}`;
        let revokeAfterRead = false;
        // Only Artifact persistence and the user's decision are boundaries; the approval adapter and Action policy are real.
        const approvalRows = new Map<string, TargetActionApprovalRequestV1>();
        const lifetime = new AbortController();
        const publication = createDeferred<'unexposedApproval'>();
        const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
            create: async request => {
                const artifactId = `account-source-approval-${approvalRows.size + 1}`;
                approvalRows.set(artifactId, request);
                publication.resolve('unexposedApproval');
                return { artifactId };
            },
            read: async artifactId => {
                const row = approvalRows.get(artifactId);
                return row ?? null;
            },
            update: async ({ artifactId, request }) => { approvalRows.set(artifactId, request); return { ok: true }; },
        });
        const app = fastify();
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async request => {
            const response = PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
                hostingCapability: { enabled: false }, intent: { pluginId, desiredVersion: manifest.version,
                    enabled: enabled && request.headers.authorization !== 'Bearer account-b',
                    offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
                release: normalizePluginReleaseFactsV1({ ref: { pluginId, version: manifest.version }, archiveDigestSha256: digest,
                    normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] } }),
                uiArtifacts: [], packageAssets: [] });
            if (revokeAfterRead) enabled = false;
            return response;
        });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-caller.test' });
        // The temporary external plugin imports the real public SDK from the host's installed package.
        const sdkEntry = pathToFileURL(createRequire(import.meta.url).resolve('@happier-dev/plugin-sdk')).href;
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
            manifest: createPluginManifestV2Fixture({ id: 'com.acme.machine-source', contributes: {
                actions: [{ id: 'read', title: 'Read source', scopes: ['global'],
                    surfaces: mountedSurface ? ['ui'] : TriageSourcesContributionProtocolV1.operations.scan.declaration.surfaces,
                    placementBindings: [], dangerLevel: 'safe',
                    execution: { target: 'daemon' }, inputSchema: { type: 'object', additionalProperties: false },
                    resultSchema: { type: 'object', additionalProperties: true } },
                { id: 'write', title: 'Write source', scopes: ['global'], surfaces: mountedSurface ? ['ui'] : ['plugin'], placementBindings: [], dangerLevel: 'writesRemote',
                    confirmation: { title: 'Write source' }, execution: { target: 'daemon' },
                    inputSchema: { type: 'object', properties: { uncertain: { type: 'boolean' } }, additionalProperties: false },
                    resultSchema: { type: 'object', properties: { writes: { type: 'number' } }, required: ['writes'], additionalProperties: false } },
                { id: 'cli-only', title: 'CLI-only source', scopes: ['global'], surfaces: ['cli'], placementBindings: [], dangerLevel: 'writesRemote',
                    confirmation: { title: 'Write CLI-only source' },
                    execution: { target: 'daemon' }, inputSchema: { type: 'object', additionalProperties: false },
                    resultSchema: { type: 'object', properties: { writes: { type: 'number' } }, required: ['writes'], additionalProperties: false } },
                { id: 'session-only', title: 'Session-only source', scopes: ['session'], surfaces: ['ui', 'plugin'], placementBindings: [], dangerLevel: 'writesRemote',
                    confirmation: { title: 'Write Session-only source' },
                    execution: { target: 'daemon' }, inputSchema: { type: 'object', additionalProperties: false },
                    resultSchema: { type: 'object', properties: { writes: { type: 'number' } }, required: ['writes'], additionalProperties: false } }],
            } }), files: { 'daemon.mjs': `import { PluginError } from ${JSON.stringify(sdkEntry)};
                let reads = 0; let writes = 0;
                export function activate(api) {
                    api.actions.register('read', (_input, context) => ({ reads: ++reads, writes, caller: context.caller }));
                    api.actions.register('write', input => {
                        writes++;
                        if (input.uncertain) throw new PluginError({ code: 'plugin_action_outcome_unknown', message: 'Response lost after effect' });
                        return { writes };
                    });
                    api.actions.register('cli-only', () => ({ writes: ++writes }));
                    api.actions.register('session-only', () => ({ writes: ++writes }));
                }` },
        }], runtimeOptions: { resolveCurrentMachineId: () => 'reading-machine',
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_account-caller', machineId: 'reading-machine' }) } })
            .catch(async error => { restore(); await app.close(); throw error; });
        try {
            // Keep the Account policy fixture independent of the developer's CLI override.
            vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => fixture.registry, resolveInstalledPackages: async () => [],
                requestCurrentIntent,
                resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_account-caller', machineId: 'reading-machine' }),
                resolveAccountPluginExecutionSelection: currentPluginId => readCurrentAccountPluginExecutionSelection({ pluginId: currentPluginId,
                    credentials: { token: accountToken, encryption: null }, serverUrl: 'http://account-caller.test' }),
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
            const targetOccurrence = fixture.registry.readPluginOccurrenceId?.('com.acme.machine-source');
            if (!handler || !targetOccurrence) throw new Error('Expected source Action RPC');
            expect(fixture.registry.readPluginOccurrenceId?.(pluginId)).toBeNull();
            const clientActionBinding = { pluginId, contributionLocalId, occurrenceId: 'invoking-process-occurrence',
                sourceCustody: { kind: 'account_release' as const, pluginId, version: manifest.version, archiveDigestSha256: digest } };
            const run = (binding = clientActionBinding, input: Record<string, unknown> = {}, localId = 'read', presentUserIntent?: 'confirmed', requestSurface: string = executionSurface,
                callerAuthority: RpcHandlerContext['callerAuthority'] = executionSurface === 'ui' ? 'present_user' : 'account_automation') => handler({ machineId: 'reading-machine',
                qualifiedActionId: `com.acme.machine-source/${localId}`, expectedContributorOccurrenceId: targetOccurrence,
                executionSurface: requestSurface, invocation: mountedSurface
                    ? { kind: 'mountedPluginSurface', mountedBinding: binding }
                    : { kind: 'clientPluginAction', clientActionBinding: binding }, input,
                ...(presentUserIntent ? { presentUserIntent } : {}) }, { signal: lifetime.signal, callerAuthority });
            // The physical UI/CLI origin does not expose this role as a root Action.
            if (!mountedSurface) expect(await handler({ machineId: 'reading-machine', qualifiedActionId: 'com.acme.machine-source/read',
                expectedContributorOccurrenceId: targetOccurrence, executionSurface, input: {} }))
                .toMatchObject({ ok: false, code: 'plugin_action_unavailable' });
            if (executionSurface === 'ui') {
                // Home's authenticated RPC context, not the copied current carrier,
                // distinguishes automation from the person's native confirmation.
                expect(await run(clientActionBinding, {}, 'write', 'confirmed', 'ui', 'account_automation'))
                    .toMatchObject({ ok: false, code: 'plugin_action_current_intent_unavailable' });
                expect(approvalRows.size).toBe(0);
            }
            expect(await run()).toEqual({ ok: true, result: { reads: 1, writes: 0, caller: { kind: 'plugin', pluginId,
                contribution: { id: contributionLocalId, qualifiedId: `${pluginId}/${contributionLocalId}` }, occurrenceId: clientActionBinding.occurrenceId,
                sourceCustody: clientActionBinding.sourceCustody, originSurface: executionSurface } } });
            if (executionSurface === 'ui') {
                for (const assertedSurface of ['plugin', 'background']) {
                    expect(await run(clientActionBinding, {}, 'write', 'confirmed', assertedSurface))
                        .toEqual({ ok: false, code: 'plugin_structured_message_action_request_invalid' });
                }
                setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'native-target-policy', settingsVersion: 1,
                    loadedAtMs: 1, settingsSecretsReadKeys: [], settings: accountSettingsParse({ actionsSettingsV1: {
                        v: 1, actions: { 'com.acme.machine-source/actions/write': { enabled: false } },
                    } }) });
                expect(await run(clientActionBinding, {}, 'write', 'confirmed'))
                    .toMatchObject({ ok: false, code: 'plugin_action_unavailable' });
                resetActiveAccountSettingsSnapshotForTests();
                expect(await run(clientActionBinding, {}, 'cli-only', 'confirmed'))
                    .toMatchObject({ ok: false, code: 'plugin_action_unavailable' });
                expect(await run(clientActionBinding, {}, 'session-only', 'confirmed'))
                    .toMatchObject({ ok: false, code: 'plugin_action_session_required' });
            }
            if (mountedSurface) {
                expect(await run({ ...clientActionBinding, contributionLocalId: 'undeclared-source' }))
                    .toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
                if (callerSurface === 'source') {
                    // Home's authenticated Account selection is the boundary: B has disabled
                    // this same plugin and cannot borrow A's declared mounted source.
                    accountToken = 'account-b';
                    expect(await run(clientActionBinding, {}, 'write', 'confirmed'))
                        .toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
                    accountToken = 'account-a';
                    expect(await run(clientActionBinding, {}, 'write', 'confirmed'))
                        .toEqual({ ok: true, result: { writes: 1 } });
                }
                digest = `sha256:${'b'.repeat(64)}`;
                expect(await run()).toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
                digest = clientActionBinding.sourceCustody.archiveDigestSha256;
                enabled = false;
                expect(await run()).toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
                enabled = true;
                expect(await run()).toMatchObject({ ok: true, result: { reads: 2 } });
                return;
            }
            for (const [index, override] of [{ disabledSurfaces: ['plugin'] }, { enabled: false }, {}].entries()) {
                setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'account-source-policy', settingsVersion: index + 1,
                    loadedAtMs: index + 1, settingsSecretsReadKeys: [], settings: accountSettingsParse({ actionsSettingsV1: {
                        v: 1, actions: { 'com.acme.machine-source/actions/read': override },
                    } }) });
                if (index < 2) expect(await run()).toMatchObject({ ok: false, code: 'plugin_action_unavailable' });
            }
            expect(await run(clientActionBinding, { unknown: true })).toMatchObject({ ok: false });
            digest = `sha256:${'b'.repeat(64)}`;
            expect(await run()).toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            digest = clientActionBinding.sourceCustody.archiveDigestSha256;
            revokeAfterRead = true;
            expect(await run()).toMatchObject({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            enabled = true;
            revokeAfterRead = false;
            expect(await run()).toMatchObject({ ok: true, result: { reads: 2 } });
            if (executionSurface === 'ui') {
                // UI carries its own settled confirmation; it cannot borrow the CLI Artifact presenter.
                expect(await run(clientActionBinding, {}, 'write'))
                    .toMatchObject({ ok: false, code: 'plugin_action_current_intent_unavailable' });
                // Loop the network boundary into the real receiving ingress. A
                // direct handler call misses the authority ceiling on this hop.
                const transport = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async params =>
                    handler(params.request, { signal: lifetime.signal, callerAuthority: params.authorityCeiling ?? 'present_user' }));
                try {
                    const sourceCustody = fixture.registry.readPluginSourceCustody?.('com.acme.machine-source');
                    if (!sourceCustody) throw new Error('Missing admitted source custody');
                    const relay = (reviewed: boolean) => invokeAccountMachineSourceAction({
                        credentials: { token: accountToken, encryption: null }, serverUrl: 'http://account-caller.test',
                        machineId: 'reading-machine', callerManifest: manifest,
                        callerSourceCustody: clientActionBinding.sourceCustody,
                        source: { manifest: normalizePluginManifestV2(createPluginManifestV2Fixture({ id: 'com.acme.machine-source' })),
                            occurrenceId: targetOccurrence, sourceCustody },
                        request: { action: { pluginId: 'com.acme.machine-source', localId: 'write' }, input: {},
                            surface: 'plugin', originSurface: 'ui', presentUserIntent: 'confirmed',
                            ...(reviewed ? { approvalContext: { hostReviewedChild: createHostReviewedChildPortV1({
                                actionId: 'action.invoke', reviewAdmitted: true, context: {},
                                input: { action: { pluginId: 'com.acme.machine-source', localId: 'write' }, input: {} },
                            }) } } : {}),
                            caller: { kind: 'plugin', pluginId, contribution: { id: contributionLocalId,
                                qualifiedId: `${pluginId}/${contributionLocalId}` }, occurrenceId: clientActionBinding.occurrenceId,
                                sourceCustody: clientActionBinding.sourceCustody, originSurface: 'ui' }, signal: lifetime.signal },
                    });
                    expect(await relay(false)).toMatchObject({ status: 'failed', code: 'plugin_action_current_intent_unavailable',
                        actionHandlerInvocation: 'notStarted' });
                    const relayed = await relay(true);
                    expect(relayed, JSON.stringify(relayed)).toMatchObject({ status: 'executed', value: { writes: 1 } });
                } finally { transport.mockRestore(); }
                expect(await run(clientActionBinding, { uncertain: true }, 'write', 'confirmed'))
                    .toMatchObject({ ok: false, code: 'plugin_action_outcome_unknown' });
                expect(await run()).toMatchObject({ ok: true, result: { writes: 2 } });
                return;
            }
            if (executionSurface === 'cli') {
                const pending = run(clientActionBinding, {}, 'write');
                try {
                    // The publication boundary exposes the old hang without a timer:
                    // nobody can decide an approval whose id never reaches this caller.
                    expect(await Promise.race([pending, publication.promise]))
                        .toMatchObject({ ok: false, code: 'plugin_action_current_intent_unavailable' });
                } finally { lifetime.abort(); await pending; }
                expect(approvalRows.size).toBe(0);
                expect(await handler({ machineId: 'reading-machine', qualifiedActionId: 'com.acme.machine-source/read',
                    expectedContributorOccurrenceId: targetOccurrence, executionSurface,
                    invocation: { kind: 'clientPluginAction', clientActionBinding }, input: {} }))
                    .toMatchObject({ ok: true, result: { writes: 0 } });
                return;
            }
        } finally { vi.unstubAllEnvs(); resetActiveAccountSettingsSnapshotForTests(); restore(); await app.close(); await fixture.dispose(); }
    });
    it('admits an ordinary installed external detail contributor through the same RPC and rejects retired custody', async () => {
        const targetId = 'acme.detail-host';
        const contributorId = 'acme.detail-source';
        const protocol = { id: 'detail', version: 1 } as const;
        const target = definePlugin({
            id: targetId, version: '1.0.0', displayName: 'External detail host',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            hostAccess: { required: [], optional: [] },
            contributionPoints: { details: defineContributionProtocol({
                ...protocol,
                operations: {},
                surfaces: { detail: { required: true, presentation: 'content',
                    inputSchema: defineProtocolObject({}, { policy: 'closed' }) } },
            }).point() },
        });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [{ manifest: target.manifest, files: {} }, {
                manifest: createPluginManifestV2Fixture({ id: contributorId, contributes: {
                    actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'],
                        placementBindings: [], dangerLevel: 'safe', execution: { target: 'daemon' },
                        inputSchema: { type: 'object', additionalProperties: false },
                        resultSchema: { type: 'object', additionalProperties: true } }],
                    ui: { renderers: [{ id: 'detail', kind: 'declarative', root: { kind: 'text', text: 'Detail' } }] },
                    composerRegions: [{ id: 'composer-detail', placement: 'beforeComposer', renderer: { renderer: 'detail' } }],
                    composerAttachments: [{ id: 'headless-attachment', title: 'Reference', icon: 'file', cardinality: 'many', valueSchema: { type: 'object' } }],
                    targetedPluginContributions: [{ id: 'source', target: { pluginId: targetId, pointId: 'details' },
                        protocol, operations: {}, surfaces: { detail: { renderer: 'detail' } } }],
                } }),
                files: { 'daemon.mjs': "export function activate(api) { api.actions.register('read', (_input, context) => context.caller); }" },
            }],
            runtimeOptions: { resolveCurrentMachineId: () => 'external-machine' },
        });
        const stages = vi.spyOn(logger, 'debugLocalFile').mockImplementation(() => {});
        const requestId = '70cc64d3-0386-4914-b7d8-713b7879e99f';
        try {
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => fixture.registry, resolveInstalledPackages: async () => [],
                resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_external-home', machineId: 'external-machine' }),
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
            if (!handler) throw new Error('Expected contributed Action RPC');
            const occurrenceId = fixture.registry.readPluginOccurrenceId?.(contributorId);
            const sourceCustody = fixture.registry.readPluginSourceCustody?.(contributorId);
            const materializationRef = fixture.registry.resolveCurrentPluginMaterializationRef?.(contributorId);
            if (!occurrenceId || !sourceCustody || !materializationRef) throw new Error('Expected installed external source');
            expect(sourceCustody.kind).toBe('managed');
            const mountedBinding = { pluginId: contributorId, contributionLocalId: 'source', occurrenceId, sourceCustody, materializationRef };
            const run = async (contributionLocalId = 'source') => DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(await handler({
                machineId: 'external-machine', qualifiedActionId: `${contributorId}/read`, expectedContributorOccurrenceId: occurrenceId,
                input: {}, executionSurface: 'ui', invocation: { kind: 'mountedPluginSurface', mountedBinding: { ...mountedBinding, contributionLocalId } },
            }, { signal: new AbortController().signal, transportRequestId: `rpc_${requestId}` }));
            for (const contributionLocalId of ['source', 'composer-detail']) {
                expect(await run(contributionLocalId)).toEqual({ ok: true, result: {
                    kind: 'plugin', pluginId: contributorId, contribution: { id: contributionLocalId, qualifiedId: `${contributorId}/${contributionLocalId}` },
                    occurrenceId, sourceCustody, materialization: materializationRef,
                    executionOrigin: { serverIdentityId: 'srv_external-home', materializationRef }, originSurface: 'ui',
                } });
            }
            const recorded = stages.mock.calls.filter(([message]) => message === '[external-action-stage]');
            for (const stage of ['contributed.runtime_lease', 'contributed.mounted_caller', 'contributed.mounted_origin',
                'contributed.execute', 'contributed.target_invoke']) {
                expect(recorded).toEqual(expect.arrayContaining(['begin', 'end'].map(edge => [
                    '[external-action-stage]', expect.objectContaining({ actionId: 'action.invoke', rootRequestId: requestId,
                        stage: `${stage}.${edge}` }),
                ])));
            }
            expect(await run('headless-attachment')).toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            fixture.registry.fencePluginConsumers?.([contributorId]);
            expect(await run()).toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
        } finally { stages.mockRestore(); await fixture.dispose(); }
    });

    it('dispatches admitted client, voice, settings, Composer and targeted detail callers, refusing a daemon contribution masquerading as a client mount and retired custody', async () => {
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [{
                manifest: createPluginManifestV2Fixture({ id: 'acme.probe', contributes: {
                    actions: [{ id: 'probe', title: 'Read admitted caller', scopes: ['global'],
                        surfaces: ['ui', 'plugin'], placementBindings: [], dangerLevel: 'safe',
                        inputSchema: { type: 'object', additionalProperties: false },
                        resultSchema: { type: 'object', additionalProperties: true },
                        execution: { target: 'daemon' } },
                    { id: 'client-select', title: 'Select', scopes: ['global'], surfaces: ['ui'],
                        placementBindings: [], dangerLevel: 'safe', execution: { target: 'client',
                            client: { artifactId: 'select-ui', exportName: 'activate' }, platforms: ['web'] } }],
                } }),
                files: { 'daemon.mjs': "export function activate(api) { api.actions.register('probe', (_input, context) => context.caller); }" },
            }],
            runtimeOptions: { pluginIds: ['acme.probe', 'happier.channels', 'happier.voice.openai', 'happier.triage', 'happier.scm.forge.github'],
                resolveCurrentMachineId: () => 'machine-1' },
        });
        try {
            const handlers = new Map<string, RpcHandler>();
            const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
            registerDaemonContributionRegistryProjectionHandler(registrar, {
                resolveRuntimeRegistry: async () => fixture.registry,
                resolveInstalledPackages: async () => [],
                resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_home-1', machineId: 'machine-1' }),
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
            if (!handler) throw new Error('Expected contributed Action RPC');
            const binding = (pluginId: string, contributionLocalId: string) => {
                const occurrenceId = fixture.registry.readPluginOccurrenceId?.(pluginId);
                const sourceCustody = fixture.registry.readPluginSourceCustody?.(pluginId);
                const materializationRef = fixture.registry.resolveCurrentPluginMaterializationRef?.(pluginId);
                if (!occurrenceId || !sourceCustody || !materializationRef) throw new Error('Expected admitted mount');
                return { pluginId, contributionLocalId, occurrenceId, sourceCustody, materializationRef };
            };
            const voice = fixture.registry.contributes.voiceProviders?.find((entry) => entry.pluginId === 'happier.voice.openai');
            const settings = fixture.registry.contributes.uiSettingsPagesV2?.find((entry) => entry.pluginId === 'happier.channels');
            const composer = fixture.registry.contributes.composerAttachments?.find((entry) => entry.pluginId === 'happier.triage');
            if (!voice || !settings || !composer) throw new Error('Expected real admitted Voice, settings-page and Composer declarations');
            const client = binding('acme.probe', 'client-select');
            const targeted = fixture.registry.contributes.targetedPluginContributions?.find((entry) => (
                entry.pluginId === 'happier.scm.forge.github' && entry.identity.localId === 'github-forge'
            ));
            if (!targeted) throw new Error('Expected real GitHub source declaration');
            const admitted = fixture.registry.contributes.readAdmittedTargetedContributions?.({
                targetPluginId: targeted.definition.target.pluginId,
                pointId: targeted.definition.target.pointId,
                protocol: targeted.definition.protocol,
            });
            expect(admitted?.contributions.some(entry => entry.contributor.pluginId === targeted.pluginId
                && entry.contributor.contributionId === targeted.identity.localId
                && entry.surfaces.length > 0)).toBe(true);
            const invocations: DaemonPluginMountedInvocationV1[] = [
                { kind: 'clientPluginAction', clientActionBinding: client },
                { kind: 'mountedPluginSurface', mountedBinding: binding(voice.pluginId!, voice.identity.localId) },
                { kind: 'mountedPluginSurface', mountedBinding: binding(settings.pluginId!, settings.identity.localId) },
                { kind: 'mountedPluginSurface', mountedBinding: binding(targeted.pluginId!, targeted.identity.localId) },
                { kind: 'mountedPluginSurface', mountedBinding: binding(composer.pluginId!, composer.identity.localId) },
            ];
            const run = async (invocation: DaemonPluginMountedInvocationV1) => DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(await handler({
                machineId: 'machine-1', expectedContributorOccurrenceId: client.occurrenceId,
                qualifiedActionId: 'acme.probe/probe', input: {}, executionSurface: 'ui', invocation,
            }));
            for (const invocation of invocations) {
                const mounted = invocation.kind === 'clientPluginAction' ? invocation.clientActionBinding : invocation.mountedBinding;
                expect(await run(invocation)).toEqual({ ok: true, result: {
                    kind: 'plugin', pluginId: mounted.pluginId,
                    contribution: { id: mounted.contributionLocalId, qualifiedId: `${mounted.pluginId}/${mounted.contributionLocalId}` },
                    occurrenceId: mounted.occurrenceId, sourceCustody: mounted.sourceCustody,
                    materialization: mounted.materializationRef,
                    executionOrigin: { serverIdentityId: 'srv_home-1', materializationRef: mounted.materializationRef }, originSurface: 'ui',
                } });
            }
            expect(await run({ kind: 'clientPluginAction', clientActionBinding: { ...client, contributionLocalId: 'probe' } }))
                .toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            const detail = binding(targeted.pluginId!, targeted.identity.localId);
            expect(await run({ kind: 'mountedPluginSurface', mountedBinding: { ...detail, contributionLocalId: 'not-a-surface' } }))
                .toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            expect(await run({ kind: 'mountedPluginSurface', mountedBinding: { ...detail, occurrenceId: 'github-retired' } }))
                .toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            expect(await run({ kind: 'mountedPluginSurface', mountedBinding: { ...detail,
                sourceCustody: { kind: 'development', registeredRootId: '/retired-github-source' },
            } })).toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            const headless = fixture.registry.contributes.targetedPluginContributions?.find((entry) => (
                entry.pluginId === targeted.pluginId && entry.definition.target.pluginId === 'happier.channels'
            ));
            if (!headless) throw new Error('Expected real headless GitHub conversation contribution');
            const headlessSnapshot = fixture.registry.contributes.readAdmittedTargetedContributions?.({
                targetPluginId: headless.definition.target.pluginId,
                pointId: headless.definition.target.pointId,
                protocol: headless.definition.protocol,
            });
            expect(headlessSnapshot?.contributions.find(entry => (
                entry.contributor.pluginId === headless.pluginId
                && entry.contributor.contributionId === headless.identity.localId
            ))?.surfaces).toEqual([]);
            expect(await run({ kind: 'mountedPluginSurface', mountedBinding: binding(headless.pluginId!, headless.identity.localId) }))
                .toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            expect(await run({ kind: 'clientPluginAction', clientActionBinding: { ...client,
                materializationRef: { ...client.materializationRef, materializationId: 'retired-materialization' },
            } })).toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            fixture.registry.fencePluginConsumers?.(['happier.channels']);
            expect(await run(invocations[2]!)).toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
        } finally {
            await fixture.dispose();
        }
    });
});
