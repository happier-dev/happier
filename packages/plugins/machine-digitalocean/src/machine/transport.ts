import * as z from 'zod/mini';
import { projectMachineProvisionerActionFailure, type MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

const origin = 'https://api.digitalocean.com';
const base = `${origin}/v2`;
// REST v2 official shared/responses/{bad_request,unauthorized,forbidden,
// not_found,conflict,unprocessable_entity,too_many_requests,server_error}.yml,
// https://github.com/digitalocean/openapi/tree/main/specification/shared/responses
// verified 2026-10-25. Never project vendor messages, request ids or unknown ids.
const nativeErrorCodeSchema = z.enum(['bad_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'unprocessable_entity', 'too_many_requests', 'server_error']);
type HttpNativeCause = Extract<MachineProvisionerNativeCauseV1, { httpStatusClass: string }>;
async function readNativeCause(reply: Response): Promise<HttpNativeCause> {
  const httpStatusClass = reply.status >= 300 && reply.status < 400 ? '3xx' : reply.status >= 400 && reply.status < 500 ? '4xx'
    : reply.status >= 500 && reply.status < 600 ? '5xx' : 'other';
  let body: unknown;
  try { body = await reply.json(); } catch { return { httpStatusClass }; }
  const parsed = z.object({ id: nativeErrorCodeSchema }).safeParse(body);
  return { httpStatusClass, ...(parsed.success ? { code: parsed.data.id } : {}) };
}
type NativeFailureReason = 'authorization' | 'transport' | 'native-error' | 'invalid-response' | 'invalid-pagination' | 'resource-mismatch' | 'cleanup-unconfirmed';
export type Unavailable = Readonly<{ kind: 'unavailable'; reason: NativeFailureReason; status?: number; nativeCause?: HttpNativeCause }>;
type HttpResult = Readonly<{ kind: 'response'; status: number; body: unknown }> | Unavailable;
const pageLinksSchema = z.optional(z.object({ pages: z.optional(z.object({ next: z.optional(z.string()) })) }));
export type DigitalOceanTransportOptions = Readonly<{ token: string; fetch?: typeof fetch; signal?: AbortSignal }>;

export function createDigitalOceanTransport(options: DigitalOceanTransportOptions) {
  const network = options.fetch ?? fetch;
  async function request(path: string, method = 'GET', body?: unknown, acceptNotFound = false): Promise<HttpResult> {
    try {
      const reply = await network(`${base}${path}`, {
        method, headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: options.signal, redirect: 'error',
      });
      if (!reply.ok && !(reply.status === 404 && acceptNotFound)) return { kind: 'unavailable', reason: reply.status === 401 || reply.status === 403 ? 'authorization' : 'native-error',
        status: reply.status, nativeCause: await readNativeCause(reply) };
      if (reply.status === 204 || reply.status === 404) return { kind: 'response', status: reply.status, body: null };
      try { return { kind: 'response', status: reply.status, body: await reply.json() as unknown }; }
      catch { return { kind: 'unavailable', reason: 'invalid-response', status: reply.status }; }
    } catch (error) {
      const transportFailure = (): HttpResult => ({ kind: 'unavailable', reason: 'transport' });
      return projectMachineProvisionerActionFailure(error, transportFailure);
    }
  }
  async function collection<T>(path: string, key: string, schema: z.ZodMiniType<T>): Promise<{ kind: 'available'; values: T[] } | Unavailable> {
    const values: T[] = [];
    const pageSchema = z.object({ values: z.array(schema), links: pageLinksSchema });
    const firstPage = new URL(`${base}${path}`);
    // REST v2's documented maximum, not a result limit: follow every next link.
    // https://github.com/digitalocean/openapi/blob/main/specification/shared/parameters.yml
    // Verified 2026-10-26: default 20, maximum 200 items per page.
    firstPage.searchParams.set('per_page', '200');
    let next: string | undefined = firstPage.href;
    while (next) {
      let url: URL;
      try { url = new URL(next); } catch { return { kind: 'unavailable', reason: 'invalid-pagination' }; }
      if (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== new URL(`${base}${path}`).pathname) return { kind: 'unavailable', reason: 'invalid-pagination' };
      const result = await request(url.pathname.slice('/v2'.length) + url.search);
      if (result.kind === 'unavailable') return result;
      if (!result.body || typeof result.body !== 'object') return { kind: 'unavailable', reason: 'invalid-response' };
      const body = result.body as Record<string, unknown>;
      const page = pageSchema.safeParse({ values: body[key], links: body.links });
      if (!page.success) return { kind: 'unavailable', reason: 'invalid-response' };
      values.push(...page.data.values);
      next = page.data.links?.pages?.next;
    }
    return { kind: 'available', values };
  }
  async function recoverTaggedDroplet<T extends { id: number; tags: string[] }>(recoveryTag: string, schema: z.ZodMiniType<T>) {
    const result = await collection('/droplets?tag_name=' + encodeURIComponent(recoveryTag), 'droplets', schema);
    if (result.kind !== 'available') return result;
    // REST v2 droplets_list excludes GPUs and forbids combining type with tag_name.
    const gpu = await collection('/droplets?type=gpus', 'droplets', schema);
    if (gpu.kind !== 'available') return gpu;
    const matches = [...new Map([...result.values, ...gpu.values].filter(droplet => droplet.tags.includes(recoveryTag)).map(droplet => [droplet.id, droplet])).values()];
    if (matches.length !== 1) return { kind: 'unknown' as const, reason: matches.length > 1 ? 'ambiguous' as const : 'not-found' as const };
    return { kind: 'bound' as const, droplet: matches[0]! };
  }
  return { request, collection, recoverTaggedDroplet };
}
