import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConnectedServiceBindingsV2IngressSchema, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveConnectedServiceAuthForSpawn } from './resolveConnectedServiceAuthForSpawn';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from './requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { createBuiltInQualifiedNativeRefreshHarness } from './refresh/ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit';

afterEach(() => vi.unstubAllGlobals());

it.each(['profile', 'group'] as const)('materializes native-import Codex credentials for a %s selection without relabeling the account', async selection => {
    const h = await createBuiltInQualifiedNativeRefreshHarness({ controller: pluginReloadController, groupBinding: selection === 'group' });
    let materialized: Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>> = null;
    try {
        // Seed the same qualified native-import record at the HTTP/storage boundary;
        // selection, preflight, purpose admission, plugin and file writes stay real.
        await h.mutateCredential({ token: h.credentials.token, mutation: {
            ref: h.account, authenticationModeId: 'native-import', expectedCredentialRevision: h.firstRevision,
            expectedConfigurationRevision: null, metadata: (await h.readCredential()).metadata,
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                payload: { v: 1, values: { accessToken: 'imported-access', refreshToken: 'private-refresh',
                    idToken: 'imported-id', providerAccountId: 'imported-provider-account',
                    expiresAtMs: String(Date.now() + 3_600_000) } }, randomBytes: length => new Uint8Array(length) }),
        } });
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Fresh imported credentials must not call the provider'); }));
        const bindings = ConnectedServiceBindingsV2IngressSchema.parse({ v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': selection === 'group'
                ? { source: 'connected', selection: 'group', groupId: 'pool' }
                : { source: 'connected', selection: 'profile', profileId: 'work' },
        } });
        materialized = await resolveConnectedServiceAuthForSpawn({ agentId: 'codex', materializationKey: 'imported-spawn',
            connectedServicesBindingsRaw: bindings, credentials: h.credentials, api: h.api,
            baseDir: join(h.happyHomeDir, 'materialized'), activeServerDir: join(h.happyHomeDir, 'active'),
            qualifiedConnectedAccountApi: h.qualifiedApi, credentialRefreshService: h.coordinator,
            resolveQualifiedPurposeBindingSnapshot: current => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                agentId: 'codex', bindings: current, contributions: h.registry.contributes,
            }),
            activateQualifiedPurposeBindings: snapshot => h.purposeRuntime.activatePurposeBindings({
                subject: { kind: 'operation', operationId: 'imported-spawn', consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    isCurrent: () => h.controller.isRuntimeRegistryCurrent(h.registry) },
                purposes: snapshot.purposes, bindings: snapshot.bindings,
            }), nowMs: () => h.now, processEnv: {},
        });
        const nativeHome = materialized?.env.CODEX_HOME;
        expect(nativeHome).toBeTruthy();
        if (!nativeHome) throw new Error('Imported native home unavailable');
        expect(JSON.parse(await readFile(join(nativeHome, 'auth.json'), 'utf8'))).toMatchObject({
            tokens: { access_token: 'imported-access', id_token: 'imported-id', account_id: 'imported-provider-account', refresh_token: '' },
        });
        // The native auth bridge also consumes this projection. A fresh import
        // must be usable there without rotating the shared refresh-token family.
        expect(await h.coordinator.refreshOpenAiCodexChatGptTokensForBridge({
            refreshAttemptId: 'imported-spawn', selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
            expectedCredentialRevision: h.secondRevision, chatgptPlanType: null, forceRefresh: false,
        })).toMatchObject({ accessToken: 'imported-access', chatgptAccountId: 'imported-provider-account', credentialRevision: h.secondRevision });
        expect(h.acquireRefreshLease).not.toHaveBeenCalled();
        expect(await h.readCredential()).toMatchObject({ authenticationModeId: 'native-import', credentialRevision: h.secondRevision });
        expect(h.mutateCredential).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
    } finally {
        await materialized?.materializationPurposeLease?.dispose();
        await materialized?.cleanupOnExit?.();
        await h.dispose();
    }
});
