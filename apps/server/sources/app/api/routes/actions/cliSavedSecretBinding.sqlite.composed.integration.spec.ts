import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCliJson } from '../../../../../../../packages/tests/src/testkit/uiE2e/cliJson';
import { afterEach, expect, it, vi } from 'vitest';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentSocketHome } from '@/testkit/deploymentSocketHome.testkit.mjs';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { withConfiguredDaemonTestHome } from '../../../../../../cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createDaemonDeploymentActionDeps } from '../../../../../../cli/src/deployments/createDaemonDeploymentActionDeps';
import { createS0DeploymentDaemonIngress, readS0ControllerCredentials } from '../../../../../../cli/src/deployments/deploymentDaemonIngress.testkit';
import { createCliActionExecutorFromCredentials } from '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { adoptServerProfileHomeConnectionDescriptor } from '../../../../../../cli/src/server/serverProfiles';
import { configuration } from '../../../../../../cli/src/configuration';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { createFilesystemEffectAdmission } from '../../../../../../cli/src/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { resetInMemoryAccountSettingsContextForTests } from '../../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { createDaemonControlApp } from '../../../../../../cli/src/daemon/controlServer';
import { updateSettings, writeDaemonState, writeStoredCredentialsForServerId } from '../../../../../../cli/src/persistence';

afterEach(() => { vi.restoreAllMocks(); resetInMemoryAccountSettingsContextForTests(); });

it('materializes a CLI Saved Secret binding through its own Account approval without daemon custody', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'cli-saved-secret-binding-', env: {
        HAPPIER_FEATURE_DEPLOYMENTS__ENABLED: '1', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
    } }, async ({ homeDir }) => {
        const refusals: Array<Record<string, unknown>> = [];
        const home = await createDeploymentSocketHome({ configureApp: app => {
            app.addHook('onSend', async (request, reply, payload) => {
                if (reply.statusCode < 400 || typeof payload !== 'string') return payload;
                const body: unknown = JSON.parse(payload);
                if (body && typeof body === 'object') refusals.push({ path: request.url,
                    ...Object.fromEntries(Object.entries(body).filter(([key]) =>
                        ['error', 'authorizationRefusal', 'phase', 'requiredFact', 'remedy'].includes(key))) });
                return payload;
            });
        } });
        let ingress: Awaited<ReturnType<typeof createS0DeploymentDaemonIngress>> | undefined;
        try {
            await adoptServerProfileHomeConnectionDescriptor({ descriptor: { v: 1, homeServerIdentityId: home.serverId,
                canonicalServerUrl: home.baseUrl, revision: 1, endpoints: [{ kind: 'https', url: home.baseUrl }] },
                expectedProfileId: configuration.activeServerId, createIfMissing: true, observation: 'exact' });
            const credentials = readS0ControllerCredentials(home);
            await mkdir(dirname(configuration.installationIdentityFile), { recursive: true });
            await writeFile(configuration.installationIdentityFile, JSON.stringify({ version: 1, createdAt: 1,
                installationId: home.installationId, publicKey: Buffer.from(home.keys.publicKey).toString('base64url'),
                privateKey: Buffer.from(home.keys.secretKey).toString('base64url') }), { mode: 0o600 });
            const identity = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => home.serverId,
                resolveHostIdentity: async () => ({ custodianAccountId: home.accountId, machineId: home.machineId,
                    installationId: home.installationId }) });
            const resolveRequesterIdentity: Parameters<typeof createDaemonDeploymentActionDeps>[0]['resolveRequesterIdentity'] = async context => {
                const requester = await identity.resolveActionRequester!(context);
                try { return requester.identity; } finally { await requester.dispose(); }
            };
            ingress = await createS0DeploymentDaemonIngress({ home, resolveDeploymentRequesterIdentity: resolveRequesterIdentity,
                createDeploymentActionDeps: requester => createDaemonDeploymentActionDeps({ credentials: requester?.credentials ?? credentials,
                    serverId: home.serverId, serverHttpBaseUrl: home.baseUrl, machineId: home.machineId, resolveRequesterIdentity,
                    ...(requester ? { savedSecretOperationContext: requester.savedSecretOperationContext } : {}),
                    runtime: { async acquire() { throw new Error('Binding does not deploy'); } } }),
            });
            // Database and stored-content producers establish the pre-existing
            // Environment; the binding's admission, review and execution stay real.
            const source = await inTx(tx => createProjectSourceInTx(tx, home.accountId, {
                serverId: home.serverId, requestKey: randomUUID(), name: 'CLI Secret binding fixture' }));
            if (!source.ok) throw new Error(source.error);
            const sample = createDeploymentEnvironmentDetailV1();
            const changed = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
                createdByAccountId: home.accountId, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: home.machineId, buildMachineId: home.machineId,
                ...await home.createContentArtifact({ body: JSON.stringify(sample.content) }, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1) } });
            const updateContext = { surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId,
                serverIdentityId: home.serverId, runtimeAccountId: home.accountId } satisfies ActionExecutorContext;
            await runWithServerHttpBaseUrl(home.baseUrl, async () => {
                const secretCaller = createCliActionExecutorFromCredentials({ credentials,
                    readCredentials: async () => credentials, machineId: home.machineId,
                    machineActionDirectTargetTransport: ingress!.machineActionDirectTargetTransport,
                    serverId: configuration.activeServerId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl,
                    onApprovalRequested: async (_artifactId, _signal, decide) => {
                        return await decide('approve');
                    } });
                const secret = await secretCaller.execute('secrets.create', {
                    name: 'CLI binding credential', value: 'private-cli-binding-value',
                }, { ...updateContext, actionRequestId: randomUUID() });
                expect(secret).toMatchObject({ ok: true, result: { secretRef: expect.any(String) } });
                if (!secret.ok || !secret.result || typeof secret.result !== 'object'
                    || !('secretRef' in secret.result) || typeof secret.result.secretRef !== 'string')
                    throw new Error('Expected a Saved Secret reference');
                // Raw `actions invoke` uses the private local control route on
                // an own Machine. Its host has no requester's Secret packet.
                const host = createCliActionExecutorFromCredentials({ credentials,
                    readCredentials: async () => credentials, machineId: home.machineId,
                    serverId: configuration.activeServerId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl,
                    machineActionDirectTargetTransport: ingress!.machineActionDirectTargetTransport,
                    runActionOperation: ingress!.actionOperations.runActionOperation,
                    ...createDaemonDeploymentActionDeps({ credentials, serverId: home.serverId,
                        serverHttpBaseUrl: home.baseUrl, machineId: home.machineId, resolveRequesterIdentity,
                        runtime: { async acquire() { throw new Error('Binding does not deploy'); } } }) });
                const control = createDaemonControlApp({ getChildren: () => [], machineId: home.machineId,
                    controlToken: 'private-binding-control', stopSession: async () => { throw new Error('No stop'); },
                    spawnSession: async () => { throw new Error('No spawn'); }, requestShutdown() {}, onHappySessionWebhook() {},
                    externalActionApi: { currentServerId: configuration.activeServerId, currentAccountId: home.accountId,
                        executor: host, resolveTarget: ingress!.externalActionIngressOwner.resolveTarget,
                        verifyPat: async () => { throw new Error('CLI uses Account credentials'); },
                        resolveInstallationId: () => home.installationId,
                        resolvePluginExecutionOriginContext: async () => ({ serverIdentityId: home.serverId, machineId: home.machineId }) } });
                await control.listen({ host: '127.0.0.1', port: 0 });
                const address = control.server.address();
                if (!address || typeof address === 'string') throw new Error('Expected private control listener');
                writeDaemonState({ pid: process.pid, httpPort: address.port, controlToken: 'private-binding-control',
                    startedAt: Date.now(), startedWithCliVersion: '0.0.0', machineId: home.machineId, accountId: home.accountId });
                const { resolveLiveDaemonControlTargetForServer } = await import('../../../../../../cli/src/daemon/multiDaemon');
                expect(await resolveLiveDaemonControlTargetForServer(configuration.activeServerId)).toMatchObject({
                    httpPort: address.port, machineId: home.machineId, accountId: home.accountId,
                });
                await updateSettings(settings => ({ ...settings,
                    machineIdByServerId: { ...settings.machineIdByServerId, [configuration.activeServerId]: home.machineId },
                    machineIdByServerIdByAccountId: { ...settings.machineIdByServerIdByAccountId,
                        [configuration.activeServerId]: { [home.accountId]: home.machineId } },
                    lastTokenSubByServerId: { ...settings.lastTokenSubByServerId, [configuration.activeServerId]: home.accountId },
                }));
                // A real separate CLI cannot inherit the daemon's warm in-memory
                // Account settings or its requester Saved Secret operation.
                await writeStoredCredentialsForServerId(configuration.activeServerId, credentials);
                const cliRoot = fileURLToPath(new URL('../../../../../../cli/', import.meta.url));
                try {
                    const input = {
                        serverId: home.serverId, environmentId: changed.id, expectedRevision: changed.revision,
                        set: [{ purpose: 'variable', phase: 'build', name: 'SECRET',
                            source: { kind: 'secret', ref: secret.result.secretRef, resourceRevision: 1 } }], remove: [],
                    };
                    const bound = await runCliJson({ testDir: homeDir, cliHomeDir: homeDir,
                        serverUrl: home.baseUrl, webappUrl: home.baseUrl, env: process.env, label: 'cold-bindings',
                        acceptedExitCodes: [0, 1],
                        cliLaunchSpec: { command: process.execPath,
                            args: ['--conditions=happier-source', ...('bun' in process.versions ? [] : ['--import', 'tsx']),
                                join(cliRoot, 'src/index.ts')], cwd: cliRoot,
                            env: { TSX_TSCONFIG_PATH: join(cliRoot, 'tsconfig.json') } },
                        args: ['actions', 'invoke', 'deployments.bindings.set', '--server-id', configuration.activeServerId,
                            '--machine-id', home.machineId, '--input-json', JSON.stringify(input), '--yes', '--json'],
                    });
                    const stderr = await readFile(join(homeDir, 'cli.cold-bindings.stderr.log'), 'utf8');
                    expect(bound, JSON.stringify({ bound, refusals, stderr })).toMatchObject({ ok: true,
                        kind: 'actions_invoke', data: { ok: true, environmentId: changed.id, revision: changed.revision + 1 } });
                    expect(stderr.match(/"kind":"approval_request_created"/g) ?? []).toHaveLength(1);
                    expect(JSON.stringify(bound)).not.toContain('private-cli-binding-value');
                    expect(await db.machineSecretGrant.count({ where: { environmentId: changed.id } })).toBeGreaterThan(0);
                } finally { await control.close(); }
            });
        } finally { await ingress?.close(); await home.close(); }
    });
}, 300_000);
