import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { Disposable } from '@happier-dev/plugin-sdk';
import { readPluginActionReadObserver } from '@happier-dev/cli-common/plugins/registration/actionInputParser';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { PluginConnectedAccountAuthenticationV2Schema } from '@happier-dev/protocol';
import { createConnectedAccountPurposeBindingOwner, type ConnectedAccountPurposeBindingStore } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createTargetActionHostBindingResolver, createTargetActionHostPolicyResolver } from '../../hostAccess/resolve';
import { resolveManifestHostAccessRequests } from '../../hostAccess/manifestRequests';
import { createManagedPluginSourceCustody } from '../../lifecycle/contributions/runtimeIdentity.testkit';
import type { PluginRuntimeOccurrenceId } from '../../runtimeSlots';
import { buildTargetActionInvocationRegistry } from '../buildTargetActionRegistry';
import { buildPluginContributionRegistry } from '@/plugins/projection/registry/normalize/package';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createStablePluginHttpHost } from '../../fetch/service';
import { createPluginInvocationServiceBinding, createPluginInvocationServicesFactory } from './factory';

import { createStablePluginConnectedAccountsHost } from './connectedAccounts';
import type { ResolvedResourceContribution } from '@/plugins/projection/registry/types';
import { activate, PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/scm-github/src/index.js';
import { createStubGithubTransport } from '../../../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support.js';
import { GITHUB_CI_ACTION_IDS_V1 } from '../../../../../../../packages/plugins/scm-github/src/actions/actionIds.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_SERVICE } from '../../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts.js';
import { createDynamicResourceActionBinding } from './resourceActions';
import { createStablePluginResourcesOwner } from './resources';

const pluginId = PLUGIN_MANIFEST.id;
const resourceId = 'ci-branch-counts';
const repository = { kind: 'github', deployment: 'https://github.com', repository: 'octo-org/example-app' } as const;
const headOid = 'a'.repeat(40);
const initialRun = { id: 81, run_attempt: 1, run_number: 8, workflow_id: 12, head_sha: headOid, head_branch: 'topic',
    status: 'queued', conclusion: null, event: 'push', path: '.github/workflows/ci.yml',
    repository: { id: 4210, full_name: repository.repository }, head_repository: { id: 4210, full_name: repository.repository },
    actor: { login: 'octo' }, html_url: 'https://github.com/octo-org/example-app/actions/runs/81' };
afterEach(() => vi.useRealTimers());

describe('registered daemon GitHub count Resource', () => {
    // Real declaration → operation-purpose binding → native materialization,
    // followed by unopened chrome on the same admitted Session/Project purpose.
    it.each([{ order: 'read-first', session: true }, { order: 'watch-first', session: false }])(
        'shares native demand, polls after read settlement and parks terminal work: $order/session=$session', async ({ order, session }) => {
        const declaration = PLUGIN_MANIFEST.contributes.resources?.find(resource => resource.id === resourceId);
        expect(declaration).toMatchObject({ source: 'dynamic', scope: 'surface', kind: 'config', contentType: 'application/json' });
        const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
        try {
        const runtime = kit.registration('resources', resourceId);
        if (!runtime) throw new Error('Missing registered native count producer');
        let title = 'Initial';
        let terminal = false;
        let holdNative = false;
        let releaseNative: (() => void) | undefined;
        let latestReadSignal: AbortSignal | undefined;
        const nativeResponse = () => ({ status: 200, headers: { 'x-poll-interval': '3' }, body: { total_count: 1,
            workflow_runs: [{ ...initialRun, display_title: title, ...(terminal ? { status: 'completed', conclusion: 'failure' } : {}) }] } });
        const transport = createStubGithubTransport({ nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer synthetic' } },
            respond: request => !request.url.includes('/actions/runs') ? undefined
                : holdNative ? new Promise<ReturnType<typeof nativeResponse>>(resolve => { releaseNative = () => resolve(nativeResponse()); }) : nativeResponse() });
        const contribution: ResolvedResourceContribution = {
            provenance: 'external', source: { kind: 'archive' }, pluginId, pluginRootPath: '/tmp/github-count-fixture',
            manifestPath: '/tmp/github-count-fixture/.happier-plugin/plugin.json', daemonEntryPath: null,
            sourceSpec: { kind: 'archive', locator: 'github-count-fixture.tgz', trustPolicy: 'prompt', installPolicy: 'copy' },
            definition: { kindVersion: 1, id: resourceId, type: 'config', source: 'dynamic', scope: 'surface', contentType: 'application/json' },
        };
        const occurrenceId = 'github-count-occurrence';
        const nativeHandler = kit.registration('actions', GITHUB_CI_ACTION_IDS_V1.listRuns);
        if (typeof nativeHandler !== 'function') throw new Error('Missing native runs Action');
        expect(readPluginActionReadObserver(nativeHandler)).toBeTypeOf('function');
        const purpose = { consumer: { pluginId, localId: GITHUB_CI_ACTION_IDS_V1.listRuns }, purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE };
        const globalAccount = { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'global-credential' };
        const sessionAccount = { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'session-credential' };
        let stored: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [{ purpose, target: { kind: 'account', account: globalAccount } }] };
        // Persistence/catalog/materialization are the external boundaries. The
        // purpose-selection, revision classifier and capability host are real.
        const purposeListeners = new Set<() => void>();
        const store: ConnectedAccountPurposeBindingStore = {
            read: async () => stored,
            async update(mutate) { stored = mutate(stored); for (const listener of purposeListeners) listener(); return stored; },
            subscribe(listener) { purposeListeners.add(listener); return { dispose() { purposeListeners.delete(listener); } }; },
        };
        let displayName = 'Synthetic credential';
        let credentialRevision = 'csr_abcdefghijklmnopqrstuv';
        let configurationRevision = 'configuration-one';
        const materializedAccounts: string[] = [];
        const authentication = PluginConnectedAccountAuthenticationV2Schema.parse({ defaultModeId: 'token', modes: [{
            id: 'token', kind: 'manual', outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }],
        }] });
        const connectedOwner = createConnectedAccountPurposeBindingOwner({ store,
            selectTarget: async () => { throw new Error('Observation cannot prompt'); },
            resolveTarget: async target => {
                if (target.kind !== 'account') throw new Error('Only exact test accounts are configured');
                return { account: target.account, displayName, observation: { authentication, profiles: [{ ref: target.account,
                    revisionSemantics: 'revisioned', credentialRevision, configurationRevision,
                    authenticationModeId: 'token', configurationReady: true, status: 'connected', scopes: ['repo'], displayName }] } };
            },
            async materializeAccount(request) { materializedAccounts.push(request.account.accountId);
                return { kind: 'httpHeaders', headers: { Authorization: `Bearer synthetic-${request.account.accountId}` } }; },
            projectTargetAccounts: async () => { throw new Error('No inventory reads'); },
            assertTargetAccountMaterializable: async () => { throw new Error('No inventory materialization'); },
        });
        const sessionLease = connectedOwner.activatePurposeBindings({ subject: { kind: 'session', sessionId: 'session-a' },
            purposes: [purpose], bindings: [{ purpose, target: { kind: 'account', account: sessionAccount } }] });
        const connectedHost = createStablePluginConnectedAccountsHost(connectedOwner);
        const http = createStablePluginHttpHost({ adapter: {
            request: transport.context.services.http.request,
            async openWebSocket() { throw new Error('No WebSocket demand'); },
        } });
        const createNativeServices = createPluginInvocationServicesFactory({ loggerSink: { write() {} }, connectedAccounts: connectedHost, http });
        const manifest = normalizePluginManifestV2(PLUGIN_MANIFEST);
        const actionDeclaration = manifest.contributes.actions.find(action => action.id === GITHUB_CI_ACTION_IDS_V1.listRuns)!;
        const hostAccessRequests = resolveManifestHostAccessRequests({ manifest, pluginId,
            contribution: { family: 'actions', localId: actionDeclaration.id }, requestIds: actionDeclaration.hostAccess });
        const sourceSpec = { kind: 'path', locator: '/tmp/github-count-fixture', trustPolicy: 'local_trusted', installPolicy: 'link' } as const;
        const normalized = buildPluginContributionRegistry({ loadedPlugins: [{ pluginId, manifest,
            pluginRootPath: sourceSpec.locator, manifestPath: `${sourceSpec.locator}/plugin.json`, daemonEntryPath: null,
            devDaemonEntryPath: null, sourceSpec }] });
        const contributes = createResolvedContributionRegistry({
            actions: normalized.actions.map(action => ({ ...action, provenance: 'external' as const, source: { kind: 'path' as const } })),
            activationTargets: [{ pluginId, manifest, provenance: 'external', source: { kind: 'path' },
                manifestPath: `${sourceSpec.locator}/plugin.json`, daemonEntryPath: null, sourceSpec }],
        });
        const createServiceBinding = (occurrence: string, id: string) =>
            createPluginInvocationServiceBinding(occurrence, id);
        const actionRegistry = buildTargetActionInvocationRegistry({ contributes,
            targetRegistrations: [{ pluginId, occurrenceId,
                registration: { family: 'actions', localId: actionDeclaration.id, value: nativeHandler } }],
            targetActivationFacts: [{ pluginId, pluginVersion: PLUGIN_MANIFEST.version, source: 'localPath', occurrenceId,
                host: 'daemon', platform: 'linux', occurredAtMs: 1, status: 'active',
                required: [{ family: 'actions', localId: actionDeclaration.id }], bound: [{ family: 'actions', localId: actionDeclaration.id }], diagnostics: [] }],
            actionFormConnectedAccounts: connectedOwner,
            createServices(seed, binding) {
                if (!seed.retireReadObservation) latestReadSignal = seed.signal;
                return createNativeServices(seed, binding); },
            resolveHostBinding: createTargetActionHostBindingResolver({ createServiceBinding }),
            resolveHostPolicy: createTargetActionHostPolicyResolver({ createServiceBinding }),
            readCurrentPluginSourceCustody: () => createManagedPluginSourceCustody('github-count-fixture'),
            readCurrentPluginOccurrenceId: () => occurrenceId as PluginRuntimeOccurrenceId,
            resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId,
                desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
        });
        const explicitAccount = { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'configured-source-credential' };
        const explicit = await actionRegistry.invoke({ pluginId, localId: actionDeclaration.id, surface: 'cli',
            ...(session ? { sessionId: 'session-a' } : {}),
            input: { repository, credentialRef: explicitAccount, filters: { branch: 'topic', ...(session ? { headSha: headOid } : {}) } } });
        expect(explicit.status, JSON.stringify(explicit)).toBe('executed');
        expect(materializedAccounts.at(-1)).toBe(explicitAccount.accountId);
        const nullSelection = await actionRegistry.invoke({ pluginId, localId: actionDeclaration.id, surface: 'cli',
            ...(session ? { sessionId: 'session-a' } : {}),
            input: { repository, credentialRef: null, filters: { branch: 'topic', ...(session ? { headSha: headOid } : {}) } } });
        expect(nullSelection.status, JSON.stringify(nullSelection)).toBe('executed');
        expect(materializedAccounts.at(-1)).toBe(session ? sessionAccount.accountId : globalAccount.accountId);
        const foreground = await actionRegistry.invoke({ pluginId, localId: actionDeclaration.id, surface: 'cli',
            ...(session ? { sessionId: 'session-a' } : {}),
            input: { repository, filters: { branch: 'topic', ...(session ? { headSha: headOid } : {}) } } });
        expect(foreground.status, `Ordinary native Action: ${JSON.stringify(foreground)}`).toBe('executed');
        const foregroundCredential = materializedAccounts.at(-1);
        expect(foregroundCredential, `Ordinary native credential result: ${JSON.stringify(foreground)}`)
            .toBe(session ? sessionAccount.accountId : globalAccount.accountId);
        const first = new AbortController();
        const second = new AbortController();
        let aWatch: Disposable | undefined;
        let bWatch: Disposable | undefined;
        // The bridge's Action transport terminates at the real registered
        // GitHub handler; only HTTP/materialization are substituted beneath it.
        const owner = await createStablePluginResourcesOwner({ registry: { resources: [contribution] }, generations: new Map(),
            resolveSessionResourceAccess: async request => ({ accountId: request.accountId, throughCursor: 1, status: 'available' }),
            dynamicOccurrenceIdsByPluginId: new Map([[pluginId, occurrenceId]]),
            dynamicProducers: [{ pluginId, localId: resourceId, runtime }],
            bindDynamicResourceActions: binding => createDynamicResourceActionBinding({ binding,
                readCaller: () => ({ kind: 'plugin', pluginId, occurrenceId,
                    contribution: { id: resourceId, qualifiedId: `${pluginId}/${resourceId}` },
                    sourceCustody: { kind: 'development', registeredRootId: 'github-count-fixture' } }),
                invoke: async request => {
                    expect(request.requiredReadOnly).toBe(true);
                    const localId = typeof request.action === 'string' ? request.action : request.action.localId;
                    const result = await actionRegistry.invoke({ ...request, pluginId, localId });
                    if (result.status === 'deferred') throw new Error('Read-only GitHub Resource Actions must settle without deferred approval');
                    return result;
                },
            }),
        });
        owner.applySessionAccessWitness({ accountId: 'authenticated-home-account', witness: { v: 1, throughCursor: 1,
            entries: [{ sessionId: 'session-a', cursor: 1, status: 'available' }] } });
        const context = { kind: 'surface', mountInstanceKey: 'unopened-ci', launchInput: null,
            target: session ? { kind: 'session', sessionId: 'session-a', repository, branch: 'topic', headOid } as const
                : { kind: 'project', projectKey: 'project-a', repository, branch: 'topic' } as const } as const;
        const bind = (signal: AbortSignal) => owner.bindForResource({ pluginId, resourceId, signal, isOccurrenceCurrent: () => true, context });
        const a = await bind(first.signal);
        const b = await bind(second.signal);
        const wakesA = vi.fn();
        const wakesB = vi.fn();
        const nativeReads = () => transport.requests.filter(request => request.url.includes('/actions/runs')).length;
        vi.useFakeTimers();
        try {
            if (order === 'watch-first') aWatch = await a.watch(resourceId, wakesA);
            expect(JSON.parse(Buffer.from((await a.read(resourceId)).bytes).toString())).toEqual({ running: 1, failed: 0 });
            expect(materializedAccounts.at(-1)).toBe(foregroundCredential);
            if (!aWatch) aWatch = await a.watch(resourceId, wakesA);
            bWatch = await b.watch(resourceId, wakesB);
            await vi.advanceTimersByTimeAsync(0);
            const initialReads = nativeReads();
            expect(initialReads).toBeGreaterThan(0);
            for (const request of transport.requests) {
                const url = new URL(request.url);
                expect(url.searchParams.get('branch')).toBe('topic');
                expect(url.searchParams.get('head_sha')).toBe(session ? headOid : null);
            }
            wakesA.mockClear(); wakesB.mockClear();
            title = 'Metadata changed';
            await vi.advanceTimersByTimeAsync(3000);
            expect(nativeReads()).toBe(initialReads + 1);
            expect(wakesA).not.toHaveBeenCalled();
            expect(wakesB).not.toHaveBeenCalled();
            terminal = true;
            await vi.advanceTimersByTimeAsync(3000);
            expect(nativeReads()).toBe(initialReads + 2);
            expect(wakesA).toHaveBeenCalledTimes(1);
            expect(wakesB).toHaveBeenCalledTimes(1);
            expect(JSON.parse(Buffer.from((await b.read(resourceId)).bytes).toString())).toEqual({ running: 0, failed: 1 });
            const parked = nativeReads();
            await vi.advanceTimersByTimeAsync(9000);
            expect(nativeReads()).toBe(parked);
            expect(purposeListeners.size).toBe(1);
            displayName = 'Presentation changed';
            for (const listener of [...purposeListeners]) listener();
            await vi.advanceTimersByTimeAsync(0);
            expect(nativeReads()).toBe(parked + 1);
            credentialRevision = 'csr_zyxwvutsrqponmlkjihgfe';
            for (const listener of [...purposeListeners]) listener();
            await vi.advanceTimersByTimeAsync(0);
            expect(nativeReads()).toBe(parked + 2);
            expect(purposeListeners.size).toBe(1);
            configurationRevision = 'configuration-two';
            for (const listener of [...purposeListeners]) listener();
            await vi.advanceTimersByTimeAsync(0);
            expect(nativeReads()).toBe(parked + 3);
            expect(purposeListeners.size).toBe(1);
            terminal = false;
            displayName = 'Refresh active work';
            for (const listener of [...purposeListeners]) listener();
            await vi.advanceTimersByTimeAsync(0);
            expect(JSON.parse(Buffer.from((await b.read(resourceId)).bytes).toString())).toEqual({ running: 1, failed: 0 });
            const activeReads = nativeReads();
            await aWatch.dispose(); first.abort();
            await vi.advanceTimersByTimeAsync(3000);
            expect(nativeReads()).toBe(activeReads + 1);
            holdNative = true;
            await vi.advanceTimersByTimeAsync(3000);
            expect(nativeReads()).toBe(activeReads + 2);
            expect(latestReadSignal?.aborted).toBe(false);
            const finalReads = nativeReads();
            await bWatch.dispose(); second.abort();
            expect(latestReadSignal?.aborted).toBe(true);
            releaseNative?.();
            await vi.advanceTimersByTimeAsync(9000);
            expect(nativeReads()).toBe(finalReads);
            expect(purposeListeners.size).toBe(0);
            owner.retirePlugin(pluginId);
            await expect(b.read(resourceId)).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        } finally {
            releaseNative?.();
            first.abort(); second.abort();
            await aWatch?.dispose(); await bWatch?.dispose();
            owner.retirePlugin(pluginId); actionRegistry.dispose(); connectedHost.retire(); sessionLease.dispose();
        }
        } finally { await kit.dispose(); }
    });
});
