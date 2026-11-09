import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test, vi } from 'vitest';
import { buildFixtureHappierUrl, createFixtureStore, createCredentialIssuer, createLeadChat,
  createLivePageBootstrap, matchFixtureLiveRoute,
  projectFixtureErrorLog, projectFixtureErrorResponse } from './fixture.mjs';
import { buildLivePageBundle } from './liveBundle.mjs';
import { actionSchemas } from './leads-fixture/contracts.mjs';
import { activate, manifest } from './leads-fixture/index.ts';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { AccountApiTokenBearerV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';

const analysis = { leadId: 'northstar', score: 84, summary: 'Strong fit', nextStep: 'Call Maya' };
const publicKey = Buffer.alloc(32, 1).toString('base64url');
const spawnTokenId = '11111111-1111-4111-8111-111111111111';
const sessionTokenId = '22222222-2222-4222-8222-222222222222';
const expiredTokenId = '33333333-3333-4333-8333-333333333333';
const leadSessionId = 'northstar-session';

// Cold source SDK loading and two real browser builds exceed the unit-test deadline.
test('a second fixture origin reaches the listener, browser routes, POST guard and Happier URL', { timeout: 0 }, async () => {
  // The OS selects a free test port; never bind a running QA lane's fixed port.
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const origin = `http://127.0.0.1:${reservation.address().port}`;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  vi.stubEnv('HAPPIER_FIXTURE_ORIGIN', origin);
  vi.resetModules();
  try {
    const configured = await import('./leads-fixture/contracts.mjs');
    // Fail before starting the server if it would use the default QA port.
    assert.equal(configured.FIXTURE_ORIGIN, origin);
    const plugin = await import('./leads-fixture/index.ts');
    assert.equal(plugin.manifest.hostAccess.required[0].scope.targets[0].origin, origin);
    const child = spawn(process.execPath, ['--conditions=happier-source', '--import', 'tsx',
      fileURLToPath(new URL('./server.mjs', import.meta.url))], {
      // Only synthetic configuration reaches this child, so startup diagnostics contain no QA secrets.
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HAPPIER_FIXTURE_ORIGIN: origin,
        HAPPIER_EMBED_KEY: AccountApiTokenBearerV1Schema.parse(`hap_v1_${spawnTokenId}_${Buffer.alloc(32, 1).toString('base64url')}`),
        HAPPIER_SERVER_URL: 'http://home.example.test',
        HAPPIER_WEBAPP_URL: 'http://ui.example.test/?happier_hmr=0&server=http%3A%2F%2Fstale.example.test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    try {
      let output = '';
      let diagnostic = '';
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`Fixture exited before listening (${code}): ${diagnostic}`)));
        child.stdout.on('data', (chunk) => {
          output += chunk;
          if (output.includes('Leads fixture:')) resolve();
        });
        child.stderr.on('data', (chunk) => { diagnostic += chunk; });
      });
      assert.equal(output.trim(), `Leads fixture: ${origin}`);
      for (const path of ['/', '/live/verdant', '/host.js', '/live.js']) {
        const response = await fetch(`${origin}${path}`);
        assert.equal(response.status, 200);
        await response.arrayBuffer();
      }
      const headers = { cookie: 'happier_fixture_user=salesperson', 'content-type': 'application/json' };
      const refused = await fetch(`${origin}/api/user`, {
        method: 'POST', headers: { ...headers, origin: 'http://127.0.0.1:5199' },
        body: JSON.stringify({ userId: 'other-salesperson' }),
      });
      assert.equal(refused.status, 403);
      assert.deepEqual(await refused.json(), { error: 'fixture_origin_required' });
      const accepted = await fetch(`${origin}/api/user`, {
        method: 'POST', headers: { ...headers, origin },
        body: JSON.stringify({ userId: 'other-salesperson' }),
      });
      assert.equal(accepted.status, 200);
      assert.deepEqual(await accepted.json(), { ok: true });
      const state = await fetch(`${origin}/api/state`, { headers });
      assert.equal(state.status, 200);
      const url = new URL((await state.json()).happierUrl);
      assert.equal(url.origin, 'http://ui.example.test');
      assert.equal(url.searchParams.get('server'), 'http://home.example.test');
      assert.equal(url.searchParams.get('happier_hmr'), '0');
    } finally {
      child.kill();
      await closed;
    }
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});

test.each([undefined, 'http://127.0.0.1:1', 'http://127.0.0.1:80', 'http://127.0.0.1:65535'])(
  'uses the default or a valid browser-canonical fixture origin %j', async (origin) => {
    vi.stubEnv('HAPPIER_FIXTURE_ORIGIN', origin);
    vi.resetModules();
    try {
      const configured = await import('./leads-fixture/contracts.mjs');
      assert.equal(configured.FIXTURE_ORIGIN, origin === undefined ? 'http://127.0.0.1:5199' : new URL(origin).origin);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  },
);

test.each(['', 'https://127.0.0.1:5200', 'http://localhost:5200', 'http://0.0.0.0:5200',
  'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:5200/path',
  'http://user@127.0.0.1:5200', 'http://127.0.0.1:5200?x=1'])('rejects invalid fixture origin %j', async (origin) => {
  vi.stubEnv('HAPPIER_FIXTURE_ORIGIN', origin);
  vi.resetModules();
  try {
    await assert.rejects(import('./leads-fixture/contracts.mjs'), /HAPPIER_FIXTURE_ORIGIN/);
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});

test('the development fixture starts against current workspace SDK source', async () => {
  const packageJson = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  assert.match(packageJson.scripts.start, /(?:^|\s)--conditions=happier-source(?:\s|$)/);
  assert.match(packageJson.scripts.start, /(?:^|\s)--import\s+tsx(?:\s|$)/);
});

test('the fixture selects its SDK Home in every embed frame URL', () => {
  const url = new URL(buildFixtureHappierUrl(
    'http://happier-agent-qa-embed.localhost:19364/?happier_hmr=0&server=https%3A%2F%2Fstale.example',
    'http://happier-agent-qa-embed.localhost:19361',
  ));
  assert.equal(url.origin, 'http://happier-agent-qa-embed.localhost:19364');
  assert.equal(url.searchParams.get('happier_hmr'), '0');
  assert.equal(url.searchParams.get('server'), 'http://happier-agent-qa-embed.localhost:19361');
});

test('the fixture owns the live page and credential routes without broad path matches', () => {
  assert.deepEqual(matchFixtureLiveRoute('GET', '/live/verdant'), { kind: 'page', leadId: 'verdant' });
  assert.deepEqual(matchFixtureLiveRoute('POST', '/api/live/verdant/credential'), { kind: 'credential', leadId: 'verdant' });
  assert.equal(matchFixtureLiveRoute('GET', '/api/live/verdant/credential'), null);
  assert.equal(matchFixtureLiveRoute('GET', '/live/verdant/extra'), null);
  assert.equal(matchFixtureLiveRoute('GET', '/live/%2F'), null);
});

test('the live page reuses the embed credential issuer and returns only its child bearer', async () => {
  const store = createFixtureStore();
  store.attachLeadSession('salesperson', 'verdant', 'verdant-session');
  const calls = [];
  const bootstrap = await createLivePageBootstrap({
    endpoint: 'https://home.example.test',
    issuer: { async issue(userId, input) {
      calls.push({ userId, input });
      return {
        token: 'child-browser-token',
        tokenId: sessionTokenId,
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
    } },
    store,
    userId: 'salesperson',
    leadId: 'verdant',
  });
  assert.deepEqual(bootstrap, {
    endpoint: 'https://home.example.test',
    sessionId: 'verdant-session',
    token: 'child-browser-token',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, 'salesperson');
  assert.deepEqual({ ...calls[0].input, embedPublicKey: '<ephemeral>' }, {
    sessionId: 'verdant-session', reason: 'open', embedPublicKey: '<ephemeral>',
  });
  assert.match(calls[0].input.embedPublicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(JSON.stringify(bootstrap), /tokenId/);

  await assert.rejects(createLivePageBootstrap({
    endpoint: 'https://home.example.test', issuer: { issue: async () => ({ token: 'unexpected' }) },
    store, userId: 'other-salesperson', leadId: 'verdant',
  }), /lead_forbidden/);
});

test('the live page bundles the public browser SDK without Node transports', async () => {
  const bundle = await buildLivePageBundle();
  const inputs = Object.keys(bundle.metafile.inputs);
  assert.ok(inputs.some((path) => path.endsWith('sdk/src/index.public.ts')));
  assert.ok(inputs.some((path) => path === 'live.ts' || path.endsWith('embed/dev/live.ts')));
  assert.ok(inputs.every((path) => !/(?:^|\/)undici(?:\/|$)/u.test(path)));
  assert.ok(Object.values(bundle.metafile.outputs).every((output) => output.imports.every(({ path }) => !path.startsWith('node:'))));
  assert.doesNotMatch(bundle.outputFiles[0].text, /HAPPIER_EMBED_KEY|server\.mjs/);
});

function ownedStore() {
  const store = createFixtureStore();
  store.attachLeadSession('salesperson', 'northstar', leadSessionId);
  return store;
}

test('the plugin uses only the host Action identity for backend replay', async () => {
  const store = ownedStore();
  const keys = [];
  const testkit = await createPluginTestkit({ manifest, module: { activate } });
  try {
    const registration = testkit.registration('actions', 'update-stage');
    assert.ok(registration);
    // The host invocation context and HTTP service are this plugin's system boundaries.
    const context = {
      invocationId: 'host-approved-operation', session: { id: leadSessionId },
      signal: new AbortController().signal,
      services: { http: { async request(request) {
        const key = request.headers['idempotency-key'];
        keys.push(key);
        const input = JSON.parse(new TextDecoder().decode(request.body));
        assert.equal(Object.hasOwn(input, 'invocationId'), false);
        const result = store.apply('update_stage', input, key, request.headers['x-happier-fixture-session-id']);
        return { status: 200, body: new TextEncoder().encode(JSON.stringify(result)) };
      } } },
    };
    const input = { leadId: 'northstar', stage: 'qualified' };
    await registration(input, context);
    await registration(input, { ...context, signal: new AbortController().signal });
    assert.deepEqual(keys, ['host-approved-operation', 'host-approved-operation']);
    assert.equal(store.listLeads('salesperson')[0].stageUpdates, 1);
    await assert.rejects(registration(input, { ...context, invocationId: undefined }), /fixture_invocation_required/);
    assert.equal(store.listLeads('salesperson')[0].stageUpdates, 1);
  } finally {
    await testkit.dispose();
  }
});

test('validates business Action input before changing the lead', () => {
  assert.deepEqual({ ...actionSchemas.record_analysis.parse(analysis) }, analysis);
  assert.throws(() => actionSchemas.record_analysis.parse({ ...analysis, invocationId: 'caller-id' }));
  assert.deepEqual({ ...actionSchemas.update_stage.parse({ leadId: 'northstar', stage: 'qualified' }) },
    { leadId: 'northstar', stage: 'qualified' });
  assert.throws(() => actionSchemas.update_stage.parse({ leadId: 'northstar', stage: 'qualified', invocationId: 'caller-id' }));
  const store = ownedStore();
  assert.throws(() => store.apply('record_analysis', { ...analysis, score: 101 }, 'invocation-1', leadSessionId));
  assert.equal(store.listLeads('salesperson')[0].analysis, null);
  assert.throws(() => store.apply('update_stage', { leadId: 'northstar', stage: 'invented' }, 'approval-1', leadSessionId));
  store.apply('record_analysis', analysis, 'invocation-1', leadSessionId);
  assert.deepEqual(store.listLeads('salesperson')[0].analysis, {
    score: 84, summary: 'Strong fit', nextStep: 'Call Maya',
  });
});

test('replays an invocation once and rejects key reuse for a different mutation', () => {
  const store = ownedStore();
  const result = store.apply('update_stage', { leadId: 'northstar', stage: 'qualified' }, 'approval-1', leadSessionId);
  assert.deepEqual(store.apply('update_stage', { leadId: 'northstar', stage: 'qualified' }, 'approval-1', leadSessionId), result);
  // A replay key is correlation, not ownership: even an exact retained key must not disclose its result.
  assert.throws(() => store.apply('update_stage', { leadId: 'northstar', stage: 'qualified' }, 'approval-1', 'unowned-session'), /session_forbidden/);
  store.attachLeadSession('other-salesperson', 'alpine', 'foreign-owned-session');
  assert.throws(() => store.apply('update_stage', { leadId: 'northstar', stage: 'qualified' }, 'approval-1', 'foreign-owned-session'), /lead_forbidden/);
  assert.equal(store.listLeads('salesperson')[0].stageUpdates, 1);
  assert.throws(() => store.apply('update_stage', { leadId: 'northstar', stage: 'won' }, 'approval-1', leadSessionId), /idempotency_conflict/);
  assert.throws(() => store.apply('record_analysis', analysis, '', leadSessionId), /idempotency_key_required/);
  assert.throws(() => store.apply('update_stage', { leadId: 'northstar', stage: 'won', invocationId: 'approval-2' }, 'approval-2', leadSessionId));
  assert.equal(store.listLeads('salesperson')[0].stage, 'qualified');
});

test('business callbacks require an owned session and refuse another salesperson\'s lead', () => {
  const store = ownedStore();
  assert.throws(() => store.apply('record_analysis', analysis, 'missing-session'), /session_forbidden/);
  assert.throws(() => store.apply('record_analysis', analysis, 'foreign-session', 'unowned-session'), /session_forbidden/);
  assert.throws(() => store.apply('update_stage', { leadId: 'alpine', stage: 'qualified' }, 'foreign-lead', leadSessionId), /lead_forbidden/);
  assert.equal(store.listLeads('other-salesperson')[0].stageUpdates, 0);
  store.claimCopilot('salesperson', 'copilot-session');
  store.apply('update_stage', { leadId: 'verdant', stage: 'contacted' }, 'copilot-update', 'copilot-session');
  assert.equal(store.listLeads('salesperson')[1].stage, 'contacted');
});

test('lead initialization reports a typed SDK failure with its retained Session and no exception text', async () => {
  const store = createFixtureStore();
  const creationInputs = [];
  const sendOptions = [];
  let rejectSend = true;
  const session = { id: leadSessionId, async send(message, options) {
    assert.equal(store.canOpenSession('salesperson', leadSessionId), true);
    assert.match(message, /Northstar|research team/);
    assert.match(message, /dev\.leads-fixture\/actions\/record-analysis/);
    sendOptions.push(options);
    if (rejectSend) throw Object.assign(new Error('sensitive transport detail'), {
      code: 'target_unavailable', status: 503,
    });
    store.apply('record_analysis', analysis, 'analysis-result', leadSessionId);
    return { status: 'accepted', localId: 'first-turn' };
  } };
  // The SDK is the fixture's network boundary; its Session handle is the public send contract.
  const happier = { embed: { async createSession(input, options) {
    creationInputs.push({ input, options });
    return session;
  } }, sessions: { get: () => session } };
  const failure = await createLeadChat({ happier, store, userId: 'salesperson', leadId: 'northstar' })
    .then(() => null, (error) => error);
  assert.deepEqual(projectFixtureErrorResponse(failure), {
    status: 503,
    body: { error: 'target_unavailable', sessionId: leadSessionId },
  });
  assert.doesNotMatch(JSON.stringify(projectFixtureErrorResponse(failure)), /sensitive transport detail/);
  assert.equal(store.listLeads('salesperson')[0].sessionId, leadSessionId);
  rejectSend = false;
  assert.equal(await createLeadChat({ happier, store, userId: 'salesperson', leadId: 'northstar' }), leadSessionId);
  assert.equal(creationInputs.length, 1);
  assert.equal(creationInputs[0].input.initialMessage, undefined);
  assert.ok(creationInputs[0].options.requestId);
  assert.ok(sendOptions[0].requestId);
  assert.notEqual(sendOptions[0].requestId, creationInputs[0].options.requestId);
  assert.deepEqual(sendOptions[1], sendOptions[0]);
  await assert.rejects(createLeadChat({ happier, store, userId: 'other-salesperson', leadId: 'northstar' }), /lead_forbidden/);
});

test('fixture failure diagnostics project only typed issue paths and codes', () => {
  const response = projectFixtureErrorResponse(Object.assign(new Error('private input value'), {
    code: 'invalid_parameters',
    details: [
      { path: ['organizationPlacement', 'sectionId'], code: 'invalid_type', message: 'private input value' },
      { path: ['organizationPlacement'], code: 'unrecognized_keys', keys: ['folderId'] },
    ],
  }));
  assert.deepEqual(response, {
    status: 400,
    body: { error: 'invalid_parameters', issues: [
      { path: ['organizationPlacement', 'sectionId'], code: 'invalid_type' },
      { path: ['organizationPlacement'], code: 'unrecognized_keys' },
    ] },
  });
  assert.doesNotMatch(JSON.stringify(response), /private input value|folderId/);
  assert.deepEqual(projectFixtureErrorLog(Object.assign(new Error('private input value'), {
    code: 'invalid_parameters', details: response.body.issues,
  })), {
    status: 400, error: 'invalid_parameters', issues: response.body.issues,
  });
  assert.deepEqual(projectFixtureErrorLog(new Error('private input value')), {
    status: 400, error: 'fixture_error',
  });
  assert.deepEqual(projectFixtureErrorLog(Object.assign(new Error('private input value'), {
    code: 'credential_scope_denied', status: 403, details: {
      admissionStage: 'execution_authorization', grantReason: 'create_not_granted', privateValue: 'must-not-cross',
    },
  })), {
    status: 403, error: 'credential_scope_denied', diagnostic: {
      admissionStage: 'execution_authorization', grantReason: 'create_not_granted',
    },
  });
});

test('lead creation projects a typed SDK spawn failure without exception text', async () => {
  const store = createFixtureStore();
  const happier = {
    embed: { async createSession() {
      throw Object.assign(new Error('sensitive spawn detail'), {
        code: 'invalid_parameters',
        details: { issues: [
          { path: ['organizationPlacement', 'sectionId'], code: 'invalid_type', message: 'sensitive spawn detail' },
        ] },
        session: { id: leadSessionId },
        result: { type: 'error', code: 'invalid_parameters', retryable: false },
      });
    } },
    sessions: { get() { throw new Error('Unexpected retained Session'); } },
  };

  const failure = await createLeadChat({ happier, store, userId: 'salesperson', leadId: 'northstar' })
    .then(() => null, (error) => error);
  assert.deepEqual(projectFixtureErrorResponse(failure), {
    status: 400,
    body: { error: 'invalid_parameters', sessionId: leadSessionId,
      issues: [{ path: ['organizationPlacement', 'sectionId'], code: 'invalid_type' }] },
  });
  assert.doesNotMatch(JSON.stringify(projectFixtureErrorResponse(failure)), /sensitive spawn detail/);
  assert.equal(store.listLeads('salesperson')[0].sessionId, null);
});

test('an ambiguous initial send returns the retained Session for recovery', async () => {
  const store = createFixtureStore();
  const session = {
    id: leadSessionId,
    async send() {
      return { status: 'outcomeUnknown', localId: 'first-turn' };
    },
  };
  const happier = {
    embed: { async createSession() { return session; } },
    sessions: { get: () => session },
  };

  assert.equal(await createLeadChat({ happier, store, userId: 'salesperson', leadId: 'northstar' }), leadSessionId);
  assert.equal(store.listLeads('salesperson')[0].sessionId, leadSessionId);
});

test('lead creation identity is stable for retries but fresh after fixture state restarts', async () => {
  const observedRequestIds = [];
  const createHappier = () => ({ embed: { async createSession(_input, options) {
    observedRequestIds.push(options.requestId);
    throw Object.assign(new Error('private spawn detail'), {
      result: { type: 'error', code: 'spawn_failed', retryable: false },
    });
  } }, sessions: { get() { throw new Error('Unexpected retained Session'); } } });

  const firstStore = createFixtureStore();
  await assert.rejects(createLeadChat({ happier: createHappier(), store: firstStore,
    userId: 'salesperson', leadId: 'northstar' }), /spawn_failed/);
  await assert.rejects(createLeadChat({ happier: createHappier(), store: firstStore,
    userId: 'salesperson', leadId: 'northstar' }), /spawn_failed/);
  const replacementStore = createFixtureStore();
  await assert.rejects(createLeadChat({ happier: createHappier(), store: replacementStore,
    userId: 'salesperson', leadId: 'northstar' }), /spawn_failed/);

  assert.equal(observedRequestIds[0], observedRequestIds[1]);
  assert.notEqual(observedRequestIds[2], observedRequestIds[0]);
});

test('a created credential retry keeps attribution and establishes renewal ownership only after verified mint', async () => {
  const store = createFixtureStore();
  const calls = [];
  let rejectMint = false;
  const issuer = createCredentialIssuer({ store, embed: {
    async createCredential(input) {
      calls.push(input);
      if (rejectMint) throw new Error('api_token_child_invalid');
      return { tokenId: input.sessionId ? sessionTokenId : spawnTokenId, token: 'test-token', expiresAt: '2099-01-01T00:00:00.000Z' };
    },
  } });
  await issuer.issue('salesperson', { embedPublicKey: publicKey, reason: 'initial' });
  const created = { sessionId: 'new-session', embedPublicKey: publicKey, reason: 'created', createdByTokenId: spawnTokenId };
  rejectMint = true;
  await assert.rejects(issuer.issue('salesperson', created), /api_token_child_invalid/);
  assert.equal(store.canOpenSession('salesperson', 'new-session'), false);
  rejectMint = false;
  await issuer.issue('salesperson', created);
  await issuer.issue('salesperson', created);
  assert.equal(calls.at(-1).requireCreatedBy, spawnTokenId);
  await issuer.issue('salesperson', { sessionId: 'new-session', embedPublicKey: publicKey, reason: 'expiring' });
  assert.equal(calls.at(-1).requireCreatedBy, undefined);
  await assert.rejects(issuer.issue('other-salesperson', created), /session_forbidden/);
  await assert.rejects(issuer.issue('salesperson', { sessionId: 'foreign-session', embedPublicKey: publicKey, reason: 'open' }), /session_forbidden/);
});

test('an expired new-chat issuance cannot claim a session', async () => {
  const store = createFixtureStore();
  const issuer = createCredentialIssuer({ store, embed: {
    async createCredential() {
      return { tokenId: expiredTokenId, token: 'test-token', expiresAt: '1970-01-01T00:00:00.000Z' };
    },
  } });
  await issuer.issue('salesperson', { embedPublicKey: publicKey, reason: 'initial' });
  await assert.rejects(issuer.issue('salesperson', {
    sessionId: 'new-session', embedPublicKey: publicKey, reason: 'created', createdByTokenId: expiredTokenId,
  }), /session_forbidden/);
  assert.equal(store.copilotSessionId('salesperson'), null);
});
