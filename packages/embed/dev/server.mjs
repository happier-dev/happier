import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { connect } from '@happier-dev/sdk';
import { buildFixtureHappierUrl, createFixtureStore, createCredentialIssuer, createLeadChat,
  createLivePageBootstrap, matchFixtureLiveRoute,
  projectFixtureErrorLog, projectFixtureErrorResponse } from './fixture.mjs';
import { buildLivePageBundle } from './liveBundle.mjs';
import { FIXTURE_ORIGIN } from './leads-fixture/contracts.mjs';

const token = process.env.HAPPIER_EMBED_KEY;
const endpoint = process.env.HAPPIER_SERVER_URL;
const configuredHappierUrl = process.env.HAPPIER_WEBAPP_URL;
if (!token || !endpoint || !configuredHappierUrl) throw new Error('Set HAPPIER_EMBED_KEY, HAPPIER_SERVER_URL and HAPPIER_WEBAPP_URL.');
const happierUrl = buildFixtureHappierUrl(configuredHappierUrl, endpoint);
const happier = connect({ endpoint, token });
const store = createFixtureStore();
const issuer = createCredentialIssuer({ embed: happier.embed, store,
  expiresInSeconds: Number(process.env.HAPPIER_FIXTURE_CREDENTIAL_SECONDS ?? 900) });
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./host.tsx', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser',
  alias: {
    '@happier-dev/embed/react': fileURLToPath(new URL('../src/react/index.tsx', import.meta.url)),
    '@happier-dev/embed': fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    '@happier-dev/protocol/embed': fileURLToPath(new URL('../../protocol/src/embed/index.ts', import.meta.url)),
  },
});
const liveBundle = await buildLivePageBundle();
const page = await readFile(new URL('./host.html', import.meta.url));
const livePage = await readFile(new URL('./live.html', import.meta.url));
const users = new Set(['salesperson', 'other-salesperson']);

function currentUser(req) {
  const id = /(?:^|;\s*)happier_fixture_user=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (!id || !users.has(id)) throw Object.assign(new Error('sign_in_required'), { status: 401 });
  return id;
}

async function body(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || '{}');
}

function reply(res, status, value, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "frame-ancestors 'none'" });
  res.end(type === 'application/json' ? JSON.stringify(value) : value);
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', FIXTURE_ORIGIN).pathname;
    const liveRoute = matchFixtureLiveRoute(req.method, path);
    if (req.method === 'GET' && path === '/') {
      if (!req.headers.cookie?.includes('happier_fixture_user=')) res.setHeader('set-cookie', 'happier_fixture_user=salesperson; HttpOnly; SameSite=Strict; Path=/');
      return reply(res, 200, page, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && path === '/host.js') return reply(res, 200, bundle.outputFiles[0].contents, 'text/javascript');
    if (req.method === 'GET' && path === '/live.js') return reply(res, 200, liveBundle.outputFiles[0].contents, 'text/javascript');
    if (liveRoute?.kind === 'page') {
      if (!req.headers.cookie?.includes('happier_fixture_user=')) res.setHeader('set-cookie', 'happier_fixture_user=salesperson; HttpOnly; SameSite=Strict; Path=/');
      return reply(res, 200, livePage, 'text/html; charset=utf-8');
    }
    // Plugin callbacks have no browser Origin. This fixture is loopback-only, with no production authentication claim.
    if (req.method === 'POST' && path.startsWith('/api/actions/')) {
      if (req.headers.origin) return reply(res, 403, { error: 'browser_action_callback_forbidden' });
      return reply(res, 200, store.apply(path.slice('/api/actions/'.length), await body(req),
        req.headers['idempotency-key'], req.headers['x-happier-fixture-session-id']));
    }
    const userId = currentUser(req);
    if (req.method === 'POST' && req.headers.origin !== FIXTURE_ORIGIN) return reply(res, 403, { error: 'fixture_origin_required' });
    if (req.method === 'POST' && path === '/api/user') {
      const input = await body(req);
      if (!users.has(input.userId)) return reply(res, 400, { error: 'unknown_fixture_user' });
      res.setHeader('set-cookie', `happier_fixture_user=${input.userId}; HttpOnly; SameSite=Strict; Path=/`);
      return reply(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/api/state') return reply(res, 200, {
      userId, happierUrl, leads: store.listLeads(userId), copilotSessionId: store.copilotSessionId(userId),
    });
    if (req.method === 'POST' && path === '/api/happier/credential') return reply(res, 200, await issuer.issue(userId, await body(req)));
    if (liveRoute?.kind === 'credential') {
      return reply(res, 200, await createLivePageBootstrap({ endpoint, issuer, store, userId, leadId: liveRoute.leadId }));
    }
    if (req.method === 'GET' && path === '/api/happier/sessions') {
      const result = await happier.embed.listSessions();
      // Listing uses the embed's folder/tag filter; returned rows additionally require CRM ownership.
      return reply(res, 200, { ...result, sessions: result.sessions.filter((session) => store.canOpenSession(userId, session.id)) });
    }
    const create = /^\/api\/leads\/([^/]+)\/chat$/.exec(path);
    if (req.method === 'POST' && create) {
      return reply(res, 200, { sessionId: await createLeadChat({ happier, store, userId, leadId: create[1] }) });
    }
    reply(res, 404, { error: 'not_found' });
  } catch (error) {
    const response = projectFixtureErrorResponse(error);
    process.stderr.write(`Fixture request failed: ${JSON.stringify(projectFixtureErrorLog(error))}\n`);
    reply(res, response.status, response.body);
  }
});
const address = new URL(FIXTURE_ORIGIN);
server.listen(Number(address.port || '80'), address.hostname, () => process.stdout.write(`Leads fixture: ${FIXTURE_ORIGIN}\n`));
