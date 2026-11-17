import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { DEPLOYED_TELEMETRY_PORT_ENV } from '@/deployments/telemetry/collectorHost';
import { createNativeComposeLifecycle } from './nativeComposeLifecycle';

async function renderApp(definition: Record<string, unknown>) {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-app-enrollment-'));
    const model = { services: { collector: definition }, volumes: { home: { name: 'collector-home' } } };
    const source = { environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'deploy',
        machineId: 'machine', installationId: 'installation', rootPath: root, manifestFingerprint: 'manifest',
        async assertCurrent() {}, async commit() {}, async abort() {} };
    const exec = createStablePluginExecService({ signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        resolveExecutable: async () => ({ command: '/docker' }), resolvePath: async () => root,
        systemTools: { async resolve(request) { return { grantId: 'docker-fixture', toolId: request.toolId,
            displayName: 'Docker fixture', source: 'system', executablePath: '/docker',
            launch: { kind: 'binary', executablePath: '/docker' } }; } } });
    const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'runtime',
        signal: new AbortController().signal, isCurrent: () => true,
        async prepare() { return { env: {}, secretValues: [], refs: [], async recheck() {}, dispose() {} }; } });
    const project = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source,
        files: ['compose.yaml'], services: ['collector'], images: [], async settleNative() {},
        // Docker process output is the system boundary; rendering and launch admission remain real.
        io: { async resolveTool() { return { executablePath: '/docker', version: 'fixture' }; }, async run(request) {
            if (request.args.includes('version')) return { exitCode: 0, stdout: request.args.includes('compose') ? '2.39.4' : 'linux/amd64' };
            if (request.args.includes('info')) return { exitCode: 0, stdout: JSON.stringify({ ID: 'collector-engine' }) };
            if (request.args.includes('config')) return { exitCode: 0, stdout: JSON.stringify(model) };
            throw new Error('Unexpected native effect');
        } } });
    try {
        await writeFile(join(root, 'compose.yaml'), JSON.stringify(model));
        return await project.render();
    } finally { await project.dispose(); await rm(root, { recursive: true, force: true }); }
}

const collector = () => ({ image: 'happierdev/dev-box:preview', environment: {
    [DEPLOYED_TELEMETRY_PORT_ENV]: '4318', HOME: '/home/happier', HAPPIER_HOME_DIR: '/home/happier/.happier',
    HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable', HAPPIER_RELEASE_RING: 'stable',
}, volumes: [{ type: 'volume', source: 'home', target: '/home/happier' }] });

describe('native Compose App enrollment declaration', () => {
    it('projects the collector enrollment coordinates from resolved native config', async () => {
        expect(await renderApp(collector())).toMatchObject({ appEnrollments: [{ serviceName: 'collector', port: 4318,
            homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier', releaseChannel: 'stable' }] });
    });

    it('leaves ordinary services without enrollment metadata', async () => {
        expect(await renderApp({ image: 'ordinary:latest' })).not.toHaveProperty('appEnrollments');
    });

    it('refuses a collector without the declared authentication directory needed by enrollment', async () => {
        await expect(renderApp({ ...collector(), environment: { [DEPLOYED_TELEMETRY_PORT_ENV]: '4318', HOME: '/home/happier' } }))
            .rejects.toMatchObject({ code: 'native_failed',
            details: { reason: 'native_compose_app_enrollment_invalid' } });
    });
});
