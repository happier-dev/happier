import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer, type Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createOutboundFetch, createOutboundIdentityFetch, type OutboundIdentityFetch } from "@/app/net/outboundIdentityFetch";
import {
    OutboundIdentityEndpointError,
    type OutboundAddressPolicy,
    type OutboundIdentityNetworkPolicy,
} from "@/app/net/outboundIdentityNetworkPolicy";

import { createEphemeralTlsServerFixture } from "../../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs";

type ObservedRequest = Readonly<{ path: string; servername: TLSSocket["servername"] | undefined }>;

type IssuerFixture = Readonly<{
    port: number;
    ca: Buffer;
    observed: ObservedRequest[];
    setHandler: (handler: RequestListener) => void;
}>;

function policy(
    address: OutboundAddressPolicy,
    overrides: Partial<OutboundIdentityNetworkPolicy> = {},
): OutboundIdentityNetworkPolicy {
    return {
        address,
        allowedPorts: "any",
        allowLoopbackHttp: false,
        maxResponseBytes: 1024 * 1024,
        maxHeaderBytes: 32 * 1024,
        timeoutMs: 5_000,
        ...overrides,
    };
}

const LOOPBACK_ALLOWLIST: OutboundAddressPolicy = {
    kind: "privateAllowlist",
    hostnames: ["issuer.invalid", "wrong.invalid", "other.invalid"],
    cidrs: ["127.0.0.0/8", "::1/128"],
};

/** `Promise.withResolvers` is outside this package's compiler `lib`. */
function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => { resolve = settle; });
    return { promise, resolve };
}

/** Resolver stub: DNS is a genuine system boundary; everything below it stays real. */
function resolverReturning(...answers: string[]) {
    return async () => answers;
}

async function withIssuer(
    run: (issuer: IssuerFixture) => Promise<void>,
    input: Readonly<{ secure?: boolean }> = {},
): Promise<void> {
    const secure = input.secure !== false;
    const tls = await createEphemeralTlsServerFixture({ additionalDnsNames: ["issuer.invalid", "other.invalid"] });
    const observed: ObservedRequest[] = [];
    let handler: RequestListener = (_request, response) => response.end("{}");
    const record: RequestListener = (request, response) => {
        observed.push({ path: request.url ?? "", servername: (request.socket as TLSSocket).servername });
        handler(request, response);
    };
    const server: Server = secure
        ? createHttpsServer({
            key: await readFile(tls.privateKeyPath),
            cert: await readFile(tls.leafCertificatePath),
        }, record)
        : createHttpServer(record);
    try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test listener");
        await run({
            port: address.port,
            ca: await readFile(tls.caCertificatePath),
            observed,
            setHandler: (next) => { handler = next; },
        });
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await tls.cleanup();
    }
}

async function withFetch(
    outbound: OutboundIdentityFetch,
    run: (outbound: OutboundIdentityFetch) => Promise<void>,
): Promise<void> {
    try {
        await run(outbound);
    } finally {
        await outbound.close();
    }
}

async function denial(
    outbound: OutboundIdentityFetch,
    url: string,
    signal?: AbortSignal,
): Promise<OutboundIdentityEndpointError> {
    const error = await outbound.fetch(url, { signal }).then(
        () => null,
        (caught: unknown) => caught,
    );
    expect(error, `expected ${url} to be denied`).toBeInstanceOf(OutboundIdentityEndpointError);
    return error as OutboundIdentityEndpointError;
}

describe("outbound identity endpoint policy: shared/cloud denials", () => {
    it("lets public-data consumers reuse peer-pinned transport without identity-specific body or deadline bounds", async () => {
        await withIssuer(async (issuer) => {
            const body = "x".repeat(1024 * 1024 + 1);
            issuer.setHandler((_request, response) => response.end(body));
            await withFetch(createOutboundFetch({
                policy: { address: LOOPBACK_ALLOWLIST, allowedPorts: [issuer.port], allowLoopbackHttp: false },
                resolveAddresses: resolverReturning("127.0.0.1"),
                tlsOptions: { ca: issuer.ca },
            }), async (outbound) => {
                expect(await (await outbound.fetch(`https://issuer.invalid:${issuer.port}/catalog`)).text()).toBe(body);
                expect((await denial(outbound, `https://issuer.invalid:${issuer.port}/catalog#fragment`)).code).toBe("outbound_url_fragment_forbidden");
            });
        });
    });

    it("rejects every non-public resolved address class", async () => {
        const cases: ReadonlyArray<readonly [string, string]> = [
            ["loopback", "127.0.0.1"],
            ["unspecified", "0.0.0.0"],
            ["rfc1918", "10.0.0.5"],
            ["rfc1918-172", "172.20.1.1"],
            ["rfc1918-192", "192.168.1.1"],
            ["carrier-grade nat", "100.64.0.1"],
            ["link-local", "169.254.10.1"],
            ["aws-style metadata", "169.254.169.254"],
            ["azure wireserver inside public unicast", "168.63.129.16"],
            ["oracle metadata", "192.0.0.192"],
            ["alibaba metadata", "100.100.100.200"],
            ["documentation", "203.0.113.5"],
            ["benchmark", "198.18.0.1"],
            ["multicast", "224.0.0.1"],
            ["reserved", "255.255.255.255"],
            ["ipv6 loopback", "::1"],
            ["ipv6 uncompressed loopback", "0:0:0:0:0:0:0:1"],
            ["ipv6 unspecified", "::"],
            ["ipv6 link-local", "fe80::1"],
            ["ipv6 unique local", "fd00::1"],
            ["ipv6 site-local", "fec0::1"],
            ["ipv6 multicast", "ff02::1"],
            ["ipv6 documentation", "2001:db8::1"],
            ["ipv4-mapped dotted", "::ffff:10.0.0.5"],
            ["ipv4-mapped hexadecimal", "::ffff:a00:5"],
            ["ipv4-compatible legacy", "::10.0.0.5"],
            ["nat64", "64:ff9b::10.0.0.5"],
            ["6to4", "2002:a00:5::1"],
        ];

        for (const [label, answer] of cases) {
            await withFetch(
                createOutboundIdentityFetch({ policy: policy({ kind: "publicOnly" }), resolveAddresses: resolverReturning(answer) }),
                async (outbound) => {
                    const error = await denial(outbound, "https://issuer.invalid/.well-known/openid-configuration");
                    expect(error.code, label).toBe("outbound_address_forbidden");
                    expect(error.endpoint).toBe("https://issuer.invalid/.well-known/openid-configuration");
                },
            );
        }
    });

    it("rejects a mixed answer set rather than picking the safe answer", async () => {
        await withFetch(
            createOutboundIdentityFetch({
                policy: policy({ kind: "publicOnly" }),
                resolveAddresses: resolverReturning("93.184.216.34", "10.0.0.5"),
            }),
            async (outbound) => {
                expect((await denial(outbound, "https://issuer.invalid/jwks")).code).toBe("outbound_address_forbidden");
            },
        );
    });

    it("rejects an empty and an unresolvable answer set", async () => {
        await withFetch(
            createOutboundIdentityFetch({ policy: policy({ kind: "publicOnly" }), resolveAddresses: resolverReturning() }),
            async (outbound) => {
                expect((await denial(outbound, "https://issuer.invalid/jwks")).code).toBe("outbound_dns_unresolved");
            },
        );
        await withFetch(
            createOutboundIdentityFetch({
                policy: policy({ kind: "publicOnly" }),
                resolveAddresses: async () => { throw new Error("NXDOMAIN"); },
            }),
            async (outbound) => {
                expect((await denial(outbound, "https://issuer.invalid/jwks")).code).toBe("outbound_dns_unresolved");
            },
        );
    });

    it("rejects private and legacy-encoded address literals without consulting DNS", async () => {
        let resolverCalls = 0;
        await withFetch(
            createOutboundIdentityFetch({
                policy: policy({ kind: "publicOnly" }),
                resolveAddresses: async () => { resolverCalls += 1; return ["93.184.216.34"]; },
            }),
            async (outbound) => {
                // WHATWG URL canonicalizes octal, hexadecimal, and integer IPv4 forms.
                for (const host of ["127.0.0.1", "0177.0.0.1", "2130706433", "[::ffff:127.0.0.1]", "[::1]"]) {
                    expect((await denial(outbound, `https://${host}/jwks`)).code).toBe("outbound_address_forbidden");
                }
                expect(resolverCalls).toBe(0);
            },
        );
    });

    it("rejects unsupported schemes, url credentials, fragments, and disallowed ports", async () => {
        await withFetch(
            createOutboundIdentityFetch({
                policy: policy({ kind: "publicOnly" }, { allowedPorts: [443] }),
                resolveAddresses: resolverReturning("93.184.216.34"),
            }),
            async (outbound) => {
                expect((await denial(outbound, "http://issuer.invalid/jwks")).code).toBe("outbound_scheme_forbidden");
                expect((await denial(outbound, "file:///etc/passwd")).code).toBe("outbound_scheme_forbidden");
                expect((await denial(outbound, "https://user:secret@issuer.invalid/jwks")).code)
                    .toBe("outbound_url_credentials_forbidden");
                expect((await denial(outbound, "https://issuer.invalid/jwks#frag")).code)
                    .toBe("outbound_url_fragment_forbidden");
                expect((await denial(outbound, "https://issuer.invalid:8443/jwks")).code).toBe("outbound_port_forbidden");
            },
        );
    });

    it("never leaks credentials, query values, or resolved addresses in the typed error", async () => {
        await withFetch(
            createOutboundIdentityFetch({ policy: policy({ kind: "publicOnly" }), resolveAddresses: resolverReturning("10.11.12.13") }),
            async (outbound) => {
                const error = await denial(outbound, "https://issuer.invalid/token?access_token=super-secret");
                expect(error.endpoint).toBe("https://issuer.invalid/token");
                expect(`${error.message}${error.reason ?? ""}`).not.toContain("super-secret");
                expect(`${error.message}${error.reason ?? ""}`).not.toContain("10.11.12.13");
            },
        );
    });
});

describe("outbound identity endpoint policy: connected peer binding", () => {
    it("connects to the validated address and preserves the original hostname for TLS", async () => {
        await withIssuer(async ({ port, ca, observed }) => {
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy(LOOPBACK_ALLOWLIST),
                    resolveAddresses: resolverReturning("127.0.0.1"),
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    const response = await outbound.fetch(`https://issuer.invalid:${port}/jwks`);
                    expect(await response.text()).toBe("{}");
                    expect(observed).toEqual([{ path: "/jwks", servername: "issuer.invalid" }]);

                    // Certificate hostname verification still applies to the original hostname.
                    const error = await denial(outbound, `https://wrong.invalid:${port}/jwks`);
                    expect(error.code).toBe("outbound_transport_failed");
                    expect(error.reason).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
                    expect(observed).toHaveLength(1);
                },
            );
        });
    });

    it("uses the pinned address instead of re-resolving the hostname at connect time", async () => {
        await withIssuer(async ({ port, ca, observed }) => {
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy(LOOPBACK_ALLOWLIST),
                    // Inside the allowlist, but nothing is listening there: proof the socket
                    // targets the validated literal rather than a fresh hostname lookup.
                    resolveAddresses: resolverReturning("::1"),
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    expect((await denial(outbound, `https://issuer.invalid:${port}/jwks`)).code)
                        .toBe("outbound_transport_failed");
                    expect(observed).toEqual([]);
                },
            );
        });
    });

    it("re-validates every request so a rebinding answer cannot reuse an approved host", async () => {
        await withIssuer(async ({ port, ca, observed }) => {
            let answer = "127.0.0.1";
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy(LOOPBACK_ALLOWLIST),
                    resolveAddresses: async () => [answer],
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    expect((await outbound.fetch(`https://issuer.invalid:${port}/first`)).status).toBe(200);
                    answer = "10.0.0.5";
                    expect((await denial(outbound, `https://issuer.invalid:${port}/second`)).code)
                        .toBe("outbound_address_forbidden");
                    expect(observed.map((entry) => entry.path)).toEqual(["/first"]);
                },
            );
        });
    });

    it("binds each request to its own validated answer instead of reusing an earlier peer", async () => {
        await withIssuer(async ({ port, ca, observed }) => {
            let answer = "127.0.0.1";
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy(LOOPBACK_ALLOWLIST),
                    resolveAddresses: async () => [answer],
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    expect((await outbound.fetch(`https://issuer.invalid:${port}/first`)).status).toBe(200);
                    // Both answers satisfy the Home CIDR. The second request must still
                    // connect to its newly validated answer, where no server is listening,
                    // rather than reuse the first request's pooled socket.
                    answer = "::1";
                    expect((await denial(outbound, `https://issuer.invalid:${port}/second`)).code)
                        .toBe("outbound_transport_failed");
                    expect(observed.map((entry) => entry.path)).toEqual(["/first"]);
                },
            );
        });
    });

    it("does not share dial authorization or cancellation between concurrent same-host requests", async () => {
        await withIssuer(async ({ port, ca, observed }) => {
            let resolverCall = 0;
            const firstResolved = deferred();
            const secondResolved = deferred();
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy(LOOPBACK_ALLOWLIST),
                    resolveAddresses: async () => {
                        resolverCall += 1;
                        if (resolverCall === 1) {
                            await firstResolved.promise;
                            return ["127.0.0.1"];
                        }
                        secondResolved.resolve();
                        return ["::1"];
                    },
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    const firstController = new AbortController();
                    const first = outbound.fetch(`https://issuer.invalid:${port}/first`, {
                        signal: firstController.signal,
                    });
                    // The refused peer can settle before the first TLS connection. Handle
                    // that genuine boundary rejection immediately, then inspect it below.
                    const second = outbound.fetch(`https://issuer.invalid:${port}/second`).catch((error: unknown) => error);
                    await secondResolved.promise;
                    firstResolved.resolve();

                    await expect(first).resolves.toMatchObject({ status: 200 });
                    expect(await second).toMatchObject({ code: "outbound_transport_failed" });
                    expect(observed.map((entry) => entry.path)).toEqual(["/first"]);
                },
            );
        });
    });
});

describe("outbound identity endpoint policy: response handling", () => {
    it("rejects a redirect instead of following it, including to a private target", async () => {
        await withIssuer(async ({ port, ca, observed, setHandler }) => {
            setHandler((_request, response) => {
                response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
            });
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy(LOOPBACK_ALLOWLIST),
                    resolveAddresses: resolverReturning("127.0.0.1"),
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    expect((await denial(outbound, `https://issuer.invalid:${port}/.well-known/openid-configuration`)).code)
                        .toBe("outbound_unexpected_redirect");
                    expect(observed.map((entry) => entry.path)).toEqual(["/.well-known/openid-configuration"]);
                },
            );
        });
    });

    it("bounds the decoded response body before it can be parsed", async () => {
        await withIssuer(async ({ port, ca, setHandler }) => {
            setHandler((_request, response) => {
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ padding: "x".repeat(4096) }));
            });
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy(LOOPBACK_ALLOWLIST, { maxResponseBytes: 512 }),
                    resolveAddresses: resolverReturning("127.0.0.1"),
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    expect((await denial(outbound, `https://issuer.invalid:${port}/jwks`)).code)
                        .toBe("outbound_response_too_large");
                },
            );
        });
    });

    it("applies the body bound after content decoding", async () => {
        await withIssuer(async ({ port, ca, setHandler }) => {
            setHandler((_request, response) => {
                response.writeHead(200, {
                    "content-type": "application/json",
                    "content-encoding": "gzip",
                });
                response.end(gzipSync(JSON.stringify({ padding: "x".repeat(4096) })));
            });
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy(LOOPBACK_ALLOWLIST, { maxResponseBytes: 512 }),
                    resolveAddresses: resolverReturning("127.0.0.1"),
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    expect((await denial(outbound, `https://issuer.invalid:${port}/jwks`)).code)
                        .toBe("outbound_response_too_large");
                },
            );
        });
    });

    it("bounds response headers before exposing a response", async () => {
        await withIssuer(async ({ port, ca, setHandler }) => {
            setHandler((_request, response) => {
                response.writeHead(200, { "x-padding": "x".repeat(4096) }).end("{}");
            });
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy(LOOPBACK_ALLOWLIST, { maxHeaderBytes: 512 }),
                    resolveAddresses: resolverReturning("127.0.0.1"),
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    expect((await denial(outbound, `https://issuer.invalid:${port}/jwks`)).code)
                        .toBe("outbound_response_too_large");
                },
            );
        });
    });

    it("times out a stalled body and honours caller cancellation", async () => {
        await withIssuer(async ({ port, ca, setHandler }) => {
            setHandler((_request, response) => {
                response.writeHead(200, { "content-type": "application/json" });
                response.write("{");
            });
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy(LOOPBACK_ALLOWLIST, { timeoutMs: 200 }),
                    resolveAddresses: resolverReturning("127.0.0.1"),
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    const timedOut = await outbound.fetch(`https://issuer.invalid:${port}/slow`)
                        .then((response) => response.text())
                        .catch((error: unknown) => error);
                    expect(timedOut).toBeInstanceOf(OutboundIdentityEndpointError);
                    expect((timedOut as OutboundIdentityEndpointError).code).toBe("outbound_timeout");
                },
            );

            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy(LOOPBACK_ALLOWLIST, { timeoutMs: 30_000 }),
                    resolveAddresses: resolverReturning("127.0.0.1"),
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    const controller = new AbortController();
                    const pending = outbound.fetch(`https://issuer.invalid:${port}/slow`, { signal: controller.signal })
                        .then((response) => response.text())
                        .catch((error: unknown) => error);
                    controller.abort();
                    const canceled = await pending;
                    expect(canceled).toBeInstanceOf(OutboundIdentityEndpointError);
                    expect((canceled as OutboundIdentityEndpointError).code).toBe("outbound_canceled");
                },
            );
        });
    });

    it("applies timeout and caller cancellation while DNS resolution is pending", async () => {
        const neverResolves = async () => new Promise<readonly string[]>(() => {});
        await withFetch(
            createOutboundIdentityFetch({
                policy: policy({ kind: "publicOnly" }, { timeoutMs: 25 }),
                resolveAddresses: neverResolves,
            }),
            async (outbound) => {
                expect((await denial(outbound, "https://issuer.invalid/jwks")).code).toBe("outbound_timeout");
            },
        );

        await withFetch(
            createOutboundIdentityFetch({
                policy: policy({ kind: "publicOnly" }, { timeoutMs: 30_000 }),
                resolveAddresses: neverResolves,
            }),
            async (outbound) => {
                const controller = new AbortController();
                const pending = outbound.fetch("https://issuer.invalid/jwks", { signal: controller.signal })
                    .catch((error: unknown) => error);
                controller.abort(new Error("caller-secret-reason"));
                const canceled = await pending;
                expect(canceled).toBeInstanceOf(OutboundIdentityEndpointError);
                expect((canceled as OutboundIdentityEndpointError).code).toBe("outbound_canceled");
                expect((canceled as OutboundIdentityEndpointError).message).not.toContain("caller-secret-reason");
            },
        );
    });
});

describe("outbound identity endpoint policy: self-hosted and deployment modes", () => {
    it("allows exactly the Home-configured hostnames, CIDRs, and ports", async () => {
        await withIssuer(async ({ port, ca, observed }) => {
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy(
                        { kind: "privateAllowlist", hostnames: ["issuer.invalid"], cidrs: ["127.0.0.0/8"] },
                        { allowedPorts: [port] },
                    ),
                    resolveAddresses: resolverReturning("127.0.0.1"),
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    expect((await outbound.fetch(`https://issuer.invalid:${port}/jwks`)).status).toBe(200);
                    // A hostname the Home administrator did not list, even inside the CIDR.
                    expect((await denial(outbound, `https://other.invalid:${port}/jwks`)).code)
                        .toBe("outbound_host_forbidden");
                    expect((await denial(outbound, `https://issuer.invalid:${port + 1}/jwks`)).code)
                        .toBe("outbound_port_forbidden");
                    expect(observed).toHaveLength(1);
                },
            );
        });

        await withFetch(
            createOutboundIdentityFetch({
                policy: policy({ kind: "privateAllowlist", hostnames: ["issuer.invalid"], cidrs: ["10.20.0.0/20"] }),
                resolveAddresses: resolverReturning("10.20.16.1"),
            }),
            async (outbound) => {
                expect((await denial(outbound, "https://issuer.invalid/jwks")).code).toBe("outbound_address_forbidden");
            },
        );

        await withFetch(
            createOutboundIdentityFetch({
                policy: policy({ kind: "privateAllowlist", hostnames: ["issuer.invalid"], cidrs: [] }),
                resolveAddresses: resolverReturning("10.20.0.1"),
            }),
            async (outbound) => {
                expect((await denial(outbound, "https://issuer.invalid/jwks")).code).toBe("outbound_address_forbidden");
            },
        );

        await withFetch(
            createOutboundIdentityFetch({
                policy: policy({
                    kind: "privateAllowlist",
                    hostnames: ["issuer.invalid"],
                    cidrs: ["10.20.0.0/20", "not-a-cidr"],
                }),
                resolveAddresses: resolverReturning("10.20.0.1"),
            }),
            async (outbound) => {
                expect((await denial(outbound, "https://issuer.invalid/jwks")).code).toBe("outbound_address_forbidden");
            },
        );
    });

    it("keeps released deployment-configured private issuers reachable", async () => {
        await withIssuer(async ({ port, ca, observed }) => {
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy({ kind: "deploymentConfigured" }),
                    resolveAddresses: resolverReturning("127.0.0.1"),
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    expect((await outbound.fetch(`https://issuer.invalid:${port}/jwks`)).status).toBe(200);
                    expect(observed).toEqual([{ path: "/jwks", servername: "issuer.invalid" }]);
                },
            );
        });
    });

    it("tries each policy-approved address when the first address cannot connect", async () => {
        await withIssuer(async ({ port, ca, observed }) => {
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy({ kind: "deploymentConfigured" }),
                    resolveAddresses: resolverReturning("::1", "127.0.0.1"),
                    tlsOptions: { ca },
                }),
                async (outbound) => {
                    expect((await outbound.fetch(`https://issuer.invalid:${port}/jwks`)).status).toBe(200);
                    expect(observed).toEqual([{ path: "/jwks", servername: "issuer.invalid" }]);
                },
            );
        });
    });

    it("does not dial another approved address after caller cancellation", async () => {
        let firstConnections = 0;
        let secondConnections = 0;
        const acceptedSockets = new Set<Socket>();
        const controller = new AbortController();
        const first = createTcpServer((socket) => {
            firstConnections += 1;
            acceptedSockets.add(socket);
            socket.on("close", () => acceptedSockets.delete(socket));
            controller.abort();
            socket.on("error", () => undefined);
        });
        first.listen(0, "::1");
        await once(first, "listening");
        const address = first.address();
        if (!address || typeof address === "string") throw new Error("Missing first test listener");
        const second = createTcpServer((socket) => {
            secondConnections += 1;
            acceptedSockets.add(socket);
            socket.on("close", () => acceptedSockets.delete(socket));
            socket.on("error", () => undefined);
        });
        second.listen(address.port, "127.0.0.1");
        await once(second, "listening");

        try {
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy({ kind: "deploymentConfigured" }),
                    resolveAddresses: resolverReturning("::1", "127.0.0.1"),
                    tlsOptions: { timeout: 60 },
                }),
                async (outbound) => {
                    expect((await denial(outbound, `https://issuer.invalid:${address.port}/jwks`, controller.signal)).code)
                        .toBe("outbound_canceled");
                    await new Promise((resolve) => setTimeout(resolve, 1_500));
                    expect(firstConnections).toBe(1);
                    expect(secondConnections).toBe(0);
                },
            );
        } finally {
            for (const socket of acceptedSockets) socket.destroy();
            await Promise.all([
                new Promise<void>((resolve) => first.close(() => resolve())),
                new Promise<void>((resolve) => second.close(() => resolve())),
            ]);
        }
    });

    it("allows plaintext http only for loopback under explicit development authority", async () => {
        await withIssuer(async ({ port, observed }) => {
            await withFetch(
                createOutboundIdentityFetch({
                    policy: policy({ kind: "deploymentConfigured" }, { allowLoopbackHttp: true }),
                    resolveAddresses: async (hostname) => (hostname === "idp.localhost" ? ["93.184.216.34"] : ["127.0.0.1"]),
                }),
                async (outbound) => {
                    expect((await outbound.fetch(`http://127.0.0.1:${port}/jwks`)).status).toBe(200);
                    expect((await outbound.fetch(`http://localhost.:${port}/jwks`)).status).toBe(200);
                    expect(observed.map((entry) => entry.path)).toEqual(["/jwks", "/jwks"]);
                    // Non-loopback hostnames never get plaintext, even with the flag on.
                    expect((await denial(outbound, "http://issuer.invalid/jwks")).code).toBe("outbound_scheme_forbidden");
                    // A loopback-looking hostname that resolves elsewhere is rejected on the answer.
                    expect((await denial(outbound, "http://idp.localhost/jwks")).code).toBe("outbound_address_forbidden");
                },
            );
        }, { secure: false });
    });

    it("denies plaintext http when development authority is not granted", async () => {
        await withFetch(
            createOutboundIdentityFetch({
                policy: policy({ kind: "deploymentConfigured" }),
                resolveAddresses: resolverReturning("127.0.0.1"),
            }),
            async (outbound) => {
                expect((await denial(outbound, "http://127.0.0.1:8080/jwks")).code).toBe("outbound_scheme_forbidden");
            },
        );
    });
});
