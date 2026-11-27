import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { postgresqlReadOnlyRoleGuardSql } from '../../../deployment-protocol/src/secrets/postgresqlReadOnlyRole';
import { startConnectedAccountTlsRecordingProxy } from './providers/connectedAccountTlsRecordingProxy';

export type DeploymentJourneyProvider = 'vercel' | 'cloudflare' | 'neon';

// Install the external HTTP delegate before the first account-host import.
// loadUndici's CJS named exports snapshot this function, so its identity stays
// stable for the test module while each sequential journey owns its socket.
const undici: typeof import('undici') = createRequire(new URL('../../../../apps/cli/package.json', import.meta.url))('undici/index.js');
const providerHosts = new Set(['api.vercel.com', 'api.cloudflare.com', 'console.neon.tech', 'ep-journey.neon.tech', 'api.eu-central-1.aws.neon.tech',
  'api.supabase.com', 'api.preview.aws.neon.tech', 'api.production.aws.neon.tech', 'api.neighbor.aws.neon.tech']);
const nativeFetch = undici.fetch;
let providerDispatcher: InstanceType<typeof undici.ProxyAgent> | undefined;
undici.fetch = (input, init) => {
  const address = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
  return nativeFetch(input, providerDispatcher && providerHosts.has(address.hostname) ? { ...init, dispatcher: providerDispatcher } : init);
};

type ManagedSupabaseRead = Readonly<{ branchRef: string; sql: string; parameters: readonly unknown[] }>;

/** Constructed official REST vectors. Only provider HTTPS crosses this boundary;
 * Home HTTP, Action admission, credential custody and plugin execution stay real.
 * Contracts: Vercel REST v2/v9/v11/v13, Cloudflare v4 Workers, Neon API v2,
 * as characterized by the bundled providers' HTTP contract tests. */
export async function startDeploymentProvidersHttp({ seedManagedProjects = false, readManagedSupabase, managedSupabaseAddress }: {
  seedManagedProjects?: boolean;
  readManagedSupabase?: (statement: ManagedSupabaseRead) => Promise<readonly Record<string, unknown>[] | undefined>;
  managedSupabaseAddress?: () => Readonly<{ hostname: string; port: string }>;
} = {}) {
  const vercel = { teamId: 'team_journey', projectId: 'prj_journey', deploymentId: 'dpl_journey', name: 'journey-vercel' };
  const cloudflare = { accountId: 'a'.repeat(32), tokenId: 'b'.repeat(32), projectId: 'c'.repeat(32), deploymentId: 'journey-build', name: 'journey-worker',
    triggerUuid: 'journey-trigger', versionId: 'journey-version', zoneId: 'e'.repeat(32) };
  const neon = { organizationId: 'org-journey', projectId: 'journey-neon', branchId: 'br-journey', endpointId: 'ep-journey',
    readRolePassword: 'journey-provider-read-role-only' };
  const managedBranches = [
    { name: 'preview', neonId: 'br-preview', supabaseRef: 'journey-preview', marker: 'selected-preview' },
    { name: 'production', neonId: 'br-production', supabaseRef: 'journey-production', marker: 'selected-production' },
    { name: 'neighbor', neonId: 'br-neighbor', supabaseRef: 'journey-neighbor', marker: 'neighbor-database' },
  ] as const;
  const supabase = { organizationSlug: 'journey-organization', projectRef: 'journey-supabase' };
  let rejectNextManagedQuery: 'neon' | 'supabase' | undefined;
  let vercelDeleted = false;
  let cloudflareDeleted = false;
  let vercelDomainAttached = false;
  let vercelDomainVerified = false;
  let cloudflareDomainAttached = false;
  let rejectNextVercelDeployment = false;
  let rejectNextCloudflareDeployment = false;
  const proxy = await startConnectedAccountTlsRecordingProxy({
    additionalDnsNames: [...providerHosts],
    async responseForRequest(request) {
      const url = new URL(request.path, `https://${request.connectTarget}`);
      const method = request.method;
      const path = url.pathname;
      const ok = (body: unknown, statusCode = 200) => ({ statusCode, body });
      const cf = (result: unknown) => ok({ success: true, errors: [], messages: [], result });
      if (url.hostname === 'api.vercel.com') {
        if (method === 'GET' && path === '/v2/teams') return ok({ teams: [{ id: vercel.teamId, name: 'Journey team' }], pagination: { next: null } });
        if (method === 'GET' && path === `/v2/teams/${vercel.teamId}`) return ok({ id: vercel.teamId, name: 'Journey team' });
        const project = { id: vercel.projectId, accountId: vercel.teamId, name: vercel.name,
          link: { type: 'github', org: 'journey', repo: 'app', repoId: '123', productionBranch: 'main' } };
        if (method === 'POST' && path === '/v11/projects') { vercelDeleted = false; return ok(project); }
        if (method === 'DELETE' && path === `/v9/projects/${vercel.projectId}`) { vercelDeleted = true; return ok(null, 204); }
        if (method === 'GET' && path === `/v9/projects/${vercel.projectId}`) return vercelDeleted
          ? ok({ error: { code: 'not_found' } }, 404) : ok(project);
        if (method === 'GET' && path === '/v1/integrations/search-repo') return ok({ repos: [{ id: '123', provider: 'github', namespace: 'journey', slug: 'app' }] });
        if (method === 'POST' && path === '/v13/deployments') {
          if (rejectNextVercelDeployment) {
            rejectNextVercelDeployment = false;
            return { statusCode: 403, headers: { 'x-vercel-id': 'journey-provider-refusal' }, body: { error: { code: 'forbidden', message: 'Fixture deployment refused' } } };
          }
          return ok({ id: vercel.deploymentId, projectId: vercel.projectId, readyState: 'BUILDING' });
        }
        if (method === 'GET' && path === `/v13/deployments/${vercel.deploymentId}`) return ok({ id: vercel.deploymentId, projectId: vercel.projectId,
          readyState: 'READY', url: 'journey-vercel.vercel.app' });
        const domainPath = `/v9/projects/${vercel.projectId}/domains/journey.example.test`;
        const domain = () => ({ name: 'journey.example.test', projectId: vercel.projectId, verified: vercelDomainVerified });
        if (method === 'POST' && path === `/v10/projects/${vercel.projectId}/domains`) {
          vercelDomainAttached = true;
          return ok(domain());
        }
        if (method === 'POST' && path === `${domainPath}/verify`) {
          vercelDomainVerified = true;
          return ok(domain());
        }
        if (method === 'DELETE' && path === domainPath) { vercelDomainAttached = false; return ok(null, 204); }
        if (method === 'GET' && path === domainPath) return vercelDomainAttached ? ok(domain()) : ok({ error: { code: 'not_found' } }, 404);
        if (path === '/v6/domains/journey.example.test/config') return ok({ misconfigured: false });
      }
      if (url.hostname === 'api.cloudflare.com') {
        if (method === 'GET' && path === '/client/v4/user/tokens/verify') return cf({ id: cloudflare.tokenId, status: 'active' });
        if (method === 'GET' && path === '/client/v4/accounts') return ok({ success: true, errors: [], messages: [],
          result: [{ id: cloudflare.accountId, name: 'Journey account' }],
          result_info: { count: 1, page: 1, per_page: 20, total_count: 1 } });
        const base = `/client/v4/accounts/${cloudflare.accountId}`;
        if (method === 'GET' && path === `${base}/workers/scripts`) return cf([{ id: cloudflare.name, tag: cloudflare.projectId }]);
        if (method === 'GET' && path === `${base}/workers/workers/${cloudflare.name}/previews`) return cf([]);
        if (method === 'GET' && path === `${base}/builds/workers/${cloudflare.projectId}/triggers`) return cf([{ trigger_uuid: cloudflare.triggerUuid,
          external_script_id: cloudflare.projectId, repo_connection: { provider_type: 'github', provider_account_name: 'journey', repo_name: 'app', repo_id: '123' } }]);
        if (method === 'POST' && path === `${base}/builds/triggers/${cloudflare.triggerUuid}/builds`) {
          if (rejectNextCloudflareDeployment) {
            rejectNextCloudflareDeployment = false;
            return ok({ success: false, errors: [{ code: 10000, message: 'Fixture deployment refused' }], messages: [] }, 403);
          }
          return cf({ build_uuid: cloudflare.deploymentId, status: 'queued' });
        }
        if (method === 'GET' && path === `${base}/builds/builds/${cloudflare.deploymentId}`) return cf({ build_uuid: cloudflare.deploymentId, status: 'stopped', build_outcome: 'success' });
        if (method === 'GET' && path === `${base}/workers/scripts/${cloudflare.name}/deployments`) return cf({ deployments: [{ id: 'journey-active', versions: [{ version_id: cloudflare.versionId, percentage: 100 }] }] });
        if (method === 'GET' && path === `${base}/builds/builds`) return cf({ builds: { [cloudflare.versionId]: { build_uuid: cloudflare.deploymentId } } });
        if (method === 'GET' && path === `${base}/workers/scripts/${cloudflare.name}/subdomain`) return cf({ enabled: true });
        if (method === 'GET' && path === `${base}/workers/subdomain`) return cf({ subdomain: 'journey' });
        const domain = { id: 'journey-domain', hostname: 'journey.example.test', service: cloudflare.name,
          zone_id: cloudflare.zoneId, zone_name: 'example.test', enabled: true };
        if (method === 'GET' && path === `${base}/workers/domains`) return cf(cloudflareDomainAttached ? [domain] : []);
        if (method === 'PUT' && path === `${base}/workers/domains`) { cloudflareDomainAttached = true; return cf(domain); }
        if (method === 'DELETE' && path === `${base}/workers/domains/journey-domain`) { cloudflareDomainAttached = false; return cf(null); }
        if (method === 'DELETE' && path === `${base}/workers/workers/${cloudflare.projectId}`) { cloudflareDeleted = true; return cf(null); }
        if (method === 'GET' && path === `${base}/workers/workers/${cloudflare.projectId}`) return cloudflareDeleted
          ? ok({ success: false, errors: [{ code: 10007, message: 'Script not found' }] }, 404)
          : cf({ script: { id: cloudflare.name, tag: cloudflare.projectId } });
      }
      if (url.hostname === 'console.neon.tech') {
        const project = { id: neon.projectId, org_id: neon.organizationId, name: 'Journey Neon project', region_id: 'aws-eu-central-1', pg_version: 17 };
        if (method === 'GET' && path === `/api/v2/projects/${neon.projectId}`) return ok({ project });
        const selectedBranchPath = `/api/v2/projects/${neon.projectId}/branches/${neon.branchId}`;
        if (method === 'GET' && path === selectedBranchPath) return ok({ branch: { id: neon.branchId,
          project_id: neon.projectId, name: 'main', current_state: 'ready', default: true, protected: false } });
        if (method === 'GET' && path === `${selectedBranchPath}/endpoints`) return ok({ endpoints: [{ id: neon.endpointId,
          project_id: neon.projectId, branch_id: neon.branchId, type: 'read_write', host: 'ep-journey.eu-central-1.aws.neon.tech' }] });
        if (method === 'GET' && path === `${selectedBranchPath}/databases`) return ok({ databases: [{ name: 'neondb', branch_id: neon.branchId }] });
        const branches = managedBranches.map(branch => ({ id: branch.neonId, project_id: neon.projectId,
          name: branch.name, current_state: 'ready', default: branch.name === 'production', protected: branch.name === 'production' }));
        if (method === 'GET' && path === `/api/v2/projects/${neon.projectId}/branches`) return ok({ branches });
        for (const branch of branches) {
          const base = `/api/v2/projects/${neon.projectId}/branches/${branch.id}`;
          if (method === 'GET' && path === base) return ok({ branch });
          if (method === 'GET' && path === `${base}/endpoints`) return ok({ endpoints: [{ id: `ep-${branch.name}`,
            project_id: neon.projectId, branch_id: branch.id, type: 'read_write', host: `ep-journey.${branch.name}.aws.neon.tech` }] });
          if (method === 'GET' && path === `${base}/databases`) return ok({ databases: [{ name: 'neondb', branch_id: branch.id }] });
        }
        if (method === 'GET' && path === `/api/v2/organizations/${neon.organizationId}`) return ok({ id: neon.organizationId, name: 'Journey organization', plan: 'launch' });
        if (method === 'GET' && path === '/api/v2/regions') return ok({ regions: [{ region_id: 'aws-eu-central-1', name: 'Frankfurt' }] });
        if (method === 'GET' && path === '/api/v2/projects') return ok({ projects: seedManagedProjects ? [project] : [] });
        if (method === 'POST' && path === '/api/v2/projects') return ok({
          project: { id: neon.projectId, org_id: neon.organizationId, name: 'Journey Neon project', region_id: 'aws-eu-central-1', pg_version: 17 },
          branch: { id: neon.branchId, project_id: neon.projectId, name: 'main', current_state: 'ready', default: true, protected: false },
          endpoints: [{ id: neon.endpointId, branch_id: neon.branchId, type: 'read_write' }], operations: [],
          connection_uris: ['ep-journey.neon.tech', 'ep-journey-pooler.neon.tech'].map(host => ({
            connection_uri: `postgresql://owner:journey-database-only-fixture@${host}/neondb`,
            connection_parameters: { database: 'neondb', role: 'owner', host: 'ep-journey.neon.tech', pooler_host: 'ep-journey-pooler.neon.tech' },
          })),
        }, 201);
      }
      if (url.hostname === 'api.eu-central-1.aws.neon.tech' && method === 'POST' && path === '/sql') {
        // The real Neon transport supplies a guarded read-only batch and native OID/text-array frame.
        const body = JSON.parse(request.body) as { queries?: Array<{ query: string; params?: unknown[] }> };
        if (body.queries?.[0]?.query !== postgresqlReadOnlyRoleGuardSql) throw new Error('Neon request omitted its read-role guard');
        return ok({ results: [{ command: 'DO', fields: [], rows: [], rowCount: null },
          { command: 'SELECT', fields: [{ name: 'marker', dataTypeID: 25 }],
            rows: [[body.queries[1]?.params?.[0]]], rowCount: 1 }] });
      }
      for (const branch of managedBranches) {
        if (url.hostname === `api.${branch.name}.aws.neon.tech` && method === 'POST' && path === '/sql') {
          // The external fixture models the official Neon batch request shape.
          const body = JSON.parse(request.body) as { queries?: Array<{ query: string }> };
          // Preserve P45's guard and official raw OID/text-array framing at HTTPS.
          if (body.queries?.[0]?.query !== postgresqlReadOnlyRoleGuardSql) throw new Error('Neon request omitted its read-role guard');
          if (rejectNextManagedQuery === 'neon') { rejectNextManagedQuery = undefined; return ok({ code: '42601', message: 'Fixture syntax error' }, 400); }
          if (body.queries?.[1]?.query.includes('FROM pg_catalog.pg_namespace')) {
            return ok({ results: [{ command: 'DO', fields: [], rows: [], rowCount: null },
              { command: 'SELECT', fields: [{ name: 'nspname', dataTypeID: 19 }],
                rows: [['public'], ['second']], rowCount: 2 }] });
          }
          const empty = body.queries?.[1]?.query.includes('WHERE false');
          return ok({ results: [{ command: 'DO', fields: [], rows: [], rowCount: null },
            { command: 'SELECT', fields: [{ name: 'marker', dataTypeID: 25 }, { name: 'duplicate', dataTypeID: 25 },
              { name: 'duplicate', dataTypeID: 20 }, { name: 'absent', dataTypeID: 25 }, { name: 'empty_text', dataTypeID: 25 }],
            rows: empty ? [] : [[branch.marker, 'typed-text', '9007199254740993', null, '']], rowCount: empty ? 0 : 1 }] });
        }
      }
      if (url.hostname === 'api.supabase.com') {
        if (method === 'GET' && path === '/v1/organizations') return ok([{ slug: supabase.organizationSlug, name: 'Journey organization' }]);
        const project = (ref: string, name: string) => ({ ref, organization_slug: supabase.organizationSlug,
          name, status: 'ACTIVE_HEALTHY', database: { version: '17' } });
        if (method === 'GET' && path === '/v1/projects') return ok(seedManagedProjects
          ? [project(supabase.projectRef, 'Journey')] : []);
        if (method === 'GET' && path === `/v1/projects/${supabase.projectRef}`) return ok(project(supabase.projectRef, 'Journey'));
        if (method === 'GET' && path === `/v1/projects/${supabase.projectRef}/branches`) return ok(managedBranches.map(branch => ({
          id: `branch-${branch.name}`, project_ref: branch.supabaseRef, parent_project_ref: supabase.projectRef,
          name: branch.name, persistent: branch.name === 'production', preview_project_status: 'ACTIVE_HEALTHY' })));
        for (const branch of managedBranches) {
          if (method === 'GET' && path === `/v1/projects/${branch.supabaseRef}`) return ok(project(branch.supabaseRef, branch.name));
          if (method === 'GET' && path === `/v1/branches/${branch.supabaseRef}` && managedSupabaseAddress) {
            const { hostname, port } = managedSupabaseAddress();
            return ok({ ref: branch.supabaseRef, db_host: hostname, db_port: Number(port) });
          }
          if (method === 'POST' && path === `/v1/projects/${branch.supabaseRef}/database/query/read-only`) {
            // The external fixture models the Management API query body.
            const body = JSON.parse(request.body) as { query: string; parameters?: unknown[] };
            const selectsDatabase = body.query === 'SELECT current_database() AS database';
            if (!selectsDatabase && rejectNextManagedQuery === 'supabase') {
              rejectNextManagedQuery = undefined;
              return ok({ message: 'Fixture throttled' }, 429);
            }
            if (!Array.isArray(body.parameters)) throw new Error('Supabase query omitted the positional parameter array');
            const rows = await readManagedSupabase?.({ branchRef: branch.supabaseRef, sql: body.query, parameters: body.parameters });
            if (rows !== undefined) return ok(rows);
            if (selectsDatabase) return ok([{ database: 'postgres' }]);
            if (body.query.includes('FROM pg_catalog.pg_namespace')) return ok([{ nspname: 'public' }, { nspname: 'second' }]);
            if (body.query.includes('FROM pg_catalog.pg_class')) {
              return ok([{ relkind: 'r', size_bytes: '30', relname: 'dbw_managed_sentinel', estimated_rows: '1',
                relation_bytes: '10', table_bytes: '20', index_bytes: '10' }]);
            }
            return ok(body.query.includes('WHERE false') ? [] : [{ marker: branch.marker, absent: null, empty_text: '' }]);
          }
        }
      }
      throw new Error(`Unexpected provider HTTP: ${method} ${url.hostname}${path}`);
    },
  });
  let dispatcher: InstanceType<typeof undici.ProxyAgent>;
  try { dispatcher = new undici.ProxyAgent({ uri: proxy.url, requestTls: { ca: await readFile(proxy.caCertPath) } }); }
  catch (error) { await proxy.stop(); throw error; }
  providerDispatcher = dispatcher;
  return { vercel, cloudflare, neon, supabase, managedBranches, entries: proxy.entries,
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      // UI and native Account hosts share the same third-party HTTPS vectors.
      return await undici.fetch(String(input), init as Parameters<typeof undici.fetch>[1]) as unknown as Response;
    },
    env: { HAPPIER_E2E_DEPLOYMENT_PROVIDER_PROXY: proxy.url, HAPPIER_E2E_DEPLOYMENT_PROVIDER_CA: proxy.caCertPath,
      HAPPIER_E2E_DEPLOYMENT_PROVIDER_HOSTS: JSON.stringify([...providerHosts]),
      HTTPS_PROXY: proxy.url, https_proxy: proxy.url, HTTP_PROXY: proxy.url,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', NODE_EXTRA_CA_CERTS: proxy.caCertPath },
    isAbsent(provider: 'vercel' | 'cloudflare') { return provider === 'vercel' ? vercelDeleted : cloudflareDeleted; },
    rejectNextVercelDeployment() { rejectNextVercelDeployment = true; },
    rejectNextCloudflareDeployment() { rejectNextCloudflareDeployment = true; },
    rejectNextManagedQuery(provider: 'neon' | 'supabase') { rejectNextManagedQuery = provider; },
    async stop() {
      providerDispatcher = undefined;
      try { await dispatcher.close(); } finally { await proxy.stop(); }
    },
  };
}

export type DeploymentProvidersHttp = Awaited<ReturnType<typeof startDeploymentProvidersHttp>>;
