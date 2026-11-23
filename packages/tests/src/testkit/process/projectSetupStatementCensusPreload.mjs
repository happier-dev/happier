import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';
import { Server } from 'node:http';
import { createRequire } from 'node:module';

const { path, sources, rows, trust, bodyHeader, readBodyMarker, authorizationHeader, probeHeader }
  = JSON.parse(process.env.HAPPIER_E2E_PROJECT_SETUP_STATEMENT_CENSUS);
const { Client } = createRequire(new URL('../../../../../apps/server/package.json', import.meta.url))('pg');
const requestStatements = new AsyncLocalStorage();

function routeOf(method, url) {
  // Daemon and browser transports can use either origin- or absolute-form.
  const route = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/\/{2,}/g, '/');
  if ((route === sources && method === 'GET') || route === `${sources}/list`) return 'source-list';
  if (method === 'GET' && route.startsWith(`${sources}/`)) return 'source';
  if (method === 'PATCH' && route.startsWith(`${sources}/`)) return 'source-write';
  if (method === 'GET' && route === '/v1/artifacts') return 'artifact-list';
  // The signed person client uses the selected E2EE batch read for one accepted detail.
  if (method === 'POST' && route === '/v1/artifacts/read') return 'artifact-accepted';
  if (method === 'GET' && /^\/v1\/artifacts\/[^/]+$/.test(route)) {
    return /[?&]projectSourceId=/.test(url) ? 'artifact-published' : 'artifact-accepted';
  }
  if (method === 'POST' && route === '/v1/artifacts') return 'artifact-create';
  if (method === 'GET' && /^\/v1\/artifacts\/[^/]+\/access\/recipients$/.test(route)) return 'artifact-recipients';
  if (method === 'POST' && /^\/v1\/artifacts\/[^/]+\/access\/key-envelopes$/.test(route)) return 'artifact-key-write';
  if (route.startsWith('/v1/artifacts')) return 'artifact-notification';
  if (route === `${rows}/read`) return 'row';
  if (route === `${rows}/list`) return 'row-list';
  if (route === `${rows}/mutate`) return 'row-mutate';
  if (route === '/v1/machines' || route === '/v1/machines/read') return 'machine-list';
  if (route.startsWith(trust)) return 'trust';
}

const emit = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) {
  if (event !== 'request') return emit.call(this, event, ...args);
  const [request, response] = args;
  const signed = Boolean(request.headers[authorizationHeader] || request.headers[bodyHeader]);
  const probe = request.headers[probeHeader];
  const method = request.method === 'POST' && request.headers[bodyHeader] === readBodyMarker ? 'GET' : request.method;
  const route = routeOf(method, request.url ?? '');
  const statements = [];
  response.once('finish', () => {
    if (!route && !statements.some(statement => statement.relations.includes('ProjectSource'))) return;
    appendFileSync(path, `${JSON.stringify({ route: route ?? 'source-related', status: response.statusCode, signed, probe, statements })}\n`);
  });
  return requestStatements.run(statements, () => emit.call(this, event, ...args));
};

const query = Client.prototype.query;
Client.prototype.query = function (...args) {
  const statements = requestStatements.getStore();
  const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
  if (!statements || typeof text !== 'string') return query.apply(this, args);
  // Store only the statement class and cardinality. Never retain identifiers, bindings or content.
  const operation = /^\s*(\w+)/.exec(text)?.[1]?.toUpperCase() ?? 'OTHER';
  const relations = ['ProjectSource', 'Artifact', 'UserKVStore', 'Machine'].filter(relation => text.includes(`"${relation}"`));
  const statement = { operation, relations };
  statements.push(statement);
  // The Prisma PostgreSQL adapter uses the driver's Promise API.
  const result = query.apply(this, args);
  if (!result || typeof result.then !== 'function') return result;
  return result.then(value => {
    if (typeof value.rowCount === 'number') statement.rows = value.rowCount;
    return value;
  });
};
