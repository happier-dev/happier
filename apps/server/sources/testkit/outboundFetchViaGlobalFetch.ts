import type * as OutboundIdentityFetchModule from "@/app/net/outboundIdentityFetch";

/**
 * Module replacement for `@/app/net/outboundIdentityFetch` in route/flow specs whose subject is
 * the sign-in or connect flow, not the transport. Those specs fake the network with
 * `vi.stubGlobal("fetch", ...)`; this hands every outbound request to that stub.
 *
 *     vi.mock("@/app/net/outboundIdentityFetch", () => import("@/testkit/outboundFetchViaGlobalFetch"));
 *
 * Scheme/address/peer/redirect/size policy is not exercised here; it is proven at the owner
 * (`outboundIdentityFetch.spec.ts`) and per consumer (`github.outbound.spec.ts`,
 * `githubConnect.avatar.integration.spec.ts`) against real sockets.
 */
type SparseResponse = Partial<Pick<Response, "ok" | "status" | "json" | "text" | "arrayBuffer">>;

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/**
 * The real owner always returns a buffered `Response`; stubs written as sparse `{ ok, json }`
 * doubles are normalized to one here so consumers see the owner's output contract.
 */
async function asBufferedResponse(value: Response | SparseResponse): Promise<Response> {
    if (value instanceof Response) return value;
    const status = value.status ?? (value.ok === false ? 500 : 200);
    if (NULL_BODY_STATUSES.has(status)) return new Response(null, { status });
    const body = value.arrayBuffer
        ? await value.arrayBuffer()
        : value.text
            ? await value.text()
            : value.json
                ? JSON.stringify(await value.json())
                : null;
    return new Response(body, { status });
}

const viaGlobalFetch: OutboundIdentityFetchModule.OutboundIdentityFetch = Object.freeze({
    fetch: async (input: string | URL, init?: RequestInit) => asBufferedResponse(await globalThis.fetch(input, init)),
    close: async () => undefined,
});

export const createOutboundIdentityFetch: typeof OutboundIdentityFetchModule.createOutboundIdentityFetch = () => viaGlobalFetch;
export const createOutboundFetch: typeof OutboundIdentityFetchModule.createOutboundFetch = () => viaGlobalFetch;
