import { expect, it, vi } from 'vitest';
import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { configuration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDeploymentSourceMaterializationPort } from '@/deployments/targets/ownServer/exactCommitRelease';
import { createScmBackendRegistry } from '@/scm/registry';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { createNativeComposeLifecycle, readNativeComposeLogsForHost } from './nativeComposeLifecycle';

it('does not prescribe redeploy while original masking waits for generation proof', async () => {
    const lease = createProviderRedactionLease({ values: [] });
    try {
        await expect(readNativeComposeLogsForHost({ containerIds: ['a'.repeat(64)], environment: true,
            redactionLease: lease, redactionComplete: false,
            async run() { throw new Error('Incomplete proof must refuse before log I/O'); },
        }, { kind: 'read', maxBytes: 8192 })).rejects.toMatchObject({
            code: 'secret_redaction_unavailable', details: undefined,
        });
    } finally { lease.close(); }
});

it('returns the redeploy cause through logs.read for a restored observer without original masking custody', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-log-redaction-cause-'));
    const previous = { happyHomeDir: configuration.happyHomeDir, settingsFile: configuration.settingsFile,
        activeServerId: configuration.activeServerId, serversDir: configuration.serversDir };
    Object.assign(configuration, { happyHomeDir: home, settingsFile: join(home, 'settings.json'), serversDir: join(home, 'servers') });
    const target = { serverId: 'srv_log_redaction', machineId: 'machine' };
    let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    let handle: Readonly<{ dispose(): Promise<void> }> | undefined;
    let nativeLogReads = 0;
    try {
        const profile = await addServerProfile({ name: 'log-redaction', serverUrl: 'https://log-redaction.invalid',
            webappUrl: 'https://log-redaction.invalid' });
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId: target.serverId, canonicalServerUrl: profile.serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        configuration.activeServerId = profile.id;
        fixture = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
            runtimeOptions: { pluginIds: [] } });
        const document = JSON.stringify({ services: { web: { image: 'example/web:1' } } });
        const release = await createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
            return { environmentId: 'production', environmentInstanceId: 'production-machine', deploymentId: 'deploy-a',
                machineId: target.machineId, installationId: 'installation', deploymentRoot: join(home, 'deployments'),
                artifactDirectory: join(home, 'artifacts'), definition: { kind: 'stored' as const, contentRevision: 1,
                    document, composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
                    profiles: [], services: ['web'] }, async assertCurrent() {} };
        } }).materialize({ environmentId: 'production', deploymentId: 'deploy-a' });
        await release.commit();
        const id = 'a'.repeat(64);
        // Docker and Home HTTP are the substituted system boundaries. Selection,
        // supervision, redaction and Action dispatch use their real owners.
        const native = createNativeComposeLifecycle({ args: ['compose', '--project-name', 'restored'], engineId: 'restored-engine',
            environment: { composeService: 'web', containerIds: [id] }, io: {
            async events() { return { async dispose() {} }; }, async run(request) {
                if (request.args.includes('logs')) { nativeLogReads++; throw new Error('Unmasked log read'); }
                if (request.args.includes('info')) return { exitCode: 0, stdout: JSON.stringify({ ID: 'restored-engine' }) };
                return { exitCode: 0, stdout: request.args.includes('ps') ? id
                    : JSON.stringify([{ Id: id, State: { Status: 'running' }, Config: { Labels: {
                        'com.docker.compose.project': 'restored', 'com.docker.compose.service': 'web',
                    } } }]) };
            } } });
        // Restart recovery restores the Docker tuple, not the original secret lease.
        native.bindLaunch({ command: '/docker', args: ['compose', '--project-name', 'restored'], cwd: home, env: {}, release() {} });
        handle = await fixture.registry.projectManagedServices.superviseProject({ kind: 'environment', ...target,
            environmentId: release.environmentId, environmentInstanceId: release.environmentInstanceId,
            deploymentId: release.deploymentId, release, composeService: 'web', serviceId: 'production-machine/web',
            specIdentity: 'deploy-a', isCurrent: () => true, releaseObservation: async () => {}, nativeEffects: { keys: [] },
            processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: native.lifecycle } },
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            expect(new URL(request.url!).pathname).toBe('/v1/deployments/environments/access');
            return { status: 200, data: { ok: true, items: [{ environmentId: 'production', read: true, deploy: false }] } };
        });
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const executor = createCliActionExecutor({ token, credentials: { token, encryption: null }, mode: 'plain', ctx: null,
            sessionId: 'cli-global', serverId: target.serverId, serverHttpBaseUrl: profile.serverUrl,
            machineActionDirectTargetTransport: { machineId: target.machineId,
                async invoke() { throw new Error('Local logs must not re-enter Machine RPC'); } },
        });
        const result = await executor.execute('machines.services.logs.read', { ...target, serviceId: 'production-machine/web' },
            { surface: 'mcp', authority: 'account_automation' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'secret_redaction_unavailable',
            details: { reason: 'secret_redaction_redeploy_required', remedy: 'redeploy_environment', retryable: false },
            failureCause: { phase: 'service.logs.redaction', errorClass: 'Error',
                errorCode: 'secret_redaction_redeploy_required', httpStatus: null },
        });
        expect(nativeLogReads).toBe(0);
    } finally {
        try { await handle?.dispose(); }
        finally {
            await fixture?.dispose();
            vi.restoreAllMocks();
            Object.assign(configuration, previous);
            await rm(home, { recursive: true, force: true });
        }
    }
});
