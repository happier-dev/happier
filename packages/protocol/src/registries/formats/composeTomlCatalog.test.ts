import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createRegistryHostV1 } from '../registryHostV1.js';
import { BUILT_IN_REGISTRY_SOURCES_V1, RegistrySourceDescriptorV1Schema } from '../registrySourcesV1.js';
import type { RegistryHttpV1 } from './registryFormatAdapterV1.js';
import { composeTomlCatalogRegistryAdapterV1 } from './composeTomlCatalog.js';
import { computeGitBlobShaV1, computeGitTreeShaV1 } from '../registryGitTreeV1.js';

const commit = 'c'.repeat(40);
const compose = `services:
  web:
    image: example/app:1
    environment:
      PASSWORD: \${APP_PASSWORD}
      SECOND_PASSWORD: \${APP_PASSWORD}
      SALT: \${APP_SALT}
      USERNAME: \${APP_USERNAME}
      ID: \${APP_ID}
      URL: \${APP_URL}
      PUBLIC: \${PUBLIC_VALUE:-default}
    volumes:
      - ../files/settings/app.conf:/etc/app.conf:ro
    healthcheck:
      test: ['CMD-SHELL', 'test "$(curl -s -o /dev/null -w ''%{http_code}'' http://localhost:8080/status)" = 204']
`;
const template = `[metadata]
id = "example"
name = "Example"
description = "A declarative app"
[variables]
password = "\${password:24}"
salt = "\${base64:64}"
user = "\${username}"
id = "\${uuid}"
domain = "\${domain}"
PUBLIC_VALUE = "public value"
[config]
[[config.domains]]
serviceName = "web"
port = 8080
path = "/status"
host = "\${domain}"
[config.env]
APP_PASSWORD = "\${password}"
APP_SALT = "\${salt}"
APP_USERNAME = "\${user}"
APP_ID = "\${id}"
APP_URL = "https://\${domain}/status"
PUBLIC_VALUE = "public value"
[[config.mounts]]
filePath = "settings/app.conf"
content = "hello=\${PUBLIC_VALUE}"
`;
function harness(config = template, body = compose, selectedId = 'example') {
  const calls: string[] = [];
  const source = RegistrySourceDescriptorV1Schema.parse({ id: 'toml-catalog', title: 'Apps', format: 'dokploy-templates', kinds: ['app'],
    url: 'https://github.com/example/templates', enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true });
  const http: RegistryHttpV1 = {
    getJson: async url => { calls.push(url); return { ok: true, fetchedAt: 1, value: url.includes('/commits/') ? { sha: commit }
      : url.includes('/git/trees/') ? { tree: ['meta.json', 'docker-compose.yml', 'template.toml'].map(file => ({
        path: `blueprints/${selectedId}/${file}`, mode: '100644', type: 'blob', sha: computeGitBlobShaV1(new TextEncoder().encode(file === 'docker-compose.yml' ? body : file === 'template.toml' ? config : '{}')),
      })) } : { id: selectedId, name: 'Example', description: 'A declarative app', version: '1', tags: ['operations'] } }; },
    getText: async url => { calls.push(url); return { ok: true, fetchedAt: 2, value: url.endsWith('/template.toml') ? config : body }; },
    getBytes: async () => { throw new Error('Unexpected byte acquisition'); },
  };
  return { calls, source, http, host: createRegistryHostV1({ host: 'node', http, readSources: async () => [source] }) };
}
describe('Compose and TOML catalog through the registered owner', () => {
  it.each(['supabase', 'example'])('admits typed JWT/hash helpers only for the named Supabase exception (%s)', async selectedId => {
    const { host } = harness("[variables]\njwt_secret = \"${password:32}\"\npayload = '{\"role\":\"anon\",\"iss\":\"supabase\",\"exp\":${timestamps:2030-01-01T00:00:00Z}}'\nanon_key = \"${jwt:jwt_secret:payload}\"\nrealtime_key = \"${hash:16}\"\npublishable = \"sb_publishable_${hash:22}_${hash:8}\"\n[config.env]\nANON_KEY = \"${anon_key}\"\nJWT_SECRET = \"${jwt_secret}\"\nREALTIME = \"${realtime_key}\"\nPUBLISHABLE = \"${publishable}\"\n", "services:\n  web:\n    image: example/app:1\n    environment:\n      ANON_KEY: ${ANON_KEY}\n      JWT_SECRET: ${JWT_SECRET}\n      REALTIME: ${REALTIME}\n      PUBLISHABLE: ${PUBLISHABLE}\n", selectedId);
    const result = await host.fetchRequest({ op: 'read', kind: 'app', sourceId: 'toml-catalog', itemId: selectedId, version: commit });
    if (selectedId !== 'supabase') { expect(result).toMatchObject({ op: 'read', item: { payload: { state: 'needs_review' } } }); return; }
    expect(result).toMatchObject({ op: 'read', item: { payload: { state: 'ready', app: { generatedSecrets: expect.arrayContaining([
      expect.objectContaining({ key: 'anon_key', profile: { kind: 'jwt-hs256', secretKey: 'jwt_secret', payload: { role: 'anon', iss: 'supabase', exp: 1893456000 } } }),
      expect.objectContaining({ key: 'realtime_key', profile: { kind: 'hex-bytes', bytes: 8 } }),
      expect.objectContaining({ key: 'publishable', profile: { kind: 'hex-characters', parts: ['sb_publishable_', 22, '_', 8] } }),
    ]) } } } });
  });
  it('keeps generated Supabase hash content out of public mount files', async () => {
    const { host } = harness('[variables]\nkey = "${hash:16}"\n[[config.mounts]]\nfilePath = "app.conf"\ncontent = "token=${key}"\n',
      'services:\n  web:\n    image: example/app:1\n    environment:\n      KEY: ${key}\n    volumes: ["../files/app.conf:/etc/app.conf:ro"]\n', 'supabase');
    expect(await host.fetchRequest({ op: 'read', kind: 'app', sourceId: 'toml-catalog', itemId: 'supabase', version: commit }))
      .toMatchObject({ op: 'read', item: { payload: { state: 'needs_review', diagnostics: expect.arrayContaining([
        { field: 'config.mounts.0', reason: 'secret_content_requires_binding' },
      ]) } } });
  });
  it('preserves Dokploy files-root contents and the distinct native writable directory without repairing vendor input', async () => {
    const { host } = harness('[config]\nenv = {}\n[[config.mounts]]\nfilePath = "/files/data"\ncontent = ""\n',
      'services:\n  web:\n    image: example/app:1\n    volumes:\n      - ../files/data:/data\n');
    const result = await host.fetchRequest({ op: 'read', kind: 'app', sourceId: 'toml-catalog', itemId: 'example', version: commit });
    expect(result).toMatchObject({ op: 'read', item: { payload: { state: 'ready', app: { compose: {
      publicFiles: [{ path: 'files/files/data', content: '' }],
    }, generatedSecrets: [], volumes: [] } } } });
    if (result.op !== 'read' || result.item.payload.kind !== 'app' || result.item.payload.state !== 'ready') throw new Error('Expected app');
    expect(parse(result.item.payload.app.compose.document).services.web.volumes).toEqual(['./files/data:/data']);
  });
  it('uses Dokploy native password length when the helper omits its argument', async () => {
    const { host } = harness('[variables]\npassword = "${password}"\n[config.env]\nTOKEN = "${password}"\n',
      'services:\n  web:\n    image: example/app:1\n    environment:\n      TOKEN: ${TOKEN}\n');
    expect(await host.fetchRequest({ op: 'read', kind: 'app', sourceId: 'toml-catalog', itemId: 'example', version: commit }))
      .toMatchObject({ op: 'read', item: { payload: { state: 'ready', app: {
        generatedSecrets: [{ key: 'password', profile: { kind: 'lowercase-alphanumeric-characters', characters: 16 } }],
      } } } });
  });
  it('preserves native array-form environment defaults and shared generated secrets', async () => {
    const { host } = harness('[variables]\npassword = "${password:64}"\ncopy = "${password}"\n[config]\nenv = ["TOKEN=${copy}", "PUBLIC=value=with=equals"]\nmounts = []\n',
      'services:\n  web:\n    image: example/app:1\n    environment:\n      TOKEN: ${TOKEN}\n      PUBLIC: ${PUBLIC}\n');
    const result = await host.fetchRequest({ op: 'read', kind: 'app', sourceId: 'toml-catalog', itemId: 'example', version: commit });
    expect(result).toMatchObject({ op: 'read', item: { payload: { state: 'ready', app: {
      generatedSecrets: [{ key: 'password', profile: { kind: 'lowercase-alphanumeric-characters', characters: 64 } }],
      variables: expect.arrayContaining([expect.objectContaining({ key: 'PUBLIC', default: 'value=with=equals' })]),
    } } } });
  });
  it('lists metadata only and maps the exact selected pair, shared variables, domains and contained public files', async () => {
    const { calls, host } = harness();
    expect(await host.fetchRequest({ op: 'list', kind: 'app', sourceId: 'toml-catalog' })).toMatchObject({ op: 'list', page: { total: 1, items: [{ itemId: 'example' }] } });
    expect(calls.some(url => /\.(yml|toml)$/.test(url))).toBe(false);
    const result = await host.fetchRequest({ op: 'read', kind: 'app', sourceId: 'toml-catalog', itemId: 'example', version: commit });
    expect(result.op).toBe('read');
    if (result.op !== 'read' || result.item.payload.kind !== 'app' || result.item.payload.state !== 'ready') throw new Error('Expected app');
    expect(result.item.summary.problem).toBeUndefined();
    const app = result.item.payload.app;
    expect(Object.fromEntries(app.generatedSecrets.map(secret => [secret.key, secret.profile]))).toEqual({
      password: { kind: 'lowercase-alphanumeric-characters', characters: 24 }, salt: { kind: 'base64-bytes', bytes: 64 },
      user: { kind: 'lowercase-username' }, id: { kind: 'uuid-v4' },
    });
    expect(app.domains).toEqual([{ key: 'domain', service: 'web', containerPort: 8080, protocol: 'http', required: true, path: '/status', healthCheck: { path: '/status', expectStatus: 204 } }]);
    expect(app.variables.find(variable => variable.key === 'domain')?.valueFrom).toEqual({ kind: 'domainHost', domainKey: 'domain' });
    const document = parse(app.compose.document);
    expect(document.services.web.environment).toMatchObject({ PASSWORD: '\${password}', SECOND_PASSWORD: '\${password}', SALT: '\${salt}', URL: 'https://\${domain}/status', PUBLIC: '\${PUBLIC_VALUE:-default}' });
    expect(document.services.web.volumes).toEqual(['./files/settings/app.conf:/etc/app.conf:ro']);
    expect(app.compose.publicFiles).toEqual([{ path: 'files/settings/app.conf', content: 'hello=public value' }]);
    expect(app.variables.find(variable => variable.key === 'PUBLIC_VALUE')?.default).toBe('public value');
    expect(calls.filter(url => /\.(yml|toml)$/.test(url))).toEqual([
      `https://raw.githubusercontent.com/example/templates/${commit}/blueprints/example/docker-compose.yml`,
      `https://raw.githubusercontent.com/example/templates/${commit}/blueprints/example/template.toml`,
    ]);
    expect(result.item.payload.ref).toMatchObject({ kind: 'gitTree', commit, treeSha: computeGitTreeShaV1([
      { path: 'blueprints/example/docker-compose.yml', unixMode: 0o644, bytes: new TextEncoder().encode(compose) },
      { path: 'blueprints/example/template.toml', unixMode: 0o644, bytes: new TextEncoder().encode(template) },
    ]) });
  });
  it('does not execute unsupported helpers or admit host writes and secret inline files', async () => {
    const { host } = harness(template.replace('password = "\${password:24}"', 'password = "\${jwt}"').replace('filePath = "settings/app.conf"', 'filePath = "../host/app.conf"'));
    const result = await host.fetchRequest({ op: 'read', kind: 'app', sourceId: 'toml-catalog', itemId: 'example', version: commit });
    expect(result).toMatchObject({ op: 'read', item: { summary: { problem: { code: 'needs_review', diagnostics: expect.arrayContaining([
      expect.objectContaining({ reason: 'unsupported_helper' }), expect.objectContaining({ reason: 'unsafe_mount_path' }),
    ]) } } } });
  });
  it.each([
    { config: template.replace('hello=\${PUBLIC_VALUE}', 'password=\${password}'), body: compose, reason: 'secret_content_requires_binding' },
    { config: template.replace('hello=\${PUBLIC_VALUE}', 'password=\${password:32}'), body: compose, reason: 'secret_content_requires_binding' },
    { config: '[config.env]\nPUBLIC = "value"\n[[config.mounts]]\nfilePath = "app.conf"\ncontent = "${PUBLIC}"\n',
      body: 'services:\n  web:\n    image: example/app:1\n', reason: 'unresolved_file_variable' },
    { config: '[variables]\nfolder = "config"\n[[config.mounts]]\nfilePath = "${folder}/app.conf"\ncontent = ""\n',
      body: 'services:\n  web:\n    image: example/app:1\n', reason: 'unresolved_file_variable' },
  ])('keeps $reason visible through the registered owner', async ({ config, body, reason }) => {
    const { host } = harness(config, body);
    expect(await host.fetchRequest({ op: 'read', kind: 'app', sourceId: 'toml-catalog', itemId: 'example', version: commit }))
      .toMatchObject({ op: 'read', item: { payload: { state: 'needs_review', diagnostics: expect.arrayContaining([expect.objectContaining({ reason })]) } } });
  });
  it('admits an unprobed Domain through the registered owner without inventing HTTP operands', async () => {
    const { host } = harness(template, compose.slice(0, compose.indexOf('    healthcheck:')));
    const result = await host.fetchRequest({ op: 'read', kind: 'app', sourceId: 'toml-catalog', itemId: 'example', version: commit });
    expect(result).toMatchObject({ op: 'read', item: { payload: { state: 'ready', app: { domains: [{ key: 'domain' }] } } } });
    if (result.op !== 'read' || result.item.payload.kind !== 'app' || !('app' in result.item.payload)) throw new Error('Expected app');
    expect(result.item.payload.app?.domains[0]).not.toHaveProperty('healthCheck');
  });
  it('checks only the demanded pair through Git metadata and keeps its read identity', async () => {
    const { host, calls, http, source } = harness();
    const read = await host.fetchRequest({ op: 'read', kind: 'app', sourceId: source.id, itemId: 'example', version: commit });
    if (read.op !== 'read' || read.item.payload.kind !== 'app' || read.item.payload.ref.kind !== 'gitTree') throw new Error('Expected pinned app');
    calls.length = 0;
    const result = await composeTomlCatalogRegistryAdapterV1.latest({ http }, [{ sourceId: source.id, format: source.format, sourceUrl: source.url,
      itemId: 'example', importedAt: 0, ref: read.item.payload.ref }], { source });
    expect(result.get('example')).toEqual(read.item.payload.ref);
    expect(calls.some(url => /\.(yml|toml)$/.test(url))).toBe(false);
  });
  it('lists and reads the built-in published catalog with authored domain health through the host', async () => {
    const source = BUILT_IN_REGISTRY_SOURCES_V1.find(source => source.format === 'dokploy-templates');
    expect(source).toBeDefined();
    if (!source) throw new Error('Missing built-in source');
    const calls: string[] = [];
    const http: RegistryHttpV1 = {
      getJson: async url => { calls.push(url); return { ok: true, fetchedAt: 1, value: [{ id: 'uptime-kuma', name: 'Uptime Kuma', logo: 'uptime-kuma.png', tags: ['monitoring'] },
        ...Array.from({ length: 585 }, (_, index) => ({ id: `other-${index}`, name: `Other ${index}` }))] }; },
      getText: async url => { calls.push(url); return { ok: true, fetchedAt: 2, value: url.endsWith('.toml')
        ? '[variables]\nmain_domain = "${domain}"\n[config]\nenv = {}\nmounts = []\n[[config.domains]]\nserviceName = "uptime-kuma"\nport = 3_001\nhost = "${main_domain}"\n'
        : 'services:\n  uptime-kuma:\n    image: louislam/uptime-kuma:2.1.0\n    volumes: ["uptime-kuma-data:/app/data"]\nvolumes:\n  uptime-kuma-data: {}\n' }; },
      getBytes: async () => { throw new Error('Unexpected bytes acquisition'); },
    };
    const host = createRegistryHostV1({ host: 'node', http, readSources: async () => [source] });
    const listed = await host.fetchRequest({ op: 'list', sourceId: source.id, kind: 'app' });
    expect(listed).toMatchObject({ op: 'list', page: { total: 586 } });
    if (listed.op !== 'list') throw new Error('Expected catalog');
    expect(listed.page.items[0]).toMatchObject({ itemId: 'uptime-kuma', title: 'Uptime Kuma',
      iconUrl: 'https://templates.dokploy.com/blueprints/uptime-kuma/uptime-kuma.png' });
    expect(calls).toEqual(['https://templates.dokploy.com/meta.json']);
    const selected = await host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'app', itemId: 'uptime-kuma' });
    expect(selected).toMatchObject({ op: 'read', item: { payload: { state: 'ready', app: { domains: [{ key: 'main_domain',
      healthCheck: { path: '/api/entry-page', expectStatus: 200 } }], firstRunSetup: true }, ref: { kind: 'content' } } } });
    if (selected.op !== 'read' || selected.item.payload.kind !== 'app' || selected.item.payload.ref.kind !== 'content') throw new Error('Expected content pin');
    calls.length = 0;
    const latest = await composeTomlCatalogRegistryAdapterV1.latest({ http }, [{ sourceId: source.id, format: source.format, sourceUrl: source.url,
      itemId: 'uptime-kuma', importedAt: 0, ref: selected.item.payload.ref }], { source });
    expect(latest.get('uptime-kuma')).toEqual(selected.item.payload.ref);
    expect(calls).toEqual(['https://templates.dokploy.com/meta.json',
      'https://templates.dokploy.com/blueprints/uptime-kuma/docker-compose.yml', 'https://templates.dokploy.com/blueprints/uptime-kuma/template.toml']);
  });
});
