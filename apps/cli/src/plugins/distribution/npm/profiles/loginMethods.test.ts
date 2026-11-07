import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { createNpmRegistryProfileService } from './service';
import { createNpmRegistryProfileProbe } from './probe';
import { npmHttpRequestBoundary, npmHttpResponse } from '../../testkit/npmHttp';

describe('npm registry sign-in methods', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  async function fixture(responses: Parameters<typeof npmHttpRequestBoundary>[0]['responses']) {
    const root = await mkdtemp(join(tmpdir(), 'npm-login-methods-')); roots.push(root);
    const homeDir = join(root, 'user'); const projectDir = join(root, 'project'); const prefix = join(root, 'prefix');
    await Promise.all([mkdir(homeDir), mkdir(projectDir), mkdir(join(prefix, 'etc'), { recursive: true }), mkdir(join(prefix, 'bin'), { recursive: true })]);
    const nodePath = join(prefix, 'bin', 'node');
    await writeFile(nodePath, 'fixture executable');
    await chmod(nodePath, 0o755);
    const seen: RequestOptions[] = [];
    const destroyed: Error[] = [];
    const http = { request: npmHttpRequestBoundary({ responses, seen, destroyed }), lookup: async () => [{ address: '93.184.216.34', family: 4 as const }] };
    const config = { homeDir, cwd: projectDir, execPath: nodePath, platform: 'linux' as const, env: { TOKEN: 'fixture-project-token', PATH: join(prefix, 'bin') } };
    const service = createNpmRegistryProfileService({ happyHomeDir: join(root, 'happier'), npmConfig: config, http,
      probe: createNpmRegistryProfileProbe({ ...http }),
    });
    await service.mutate({ action: 'add', machineId: 'm1', expectedRevision: 0, mutationId: 'add', profileId: 'npm',
      profile: { displayName: 'npm', origin: 'https://registry.example.test', scopes: [], useAsDefault: true, allowPrivateNetwork: false } });
    return { root, homeDir, projectDir, prefix, service, seen, http, config, destroyed };
  }
  const login = { action: 'login' as const, machineId: 'm1', profileId: 'npm', expectedRevision: 1, mutationId: 'login' };

  it('reports a missing Machine login without requiring an npm executable or contacting the registry', async () => {
    const h = await fixture([]);
    await expect(h.service.mutate({ ...login, credential: { kind: 'machine', projectDir: h.projectDir } }))
      .resolves.toEqual({ status: 'error', code: 'authentication_required', retryable: false });
    expect(h.seen).toHaveLength(0);
    expect((await h.service.snapshot()).profiles[0]?.hasCredentials).toBe(false);
  });

  it('uses the selected registry project/user/global npm config chain in place and picks up token rotation', async () => {
    const h = await fixture([npmHttpResponse({})]);
    await writeFile(join(h.prefix, 'etc', 'npmrc'), '//registry.example.test/:_authToken=global-token\n');
    await writeFile(join(h.homeDir, '.npmrc'), '//registry.example.test/:_authToken=user-token\n//other.test/:_authToken=wrong-registry\n');
    await writeFile(join(h.projectDir, 'package.json'), '{}');
    await writeFile(join(h.projectDir, '.npmrc'), '//registry.example.test/:_authToken=${TOKEN}\n');
    const result = await h.service.mutate({ ...login, credential: { kind: 'machine', projectDir: h.projectDir } });
    expect(result).toMatchObject({ status: 'success', snapshot: { profiles: [{ hasCredentials: true, availability: 'available' }] } });
    expect(h.seen[0]?.headers).toMatchObject({ authorization: 'Bearer fixture-project-token' });
    const profileBytes = await readFile(join(h.root, 'happier/plugins/plugins/state/npm-registry-profiles.v1.json'), 'utf8');
    expect(profileBytes).not.toContain('fixture-project-token');
    await writeFile(join(h.projectDir, '.npmrc'), '//registry.example.test/:_authToken=rotated-in-place\n');
    await expect(h.service.withAuthorization('npm', async ({ authorizationHeader }) => authorizationHeader)).resolves.toBe('Bearer rotated-in-place');
    await rm(join(h.projectDir, '.npmrc'));
    await expect(h.service.withAuthorization('npm', async ({ authorizationHeader }) => authorizationHeader)).resolves.toBe('Bearer user-token');
    await rm(join(h.homeDir, '.npmrc'));
    await expect(h.service.withAuthorization('npm', async ({ authorizationHeader }) => authorizationHeader)).resolves.toBe('Bearer global-token');
    expect(JSON.stringify(result)).not.toMatch(/token|npmrc|projectDir/);
  });

  it('starts browser login and completes the npm 202/200 protocol without projecting token or completion URL', async () => {
    const h = await fixture([
      npmHttpResponse({ loginUrl: 'https://www.npmjs.com/login?next=fixture', doneUrl: 'https://registry.npmjs.org/-/v1/done/private-session' }),
      npmHttpResponse({}, { statusCode: 202, headers: { 'content-type': 'application/json', 'retry-after': '0' } }),
      npmHttpResponse({ token: 'browser-private-token' }), npmHttpResponse({}),
    ]);
    const start = await h.service.mutate({ ...login, credential: { kind: 'browser', step: 'start' } });
    expect(start).toMatchObject({ status: 'browser_login_required', loginUrl: 'https://www.npmjs.com/login?next=fixture', loginId: expect.any(String) });
    if (start.status !== 'browser_login_required') throw new Error('Expected browser login');
    const completed = await h.service.mutate({ ...login, mutationId: 'complete', credential: { kind: 'browser', step: 'complete', loginId: start.loginId } });
    expect(completed).toMatchObject({ status: 'success', snapshot: { profiles: [{ hasCredentials: true, availability: 'available' }] } });
    expect(h.seen.map(({ method, hostname, path }) => ({ method, hostname, path }))).toEqual([
      { method: 'POST', hostname: 'registry.example.test', path: '/-/v1/login' },
      { method: 'GET', hostname: 'registry.example.test', path: '/-/v1/done/private-session' },
      { method: 'GET', hostname: 'registry.example.test', path: '/-/v1/done/private-session' },
      { method: 'GET', hostname: 'registry.example.test', path: '/-/ping' },
    ]);
    expect(h.seen[1]?.headers).toMatchObject({ 'cache-control': 'no-cache' });
    expect(h.seen[1]?.headers).not.toHaveProperty('authorization');
    await expect(h.service.withAuthorization('npm', async ({ authorizationHeader }) => authorizationHeader)).resolves.toBe('Bearer browser-private-token');
    expect(JSON.stringify([start, completed])).not.toMatch(/browser-private-token|private-session/);
  });

  it('cancels an in-flight browser completion without creating credentials', async () => {
    let reached!: () => void;
    const polling = new Promise<void>((resolve) => { reached = resolve; });
    const h = await fixture([
      npmHttpResponse({ loginUrl: 'https://www.npmjs.com/login', doneUrl: 'https://registry.example.test/-/v1/done/private-session' }),
      () => reached(),
    ]);
    const start = await h.service.mutate({ ...login, credential: { kind: 'browser', step: 'start' } });
    if (start.status !== 'browser_login_required') throw new Error('Expected browser login');
    const complete = h.service.mutate({ ...login, mutationId: 'complete', credential: { kind: 'browser', step: 'complete', loginId: start.loginId } });
    await polling;
    await expect(h.service.mutate({ ...login, mutationId: 'cancel', credential: { kind: 'browser', step: 'cancel', loginId: start.loginId } })).resolves.toEqual({ status: 'cancelled' });
    await expect(complete).resolves.toEqual({ status: 'cancelled' });
    expect((await h.service.snapshot()).profiles[0]).toMatchObject({ hasCredentials: false });
  });

  it('keeps unsupported web login and invalid completion data private', async () => {
    const unsupported = await fixture([npmHttpResponse({ error: 'private-response' }, { statusCode: 404 })]);
    await expect(unsupported.service.mutate({ ...login, credential: { kind: 'browser', step: 'start' } })).resolves.toEqual({ status: 'error', code: 'web_login_unsupported', retryable: false });
    const invalid = await fixture([
      npmHttpResponse({ loginUrl: 'https://www.npmjs.com/login', doneUrl: 'https://registry.example.test/-/v1/done/private-session' }),
      npmHttpResponse({ privateData: 'must-not-project' }),
    ]);
    const start = await invalid.service.mutate({ ...login, credential: { kind: 'browser', step: 'start' } });
    if (start.status !== 'browser_login_required') throw new Error('Expected browser login');
    const result = await invalid.service.mutate({ ...login, mutationId: 'complete', credential: { kind: 'browser', step: 'complete', loginId: start.loginId } });
    expect(result).toEqual({ status: 'error', code: 'unavailable', retryable: true });
    expect(JSON.stringify(result)).not.toContain('must-not-project');
    expect((await invalid.service.snapshot()).profiles[0]?.hasCredentials).toBe(false);
  });

  it('honors npm environment-selected user config and global prefix without using another registry token', async () => {
    const h = await fixture([npmHttpResponse({})]);
    const prefix = join(h.root, 'npm-prefix');
    await mkdir(join(prefix, 'etc'), { recursive: true });
    await writeFile(join(prefix, 'etc', 'npmrc'), '//registry.example.test/:_authToken=prefix-token\n');
    const userconfig = join(h.homeDir, 'customrc');
    await writeFile(userconfig, '//other.test/:_authToken=wrong-registry\n');
    await writeFile(join(h.projectDir, 'package.json'), '{}');
    Object.assign(h.config.env, { NPM_CONFIG_USERCONFIG: userconfig, PREFIX: prefix });
    await expect(h.service.mutate({ ...login, credential: { kind: 'machine', projectDir: h.projectDir } })).resolves.toMatchObject({ status: 'success' });
    expect(h.seen[0]?.headers).toMatchObject({ authorization: 'Bearer prefix-token' });
  });

  it('discovers the Machine Node global config through PATH and symlinks when Happier is a bundled executable', async () => {
    const h = await fixture([npmHttpResponse({})]);
    const shims = join(h.root, 'shims');
    await mkdir(shims);
    await symlink(join(h.prefix, 'bin', 'node'), join(shims, 'node'));
    h.config.env.PATH = shims;
    h.config.execPath = join(h.root, 'happier-bin', 'happier');
    await writeFile(join(h.prefix, 'etc', 'npmrc'), '//registry.example.test/:_authToken=machine-node-token\n');
    await expect(h.service.mutate({ ...login, credential: { kind: 'machine', projectDir: h.projectDir } })).resolves.toMatchObject({ status: 'success' });
    expect(h.seen[0]?.headers).toMatchObject({ authorization: 'Bearer machine-node-token' });
  });

  it('keeps a newly acquired credential bound to its selected origin when the profile changes before the probe', async () => {
    const responses: Parameters<typeof npmHttpRequestBoundary>[0]['responses'] = [npmHttpResponse({ loginUrl: 'https://www.npmjs.com/login', doneUrl: 'https://registry.example.test/-/v1/done/session' })];
    const h = await fixture(responses);
    const writer = createNpmRegistryProfileService({ happyHomeDir: join(h.root, 'happier') });
    // Genuine streamed HTTP response delays token acquisition while another profile mutation commits.
    const tokenResponse = Readable.from((async function* () {
      await writer.mutate({ action: 'update', machineId: 'm1', expectedRevision: 1, mutationId: 'change-origin', profileId: 'npm',
        profile: { displayName: 'Changed', origin: 'https://changed.example.test', scopes: [], useAsDefault: true, allowPrivateNetwork: false } });
      yield JSON.stringify({ token: 'origin-bound-token' });
    })());
    Object.assign(tokenResponse, { statusCode: 200, headers: { 'content-type': 'application/json' } });
    responses.push(tokenResponse as unknown as IncomingMessage, npmHttpResponse({}));
    const start = await h.service.mutate({ ...login, credential: { kind: 'browser', step: 'start' } });
    if (start.status !== 'browser_login_required') throw new Error('Expected browser login');
    const result = await h.service.mutate({ ...login, mutationId: 'complete', credential: { kind: 'browser', step: 'complete', loginId: start.loginId } });
    expect(h.seen.filter(({ hostname, headers }) => hostname === 'changed.example.test' && headers && 'authorization' in headers)).toEqual([]);
    expect(result).toMatchObject({ status: 'error', code: 'revision_conflict' });
    expect((await h.service.snapshot()).profiles[0]?.hasCredentials).toBe(false);
  });

  it('cancels the availability probe after the browser token arrives', async () => {
    let reached!: () => void; let respond!: (message: IncomingMessage) => void;
    const probing = new Promise<void>((resolve) => { reached = resolve; });
    const h = await fixture([
      npmHttpResponse({ loginUrl: 'https://www.npmjs.com/login', doneUrl: 'https://registry.example.test/-/v1/done/session' }),
      npmHttpResponse({ token: 'browser-token' }),
      (callback) => { respond = callback; reached(); },
    ]);
    const start = await h.service.mutate({ ...login, credential: { kind: 'browser', step: 'start' } });
    if (start.status !== 'browser_login_required') throw new Error('Expected browser login');
    const completing = h.service.mutate({ ...login, mutationId: 'complete', credential: { kind: 'browser', step: 'complete', loginId: start.loginId } });
    await probing;
    await h.service.mutate({ ...login, mutationId: 'cancel', credential: { kind: 'browser', step: 'cancel', loginId: start.loginId } });
    try { expect(h.destroyed).toHaveLength(1); }
    finally { respond(npmHttpResponse({})); await expect(completing).resolves.toEqual({ status: 'cancelled' }); }
    expect((await h.service.snapshot()).profiles[0]?.hasCredentials).toBe(false);
  });
});
