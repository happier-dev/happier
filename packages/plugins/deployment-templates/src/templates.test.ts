import { describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST } from './manifest.js';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DeploymentTemplateV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTemplates';
import { resolveRemoteInstalledFirstPartyBinaryPath } from '@happier-dev/cli-common/systemTasks/kinds/remoteFirstPartyPayloadInstaller';

describe('bundled data-service registry source', () => {
  it('offers a daemon collector with its whole persistent home and ordinary HTTP ingress', async () => {
    const catalog = JSON.parse(await readFile(new URL('../resources/registry/apps.json', import.meta.url), 'utf8')) as {
      apps: { itemId: string; app: unknown }[];
    };
    const selected = catalog.apps.find(entry => entry.itemId === 'telemetry-collector');
    expect(selected).toBeDefined();
    const app = DeploymentTemplateV1Schema.parse(selected?.app);
    const compose = JSON.parse(app.compose.document);
    expect(compose.services.collector).toMatchObject({ image: 'happierdev/dev-box:preview', environment: { HOME: '/home/happier',
        HAPPIER_HOME_DIR: '/home/happier/.happier', HAPPIER_DEPLOYED_TELEMETRY_PORT: '4318',
        HAPPIER_DAEMON_WAIT_FOR_AUTH: '1', HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
        HAPPIER_RELEASE_RING: 'stable' }, volumes: ['collector-home:/home/happier'] });
    expect(compose.services.collector.ports).toBeUndefined();
    expect(app.domains).toContainEqual(expect.objectContaining({ service: 'collector', containerPort: 4318, protocol: 'http' }));
    expect(app.volumes).toContainEqual(expect.objectContaining({ id: 'collector-home', service: 'collector',
      target: '/home/happier', persistent: true }));
    expect(app.variables).toContainEqual(expect.objectContaining({ key: 'HAPPIER_SERVER_URL', required: true,
      secret: false, sites: [{ service: 'collector', path: ['environment', 'HAPPIER_SERVER_URL'] }] }));
    expect(compose.services.collector.command.slice(-2)).toEqual(['daemon', 'start-sync']);
  });
  it.skipIf(process.platform === 'win32')('uses the paired Home binary after enrollment and the image binary before it', async () => {
    const catalog = JSON.parse(await readFile(new URL('../resources/registry/apps.json', import.meta.url), 'utf8')) as {
      apps: { itemId: string; app: unknown }[];
    };
    const selected = catalog.apps.find(entry => entry.itemId === 'telemetry-collector');
    expect(selected).toBeDefined();
    const app = DeploymentTemplateV1Schema.parse(selected?.app);
    const command: string[] = JSON.parse(app.compose.document).services.collector.command;
    const root = await mkdtemp(join(tmpdir(), 'happier-collector-template-'));
    const home = join(root, 'home');
    const installedBinary = resolveRemoteInstalledFirstPartyBinaryPath({ componentId: 'happier-cli', channel: 'stable', remoteHomeDir: home });
    try {
      await mkdir(dirname(installedBinary), { recursive: true });
      await writeFile(join(root, 'happier'), '#!/bin/sh\nprintf \'image:%s\\n\' "$*"\n', { mode: 0o755 });
      // Native Compose unescapes $$ before the container shell receives this argv.
      const run = () => execFileSync('/bin/sh', command.slice(1).map(argument => argument.replaceAll('$$', '$')), {
        env: { ...process.env, PATH: root, HAPPIER_HOME_DIR: home }, encoding: 'utf8',
      }).trim();
      expect(run()).toBe('image:daemon start-sync');
      await writeFile(installedBinary, '#!/bin/sh\nprintf \'paired:%s\\n\' "$*"\n', { mode: 0o755 });
      expect(run()).toBe('paired:daemon start-sync');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('declares the inert packaged data source through the shared registry', () => {
    expect(PLUGIN_MANIFEST.contributes).toMatchObject({ registrySources: [{
      id: 'data-services', format: 'happier-catalog', kinds: ['app'],
      packageContent: { path: 'resources/registry/apps.json' },
    }] });
  });
});
