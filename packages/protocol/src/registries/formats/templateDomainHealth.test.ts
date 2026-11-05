import { describe, expect, it } from 'vitest';
import { DeploymentTemplateV1Schema } from '../../plugins/contributions/deploymentTemplates.js';
import { normalizeComposeTemplateV1 } from './composeTemplateNormalizationV1.js';
import { createRegistryHostV1 } from '../registryHostV1.js';
import { BUILT_IN_REGISTRY_SOURCES_V1, RegistrySourceDescriptorV1Schema } from '../registrySourcesV1.js';

const domain = { key: 'WEB', service: 'web', containerPort: 8080, protocol: 'https', required: true };
const template = { schemaVersion: 1, title: 'Web', compose: {
  document: 'services:\n  web:\n    image: web:1\n', profiles: [], services: ['web'],
}, variables: [], generatedSecrets: [], domains: [domain], volumes: [] };

describe('template Domain health admission', () => {
  it('admits the upstream Linkding app with generated credentials, persistent database and its database health endpoint', async () => {
    const source = BUILT_IN_REGISTRY_SOURCES_V1.find(source => source.id === 'builtin:compose-catalog');
    if (!source) throw new Error('Missing built-in catalog');
    // Coolify templates/compose/linkding.yaml, retrieved 2026-11-04.
    const document = `# port: 9090
services:
  linkding:
    image: sissbruecker/linkding:latest
    volumes:
      - 'linkding_data:/etc/linkding/data'
    environment:
      - SERVICE_URL_LINKDING_9090
      - LD_SUPERUSER_NAME=\${SERVICE_USER_LINKDING}
      - LD_SUPERUSER_PASSWORD=\${SERVICE_PASSWORD_LINKDING}
    healthcheck:
      test: ["CMD-SHELL", "bash -c ':> /dev/tcp/127.0.0.1/9090' || exit 1"]
      interval: 5s
      timeout: 5s
`;
    const host = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
      getJson: async url => ({ ok: true, fetchedAt: 1, value: url.includes('/commits/')
        ? { sha: 'a'.repeat(40) } : { linkding: { slogan: 'Bookmark manager', port: '9090' } } }),
      getText: async () => ({ ok: true, fetchedAt: 1, value: document }),
      getBytes: async () => { throw new Error('Unexpected bytes fetch'); },
    } });
    expect(await host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'app', itemId: 'linkding' }))
      .toMatchObject({ op: 'read', item: { payload: { state: 'ready', app: {
        domains: [{ key: 'SERVICE_URL_LINKDING_9090', healthCheck: { path: '/health', expectStatus: 200 } }],
        generatedSecrets: [{ key: 'SERVICE_USER_LINKDING' }, { key: 'SERVICE_PASSWORD_LINKDING' }],
        volumes: [{ id: 'linkding_data', target: '/etc/linkding/data', persistent: true }],
      } } } });
  });

  it('admits the bundled 9router template with its documented health endpoint', async () => {
    const source = BUILT_IN_REGISTRY_SOURCES_V1.find(source => source.id === 'builtin:compose-catalog');
    if (!source) throw new Error('Missing built-in catalog');
    // https://github.com/coollabsio/coolify/blob/0becfba/templates/compose/9router.yaml
    const document = `# port: 20128
services:
  9router:
    image: decolua/9router:0.5.65
    volumes:
      - '9router:/app/data'
    environment:
      - SERVICE_URL_9ROUTER_20128
      - DATA_DIR=/app/data
      - INITIAL_PASSWORD=\${SERVICE_PASSWORD_PASSWORD}
      - JWT_SECRET=\${SERVICE_PASSWORD_64_JWTSECRET}
      - API_KEY_SECRET=\${SERVICE_PASSWORD_KEYSECRET}
      - MACHINE_ID_SALT=\${SERVICE_HEX_64_HMACSALT}
    healthcheck:
      test: [CMD, wget, --spider, 'http://127.0.0.1:20128/']
      interval: 5s
      timeout: 10s
      retries: 5
`;
    const host = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
      getJson: async url => ({ ok: true, fetchedAt: 1, value: url.includes('/commits/')
        ? { sha: 'a'.repeat(40) } : { '9router': { slogan: 'AI coding gateway' } } }),
      getText: async () => ({ ok: true, fetchedAt: 1, value: document }),
      getBytes: async () => { throw new Error('Unexpected bytes fetch'); },
    } });
    const result = await host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'app', itemId: '9router' });
    expect(result).toMatchObject({ op: 'read', item: { payload: { state: 'ready', app: { domains: [{
      key: 'SERVICE_URL_9ROUTER_20128', healthCheck: { path: '/api/health', expectStatus: 200 },
    }] } } } });
  });

  it('retains an authored path and non-default HTTP status in the reviewed Domain declaration', () => {
    const authored = { ...domain, healthCheck: { path: '/ready', expectStatus: 204 } };
    expect(DeploymentTemplateV1Schema.parse({ ...template, domains: [authored] }).domains).toEqual([authored]);
  });

  it('admits an authored Domain without inventing a probe while rejecting malformed supplied probes', () => {
    expect(DeploymentTemplateV1Schema.parse(template).domains).toEqual([domain]);
    expect(DeploymentTemplateV1Schema.safeParse({ ...template,
      domains: [{ ...domain, healthCheck: { path: '/ready' } }] }).success).toBe(false);
  });

  it('admits opaque Compose checks without fabricating Domain HTTP health', () => {
    const result = normalizeComposeTemplateV1({ title: 'Web', document: `services:
  web:
    image: web:1
    environment:
      - SERVICE_URL_WEB_8080
    healthcheck:
      test: [CMD, extra/healthcheck]
` });
    expect(result).toMatchObject({ state: 'ready', diagnostics: [], app: { domains: [{ key: 'SERVICE_URL_WEB_8080' }] } });
    if (result.state !== 'ready') throw new Error('Expected installable template');
    expect(result.app.domains[0]).not.toHaveProperty('healthCheck');
  });

  it('derives the literal path and exact status from a service HTTP status assertion', () => {
    const result = normalizeComposeTemplateV1({ title: 'Web', document: `services:
  web:
    image: web:1
    environment:
      - SERVICE_URL_WEB_8080
    healthcheck:
      test: ['CMD-SHELL', 'test "$(curl -s -o /dev/null -w ''%{http_code}'' http://localhost:8080/ready)" = 204']
` });
    expect(result).toMatchObject({ state: 'ready', app: { domains: [{
      key: 'SERVICE_URL_WEB_8080', healthCheck: { path: '/ready', expectStatus: 204 },
    }] } });
  });

  it('does not treat curl success for a range of statuses as an exact HTTP status', () => {
    const result = normalizeComposeTemplateV1({ title: 'Web', document: `services:
  web:
    image: web:1
    environment:
      - SERVICE_URL_WEB_8080
    healthcheck:
      test: [CMD, curl, -f, http://localhost:8080/ready]
` });
    expect(result).toMatchObject({ state: 'ready', diagnostics: [] });
    if (result.state !== 'ready') throw new Error('Expected installable template');
    expect(result.app.domains[0]).not.toHaveProperty('healthCheck');
  });

  it('uses an evidenced service probe before an authored fallback', () => {
    const result = normalizeComposeTemplateV1({ title: 'Web',
      domainHealthChecks: { SERVICE_URL_WEB_8080: { path: '/authored', expectStatus: 200 } },
      document: `services:
  web:
    image: web:1
    environment:
      - SERVICE_URL_WEB_8080
    healthcheck:
      test: ['CMD-SHELL', 'test "$(curl -s -o /dev/null -w ''%{http_code}'' http://localhost:8080/ready)" = 204']
` });
    expect(result).toMatchObject({ state: 'ready', app: { domains: [{
      key: 'SERVICE_URL_WEB_8080', healthCheck: { path: '/ready', expectStatus: 204 },
    }] } });
  });

  it('keeps authored built-in probes without requiring them for foreign catalog data', async () => {
    const builtin = BUILT_IN_REGISTRY_SOURCES_V1.find(source => source.id === 'builtin:compose-catalog');
    if (!builtin) throw new Error('Missing built-in catalog');
    const document = `services:
  uptime-kuma:
    image: louislam/uptime-kuma:2
    environment:
      - SERVICE_URL_UPTIMEKUMA_3001
    healthcheck:
      test: [CMD-SHELL, extra/healthcheck]
`;
    for (const [descriptor, expected] of [
      [builtin, 'ready'],
      [{ ...builtin, origin: { kind: 'user' }, removable: true }, 'ready'],
      [{ ...builtin, url: 'https://github.com/other/catalog' }, 'ready'],
    ] as const) {
      const source = RegistrySourceDescriptorV1Schema.parse(descriptor);
      const host = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
        getJson: async url => ({ ok: true, fetchedAt: 1, value: url.includes('/commits/')
          ? { sha: 'a'.repeat(40) } : { 'uptime-kuma': { slogan: 'Monitoring' } } }),
        getText: async () => ({ ok: true, fetchedAt: 1, value: document }),
        getBytes: async () => { throw new Error('Unexpected bytes fetch'); },
      } });
      const result = await host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'app', itemId: 'uptime-kuma' });
      expect(result).toMatchObject({ op: 'read', item: { payload: { state: expected } } });
      if (descriptor === builtin) expect(result).toMatchObject({ op: 'read', item: { payload: { app: {
        firstRunSetup: true, domains: [{ key: 'SERVICE_URL_UPTIMEKUMA_3001',
          healthCheck: { path: '/api/entry-page', expectStatus: 200 } }],
      } } } });
      else {
        if (result.op !== 'read' || result.item.payload.kind !== 'app' || !('app' in result.item.payload)) throw new Error('Expected app');
        expect(result.item.payload.app?.domains[0]).not.toHaveProperty('healthCheck');
      }
    }
  });
});
