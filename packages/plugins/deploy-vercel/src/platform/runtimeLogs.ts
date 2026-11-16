import { withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetLogsResultV1ProtocolSchema as output,
  PluginError, isPluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext, PluginActionDeclaration, PluginActionDefinition, PluginActionReadObserver } from '@happier-dev/plugin-sdk/actions';
import { vercelEndpoint } from './operations.js';

type RuntimeLogEntry = Readonly<{ timestampInMs: number; rowId: string; level: string; message: string;
  messageTruncated: boolean; source: string; domain: string; requestMethod: string; requestPath: string; responseStatusCode: number }>;

async function openRuntimePages(raw: JsonValue, context: PluginAccountActionContext): Promise<AsyncGenerator<ReturnType<typeof output.parse>>> {
    const input = raw as unknown as ReturnType<typeof inputs['logs.runtime']['parse']>;
    const fail = (code: string): never => {
      const error = new PluginError({ code, retryable: false, details: { phase: 'runtime' } });
      throw code === 'deployment_unavailable' ? withActionFailureDiagnostic(error, { phase: 'deployment.vercel.logs.runtime', causeKind: 'not_found' }) : error;
    };
    if (!context.services.http) return fail('client_required');
    if (!input.providerDeploymentId) return fail('deployment_content_unavailable');
    const sourceRevision = input.providerDeploymentId;
    if (input.cursor) return (async function* (): AsyncGenerator<ReturnType<typeof output.parse>> {
      if (input.cursor!.sourceRevision !== sourceRevision) yield { kind: 'source-changed', sourceRevision };
      else yield { kind: 'unavailable', reason: 'unsupported' };
    })();
    context.signal.throwIfAborted();
    // Official CLI c628be7 util/logs.ts:162–193 requests this NDJSON representation.
    const url = new URL(vercelEndpoint(`/v1/projects/${encodeURIComponent(input.providerIdentity.providerResourceId)}/deployments/${encodeURIComponent(sourceRevision)}/runtime-logs`, input.providerIdentity.providerAccountId));
    url.searchParams.set('format', 'lines');
    const response = await context.services.http.requestStream({
      url: url.href,
      method: 'GET', redirect: 'error', headers: { accept: 'application/stream+json' },
      credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy.manage', origin: 'https://api.vercel.com', method: 'GET', headerNames: ['authorization'] },
    }, { signal: context.signal });
    if (response.status < 200 || response.status >= 300) {
      await response.dispose();
      return fail(response.status === 401 || response.status === 403
        ? 'deployment_access_denied' : response.status === 404 ? 'deployment_unavailable'
          : response.status === 410 ? 'expired_resource' : response.status === 400 ? 'invalid_parameters' : 'provider_request_failed');
    }
    return (async function* () { try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let pending = '';
      const parse = (line: string): RuntimeLogEntry => {
        let value: unknown;
        try { value = JSON.parse(line); } catch { return fail('provider_response_invalid'); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('provider_response_invalid');
        const row = value as Record<string, unknown>;
        if (typeof row.timestampInMs !== 'number' || !Number.isFinite(row.timestampInMs)
          || typeof row.rowId !== 'string' || typeof row.level !== 'string'
          || !['debug', 'error', 'fatal', 'info', 'trace', 'warning'].includes(row.level)
          || typeof row.message !== 'string' || typeof row.messageTruncated !== 'boolean'
          || typeof row.domain !== 'string' || typeof row.source !== 'string'
          || !['delimiter', 'edge-function', 'edge-middleware', 'request', 'serverless'].includes(row.source)
          || typeof row.requestMethod !== 'string' || typeof row.requestPath !== 'string'
          || typeof row.responseStatusCode !== 'number' || !Number.isFinite(row.responseStatusCode)) return fail('provider_response_invalid');
        return { timestampInMs: row.timestampInMs, rowId: row.rowId, level: row.level, message: row.message,
          messageTruncated: row.messageTruncated, domain: row.domain, source: row.source,
          requestMethod: row.requestMethod, requestPath: row.requestPath, responseStatusCode: row.responseStatusCode };
      };
      const deliver = (line: string) => {
        context.signal.throwIfAborted();
        // A provider frame is a finite partial page, never a historical window.
        const row = parse(line);
        // Vercel closes its live window (5 minutes) with a `delimiter` control row: the end of this stream, not a log.
        if (row.source === 'delimiter') return null;
        return { kind: 'page' as const, page: { sourceRevision, rowId: row.rowId,
          text: `${JSON.stringify(row)}\n`, nextCursor: null, truncated: true } };
      };
      for await (const bytes of response.chunks) {
        context.signal.throwIfAborted();
        try { pending += decoder.decode(bytes, { stream: true }); } catch { return fail('provider_response_invalid'); }
        let boundary: number;
        while ((boundary = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, boundary).trim();
          pending = pending.slice(boundary + 1);
          if (!line) continue;
          const page = deliver(line);
          if (!page) return;
          yield page;
        }
      }
      try { pending += decoder.decode(); } catch { return fail('provider_response_invalid'); }
      const last = pending.trim() ? deliver(pending.trim()) : null;
      if (last) yield last;
      context.signal.throwIfAborted();
    } finally { await response.dispose(); } })();
}

/** Vercel OpenAPI getRuntimeLogs, application/stream+json (2026-11-12). */
export const runtimeLogsAction: PluginActionDefinition<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>> = {
  title: 'Read the selected Vercel runtime logs',
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
  hostAccess: ['vercel-api', 'deploy.manage'], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }],
  dangerLevel: 'safe', readOnly: true, inputSchema: inputs['logs.runtime'].jsonSchema, resultSchema: output.jsonSchema,
  // Vercel keeps no runtime-log history: this endpoint is a live tail only. A one-shot read answers at once
  // and names Follow (observeRead) instead of holding the request open for Vercel's 5-minute window.
  async run(): Promise<ReturnType<typeof output.parse>> {
    return { kind: 'unavailable', reason: 'follow_only' };
  },
  observeRead: (async (raw, observation, context) => {
    if (!observation.emit) throw new PluginError({ code: 'plugin_action_read_observation_unavailable' });
    const emit = observation.emit;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([context.signal, lifetime.signal]);
    const pages = await openRuntimePages(raw, { ...context, signal });
    const delivery = (async () => {
      try {
        for await (const page of pages) { signal.throwIfAborted(); await emit(page); }
        // EOF promises neither replay nor history completeness. Keep admitted partial pages.
        if (!signal.aborted) observation.retire(new PluginError({ code: 'service_unavailable' }));
      } catch (error) {
        if (!signal.aborted) observation.retire(isPluginError(error) ? error : new PluginError({ code: 'provider_request_failed' }));
      }
    })();
    return { async dispose() { lifetime.abort(); await delivery; } };
  }) satisfies PluginActionReadObserver<JsonValue, PluginAccountActionContext>,
} as const;
