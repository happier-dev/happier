import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { CredentialRequestRedirectError, fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  InitializeResultSchema, JSONRPCNotificationSchema, JSONRPCRequestSchema, ProgressTokenSchema, RequestIdSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createConnectedAccountRequestAuthClient } from '@happier-dev/plugin-sdk/connected-accounts/request-auth';
import { canonicalMcpOAuthResourceUrlV1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthResourceV1';
import { z } from 'zod/mini';

import { withMcpTimeout } from '@/mcp/runtime/withMcpTimeout';
import { MCP_REQUEST_AUTH_PURPOSE } from '@/mcp/runtime/mcpRequestAuth';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { readCredentialRedactionValues } from '@/plugins/runtime/invocation/services/credentialRedactionValues';
import { RemoteMcpAuthenticationRequiredError } from './remoteMcpAuthenticationFailure';

const MCP_BRIDGE_STARTUP_STEP_TIMEOUT_MS = 60_000;

// Preserve only SDK-owned fields, literals and correlation facts. Dictionary
// keys and string payloads use the same credential lease as stderr; redacting
// the serialized message would corrupt syntax when a secret is "content".
function projectRedactedBridgeOutput(outputRedaction: ReturnType<typeof createProviderRedactionLease>, value: unknown, schema?: z.core.$ZodType): unknown {
  if (schema instanceof z.core.$ZodOptional || schema instanceof z.core.$ZodNullable || schema instanceof z.core.$ZodDefault) {
    return projectRedactedBridgeOutput(outputRedaction, value, schema._zod.def.innerType);
  }
  if (schema === RequestIdSchema || schema === ProgressTokenSchema
    || schema === InitializeResultSchema.shape.protocolVersion
    || schema === JSONRPCNotificationSchema.shape.method || schema === JSONRPCRequestSchema.shape.method
    || schema instanceof z.core.$ZodLiteral || schema instanceof z.core.$ZodEnum) return value;
  if (schema instanceof z.core.$ZodUnion) {
    const option = schema._zod.def.options.find(candidate => z.safeParse(candidate, value).success);
    return projectRedactedBridgeOutput(outputRedaction, value, option);
  }
  if (typeof value === 'string') return outputRedaction.redact(value);
  if (Array.isArray(value)) {
    const element = schema instanceof z.core.$ZodArray ? schema._zod.def.element : undefined;
    return value.map(item => projectRedactedBridgeOutput(outputRedaction, item, element));
  }
  if (value === null || typeof value !== 'object') return value;
  const fields = schema instanceof z.core.$ZodObject ? schema._zod.def.shape : undefined;
  const entrySchema = schema instanceof z.core.$ZodRecord ? schema._zod.def.valueType : undefined;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    fields && Object.hasOwn(fields, key) ? key : outputRedaction.redact(key),
    // Remote metadata is an arbitrary private dictionary, including any keys
    // whose spelling happens to match a protocol field.
    projectRedactedBridgeOutput(outputRedaction, entry, key === '_meta' ? undefined : fields?.[key] ?? entrySchema),
  ]));
}

export const RemoteBridgeConfigSchema = lazyZodSchema(() => z.object({
  transport: z.enum(['http', 'sse']),
  url: z.string().check(z.minLength(1)),
  headers: z._default(z.optional(z.record(z.string(), z.string())), {}),
  redactionValues: z._default(z.optional(z.array(z.string().check(z.minLength(1)))), []),
  auth: z.optional(z.strictObject({
    capabilityFile: z.string().check(z.minLength(1)), resource: z.url(),
  })),
}));

export type RemoteBridgeConfig = z.infer<typeof RemoteBridgeConfigSchema>;

class McpResourceMismatchError extends Error {
  readonly code = 'mcp_resource_mismatch';
  constructor() { super('mcp_resource_mismatch'); this.name = 'McpResourceMismatchError'; }
}

// Keep issued values protected through late responses and credential rotations.
export function createRemoteMcpOutputRedaction(config?: RemoteBridgeConfig) {
  const lease = createProviderRedactionLease({ values: [] });
  if (config) addRemoteMcpRedactionValues(lease, config);
  return {
    ...lease,
    project: (value: unknown, schema?: z.core.$ZodType) => projectRedactedBridgeOutput(lease, value, schema),
  };
}

export function addRemoteMcpRedactionValues(lease: ReturnType<typeof createProviderRedactionLease>, config: RemoteBridgeConfig): void {
  lease.add(config.redactionValues.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]));
  lease.add(Object.values(config.headers).flatMap(value =>
    readCredentialRedactionValues({ rawCredential: value, authorizationValue: value })
      .flatMap((credential: string) => [credential, JSON.stringify(credential).slice(1, -1)]),
  ));
}

export async function connectRemoteMcpClient(
  config: RemoteBridgeConfig,
  outputRedaction: ReturnType<typeof createRemoteMcpOutputRedaction>,
  signal?: AbortSignal,
): Promise<Client> {
  const client = new Client({ name: 'happier-remote-bridge', version: '1.0.0' }, { capabilities: {} });

  const url = new URL(config.url);
  const headers = { ...config.headers };
  // Configured headers can contain materialized Saved Secrets under arbitrary names.
  const configuredPrivateHeaderNames = new Set(new Headers(headers).keys());
  if (config.auth && canonicalMcpOAuthResourceUrlV1(config.auth.resource) !== canonicalMcpOAuthResourceUrlV1(config.url)) throw new McpResourceMismatchError();
  const requestAuth = config.auth ? await createConnectedAccountRequestAuthClient({ capabilityFile: config.auth.capabilityFile }) : null;
  const fetchRemoteRequest: FetchLike = requestAuth && config.auth ? async (target, init) => {
    const destination = canonicalMcpOAuthResourceUrlV1(String(target));
    const resource = canonicalMcpOAuthResourceUrlV1(config.auth!.resource);
    // SSE advertises a same-origin POST endpoint after the initial connection.
    // The capability remains bound to the exact initial resource above; this
    // transport path does not select a different grant or bearer audience.
    if (config.transport === 'sse'
      ? new URL(destination).origin !== url.origin
      : destination !== resource) throw new McpResourceMismatchError();
    const signal = init?.signal ?? undefined;
    const lookup = async () => {
      try {
        const lease = await requestAuth.lookupConnectedAccountRequestAuth({ purpose: MCP_REQUEST_AUTH_PURPOSE, signal });
        // The lease carries the complete declared request-auth headers (the
        // Authorization bearer included); redact each credential and its JSON form.
        const credentials = Object.entries(lease.headers).flatMap(([name, value]) => readCredentialRedactionValues(
          name.toLowerCase() === 'authorization' ? { authorizationValue: value } : { rawCredential: value }));
        outputRedaction.add(credentials.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]));
        return lease;
      }
      catch (error) { if (signal?.aborted) throw error; throw new Error('Sign in to this MCP server in Happier.'); }
    };
    const send = async (lease: Awaited<ReturnType<typeof lookup>>) => {
      const requestHeaders = new Headers(init?.headers);
      const privateHeaderNames = new Set(configuredPrivateHeaderNames);
      for (const [name, value] of Object.entries(lease.headers)) {
        requestHeaders.set(name, value);
        privateHeaderNames.add(name.toLowerCase());
      }
      return await fetchWithCredentialRedirectRefusal(target, { ...init, headers: requestHeaders }, undefined, privateHeaderNames);
    };
    let lease = await lookup();
    let response = await send(lease);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      await requestAuth.reportConnectedAccountAuthFailure({ credentialContext: lease.credentialContext, signal,
        normalizedFailure: { class: 'authentication', evidence: { limitCategory: 'auth_invalid', quotaScope: 'account',
          httpStatus: 401, evidenceSource: { kind: 'structured' } } } });
      lease = await lookup();
      response = await send(lease);
    }
    if (response.status === 403) {
      const challenge = extractWWWAuthenticateParams(response);
      if (challenge.error === 'insufficient_scope') {
        await response.body?.cancel().catch(() => undefined);
        await requestAuth.reportConnectedAccountAuthFailure({ credentialContext: lease.credentialContext, signal,
          normalizedFailure: { class: 'insufficient_scope', requiredScopes: (challenge.scope ?? '').split(/\s+/u).filter(Boolean),
            evidence: { limitCategory: 'validation_failed', quotaScope: 'account', httpStatus: 403, evidenceSource: { kind: 'structured' } } } });
        throw new Error('This MCP server needs more access. Open Happier to grant it.');
      }
    }
    return response;
  } : (target, init) => fetchWithCredentialRedirectRefusal(target, init, undefined, configuredPrivateHeaderNames);
  // EventSource converts fetch failures into SseError. Keep the closed refusal
  // at this transport boundary so startup cleanup preserves its public code.
  let redirectRefusal: CredentialRequestRedirectError | undefined;
  let authenticationRequired: RemoteMcpAuthenticationRequiredError | undefined;
  let connected = false;
  const fetchRemote: FetchLike = async (target, init) => {
    if (config.transport === 'sse' && redirectRefusal) throw redirectRefusal;
    try {
      const response = await fetchRemoteRequest(target, init);
      if (response.status === 401 && /^Bearer(?:\s|$)/iu.test(response.headers.get('WWW-Authenticate')?.trim() ?? '')) {
        await response.body?.cancel().catch(() => undefined);
        authenticationRequired = new RemoteMcpAuthenticationRequiredError();
        throw authenticationRequired;
      }
      return response;
    }
    catch (error) {
      if (error instanceof CredentialRequestRedirectError) {
        redirectRefusal = error;
        // Startup's catch closes its failed transport. A later SSE reconnect
        // has no connect waiter, so stop its EventSource at this boundary.
        if (connected && config.transport === 'sse') void transport.close().catch(() => {});
      }
      throw error;
    }
  };

  const transport =
    config.transport === 'http'
      ? new StreamableHTTPClientTransport(url, { requestInit: { headers }, ...(fetchRemote ? { fetch: fetchRemote } : {}) })
      : new SSEClientTransport(url, {
        requestInit: { headers },
        ...(fetchRemote ? { fetch: fetchRemote, eventSourceInit: { fetch: fetchRemote } } : {}),
      });

  try {
    await withMcpTimeout(client.connect(transport, signal ? { signal } : undefined), {
      timeoutMs: MCP_BRIDGE_STARTUP_STEP_TIMEOUT_MS,
      label: 'happier_mcp_bridge_connect_timeout',
    });
    connected = true;
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw redirectRefusal ?? authenticationRequired ?? error;
  }
}
