import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { buildPrivateServiceExportPatch, privateServiceExportAuthoring } from './privateServiceExport';

function privatePublicationDetail(): DeploymentEnvironmentReadDetailV1 {
  const base = createDeploymentEnvironmentDetailV1();
  return { ...base, content: { ...base.content,
    definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  postgres:\n    image: postgres:17\n', profiles: [], services: [] } },
    runtimeTargetLink: { ...base.targetLinks[0]!.targetLink,
      source: { kind: 'host', id: 'own-server' }, machines: ['machine-a'] },
    memberVersions: {}, secretRevisions: [] };
}

describe('private service export authoring availability', () => {
  it('keeps a native stored service editable before a private network is observed', () => {
    expect(privateServiceExportAuthoring(privatePublicationDetail(), true))
      .toEqual({ kind: 'ready', machineIds: ['machine-a'] });
  });

  it('consumes the existing edit decision and refuses repository-owned or non-private exports', () => {
    const detail = privatePublicationDetail();
    expect(privateServiceExportAuthoring(detail, false)).toEqual({ kind: 'unavailable', reason: 'readOnly' });
    expect(privateServiceExportAuthoring({ ...detail,
      content: { ...detail.content, definition: { kind: 'repository', ref: 'main' } } }, true))
      .toEqual({ kind: 'unavailable', reason: 'repository' });
    expect(privateServiceExportAuthoring({ ...detail, content: { ...detail.content,
      ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true, serviceExports: [{ key: 'postgres', service: 'postgres',
        containerPort: 5432, scheme: 'postgres', exposure: 'public' }] } } }, true))
      .toEqual({ kind: 'unavailable', reason: 'unsupported' });
  });

  it('requires native host Machines instead of offering platform publication authoring', () => {
    const detail = privatePublicationDetail();
    const runtime = detail.runtimeTargetLink!;
    expect(privateServiceExportAuthoring({ ...detail, runtimeTargetLink: { ...runtime,
      source: { kind: 'plugin', contribution: { pluginId: 'example.platform', localId: 'runtime' } }, machines: [] } }, true))
      .toEqual({ kind: 'unavailable', reason: 'machineMissing' });
    expect(privateServiceExportAuthoring({ ...detail, runtimeTargetLink: { ...runtime, machines: [] } }, true))
      .toEqual({ kind: 'unavailable', reason: 'machineMissing' });
  });

  it('keeps an Environment with Happier network exports editable', () => {
    const detail = privatePublicationDetail();
    expect(privateServiceExportAuthoring({ ...detail, content: { ...detail.content,
      ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true, serviceExports: [{ key: 'postgres', service: 'postgres',
        containerPort: 5432, scheme: 'postgres', exposure: 'loopback', transport: { kind: 'iroh' } }] } } }, true))
      .toEqual({ kind: 'ready', machineIds: ['machine-a'] });
  });

  it('refuses to bind one Machine address into Compose shared by several runtime Machines', () => {
    const detail = privatePublicationDetail();
    expect(privateServiceExportAuthoring({ ...detail, runtimeTargetLink: { ...detail.runtimeTargetLink!,
      machines: ['machine-a', 'machine-b'] } }, true))
      .toEqual({ kind: 'unavailable', reason: 'multipleMachines' });
  });
});

describe('private service export authoring', () => {
  it('saves the selected concrete publication and export together, preserving other ports and source inputs', () => {
    const base = createDeploymentEnvironmentDetailV1().content;
    const content = { ...base, definition: { kind: 'stored' as const, contentRevision: 4,
      composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  db:\n    image: postgres:17\n    ports:\n      - "5432:5432"\n      - "127.0.0.1:9100:9100"\n  app:\n    image: app:1\n',
      profiles: ['data'], services: ['db', 'app'], publicFiles: [{ path: 'settings.conf', content: 'retained' }] } };
    const patch = buildPrivateServiceExportPatch(content, { key: 'database', service: 'db', containerPort: 5432,
      scheme: 'postgres', hostPort: 15432, reach: { kind: 'privateNetwork', privateNetwork: 'shop-net', hostAddress: '100.81.1.12' } });
    expect(patch.ownServer.serviceExports).toEqual([{ key: 'database', service: 'db', containerPort: 5432,
      scheme: 'postgres', exposure: 'privateNetwork', privateNetwork: 'shop-net' }]);
    expect(patch.definition).toMatchObject({ from: 'compose', profiles: ['data'], services: ['db', 'app'],
      publicFiles: [{ path: 'settings.conf', content: 'retained' }] });
    expect(parse(patch.definition.document)).toEqual({ services: {
      db: { image: 'postgres:17', ports: ['127.0.0.1:9100:9100',
        { target: 5432, published: '15432', host_ip: '100.81.1.12', protocol: 'tcp' }] }, app: { image: 'app:1' },
    } });
  });

  it('replaces an IPv6 or long-form TCP publication but preserves UDP and unrelated exports', () => {
    const base = createDeploymentEnvironmentDetailV1().content;
    const content = { ...base, ownServer: { rollout: 'recreate' as const, autoRestorePreviousRelease: true,
      serviceExports: [{ key: 'other', service: 'app', containerPort: 8080, scheme: 'http',
        exposure: 'privateNetwork' as const, privateNetwork: 'shop-net' }] },
      definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
        document: 'services:\n  db:\n    image: postgres:17\n    ports:\n      - "[::]:5432:5432"\n      - { target: 5432, published: "5433", host_ip: "0.0.0.0" }\n      - "5432:5432/udp"\n',
        profiles: [], services: [] } };
    const patch = buildPrivateServiceExportPatch(content, { key: 'database', service: 'db', containerPort: 5432,
      scheme: 'postgres', hostPort: 15432, reach: { kind: 'privateNetwork', privateNetwork: 'shop-net', hostAddress: 'fd00::1' } });
    expect(parse(patch.definition.document).services.db.ports).toEqual(['5432:5432/udp',
      { target: 5432, published: '15432', host_ip: 'fd00::1', protocol: 'tcp' }]);
    expect(patch.ownServer.serviceExports.map(entry => entry.key)).toEqual(['other', 'database']);
  });

  it('shares through the Happier network on this Machine only, keeping native-network exports beside it', () => {
    const base = createDeploymentEnvironmentDetailV1().content;
    const native = { key: 'cache', service: 'cache', containerPort: 6379, scheme: 'redis',
      exposure: 'privateNetwork' as const, privateNetwork: 'shop-net' };
    const content = { ...base, ownServer: { rollout: 'recreate' as const, autoRestorePreviousRelease: true, serviceExports: [native] },
      definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
        document: 'services:\n  db:\n    image: postgres:17\n    ports:\n      - "5432:5432"\n  cache:\n    image: redis:7\n',
        profiles: [], services: [] } };
    const patch = buildPrivateServiceExportPatch(content, { key: 'database', service: 'db', containerPort: 5432,
      scheme: 'postgres', hostPort: 15432, reach: { kind: 'happierNetwork' } });
    expect(patch.ownServer.serviceExports).toEqual([native, { key: 'database', service: 'db', containerPort: 5432,
      scheme: 'postgres', exposure: 'loopback', transport: { kind: 'iroh' } }]);
    expect(parse(patch.definition.document).services.db.ports).toEqual([
      { target: 5432, published: '15432', host_ip: '127.0.0.1', protocol: 'tcp' }]);
    // Sharing another service later keeps the Happier network export as it was.
    const next = buildPrivateServiceExportPatch({ ...content, ownServer: { ...content.ownServer, serviceExports: patch.ownServer.serviceExports },
      definition: { ...content.definition, document: patch.definition.document } }, { key: 'cache', service: 'cache', containerPort: 6379,
      scheme: 'redis', hostPort: 16379, reach: { kind: 'happierNetwork' } });
    expect(next.ownServer.serviceExports.map(entry => [entry.key, entry.exposure])).toEqual([['database', 'loopback'], ['cache', 'loopback']]);
  });

  it('keeps normalized Compose output readable when the stored source is JSON', () => {
    const base = createDeploymentEnvironmentDetailV1().content;
    const content = { ...base, definition: { kind: 'stored' as const, contentRevision: 1,
      composeDigest: `sha256:${'a'.repeat(64)}`,
      document: '{"services":{"db":{"image":"postgres:17","ports":["5432:5432"]}}}',
      profiles: [], services: ['db'] } };
    const patch = buildPrivateServiceExportPatch(content, { key: 'database', service: 'db', containerPort: 5432,
      scheme: 'postgres', hostPort: 15432, reach: { kind: 'happierNetwork' } });
    expect(patch.definition.document).toContain('services:');
    expect(patch.definition.document).not.toMatch(/^"services":/m);
    expect(patch.definition.document).not.toMatch(/^    "image":/m);
    expect(parse(patch.definition.document).services.db.image).toBe('postgres:17');
  });
});
