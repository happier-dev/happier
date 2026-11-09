import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { buildPrivateServiceExportPatch } from './privateServiceExport';

describe('private service export authoring', () => {
  it('saves the selected concrete publication and export together, preserving other ports and source inputs', () => {
    const base = createDeploymentEnvironmentDetailV1().content;
    const content = { ...base, definition: { kind: 'stored' as const, contentRevision: 4,
      composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  db:\n    image: postgres:17\n    ports:\n      - "5432:5432"\n      - "127.0.0.1:9100:9100"\n  app:\n    image: app:1\n',
      profiles: ['data'], services: ['db', 'app'], publicFiles: [{ path: 'settings.conf', content: 'retained' }] } };
    const patch = buildPrivateServiceExportPatch(content, { key: 'database', service: 'db', containerPort: 5432,
      scheme: 'postgres', privateNetwork: 'shop-net', hostAddress: '100.81.1.12', hostPort: 15432 });
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
      scheme: 'postgres', privateNetwork: 'shop-net', hostAddress: 'fd00::1', hostPort: 15432 });
    expect(parse(patch.definition.document).services.db.ports).toEqual(['5432:5432/udp',
      { target: 5432, published: '15432', host_ip: 'fd00::1', protocol: 'tcp' }]);
    expect(patch.ownServer.serviceExports.map(entry => entry.key)).toEqual(['other', 'database']);
  });
});
