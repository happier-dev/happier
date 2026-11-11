import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { rawSession, metadata } from '@/agent/catalog/nativeInactiveSessionControlAdapters.testkit';
import { reloadConfiguration } from '@/configuration';
import { createCodexForegroundConnectedAccountFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.codexConnectedServices.testkit';
import { installForegroundAgentCliFixture } from '@/daemon/agentRuntime/foregroundAdmission.testkit';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { prepareDaemonConnectedServices } from './prepareDaemonConnectedServices';
import { prepareInactiveSessionControlLaunchScope } from './prepareInactiveSessionControlLaunchScope';

afterEach(() => vi.restoreAllMocks());

it('resumes a stopped Session while an inactive native control still owns its admitted Account scope', async () => {
    await withTempDir('happier-resume-operation-', async root => {
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'CODEX_HOME']);
        let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
        let restoreCli: (() => void) | undefined;
        let inactive: Awaited<ReturnType<typeof prepareInactiveSessionControlLaunchScope>> | undefined;
        let resume: Extract<Awaited<ReturnType<typeof prepareDaemonConnectedServices>>, { ok: true }> | undefined;
        try {
            env.patch({ HAPPIER_HOME_DIR: join(root, 'home'), CODEX_HOME: undefined });
            reloadConfiguration();
            // Canonical fixture substitutes only Home HTTP; codecs, catalog,
            // materialization, purpose admission and native-control custody stay real.
            const account = await createCodexForegroundConnectedAccountFixture();
            runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: account.runtimeOptions });
            await account.dependenciesFor(runtime.registry, root);
            restoreCli = await installForegroundAgentCliFixture(runtime.registry, root);
            const connectedServices = { v: 2 as const, bindingsByServiceId: {
                'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
            } };
            const materialization = { v: 1 as const, id: 'retained-session-home', createdAt: 1 };
            const snapshot = { source: 'network' as const, settings: accountSettingsParse({
                connectedServicesProviderStateSharingSettingsV1: { v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' },
                    byAgentId: {}, acknowledgedRisksByAgentId: {} },
            }), settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [] };
            const admission = { credentials: account.credentials, api: account.api, activeServerDir: join(root, 'server'),
                connectedServicesMaterializationBaseDir: join(root, 'materials'), connectedServiceRefreshCoordinator: null,
                connectedAccountsOwner: account.owner, activatePurposeBindings: account.owner.activatePurposeBindings,
                processEnv: process.env, readAccountSettingsSnapshot: () => snapshot, async assertCurrent() {},
            };
            inactive = await prepareInactiveSessionControlLaunchScope({ agentId: 'codex', runtimeRegistryLease: runtime.lease,
                adapterParams: { sessionId: 'stopped-session', rawSession: { ...rawSession('stopped-session'), path: root },
                    metadata: { ...metadata(), path: root, connectedServices, connectedServiceMaterializationIdentityV1: materialization },
                    cwd: root, credentials: account.credentials }, signal: new AbortController().signal,
            }, admission);
            const prepared = await prepareDaemonConnectedServices({ ...admission,
                accountSettingsSnapshot: snapshot, options: { directory: root, connectedServices, connectedServiceMaterializationIdentityV1: materialization },
                normalizedExistingSessionId: 'stopped-session', requestedSessionId: '', effectiveResume: '', catalogAgentId: 'codex',
                pluginRuntimeRegistry: runtime.registry,
            });
            expect(prepared, !prepared.ok ? JSON.stringify(prepared.result) : undefined).toMatchObject({ ok: true });
            if (!prepared.ok) throw new Error('Resume admission refused');
            resume = prepared;
            expect(resume.materializationKey).toBe(materialization.id);
            expect(resume.auth?.materializationPurposeLease?.isCurrent()).toBe(true);
            // A short native control cannot reserve the live Session's binding.
            const canonical = account.owner.activateSessionPurposeBindings({ sessionId: 'stopped-session',
                purposes: resume.qualifiedPurposeBindingSnapshot!.purposes, bindings: resume.qualifiedPurposeBindingSnapshot!.bindings });
            try {
                await inactive.dispose();
                expect(canonical.isCurrent()).toBe(true);
            } finally { canonical.dispose(); }
        } finally {
            await inactive?.dispose();
            await resume?.auth?.materializationPurposeLease?.dispose();
            await resume?.auth?.cleanupOnFailure?.();
            restoreCli?.();
            await runtime?.dispose();
            env.restore();
            reloadConfiguration();
        }
    });
});
