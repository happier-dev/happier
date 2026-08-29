import { connect as netConnect, type Socket } from "node:net";

import Fastify, { type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    chargePluginWebhookWorkingBytesV1,
    createPluginWebhookProcessAdmissionV1,
    type PluginWebhookDistributedScopeV1,
} from "@/app/plugins/webhooks/admission";
import { registerPluginWebhookIngressRoute } from "./registerPluginWebhookIngressRoute";

const ENABLED_ENV = {
    HAPPIER_FEATURE_PLUGINS__ENABLED: "1",
    HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1",
} as NodeJS.ProcessEnv;
const TEST_PROCESS_WORKING_BYTES = chargePluginWebhookWorkingBytesV1(1_024);

describe("public plugin webhook ingress route", () => {
    const apps: Array<ReturnType<typeof Fastify>> = [];

    afterEach(async () => {
        vi.useRealTimers();
        await Promise.all(apps.splice(0).map(async (app) => await app.close()));
    });

    async function createApp(
        options: Parameters<typeof registerPluginWebhookIngressRoute>[1],
        configure?: (app: ReturnType<typeof Fastify>) => void,
    ) {
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        registerPluginWebhookIngressRoute(app as never, options);
        configure?.(app);
        await app.ready();
        apps.push(app);
        return app;
    }

    it("returns an empty 202 only after the durable ingest owner reports admission", async () => {
        const ingest = vi.fn(async () => ({ kind: "accepted" as const, deliveryId: "delivery-1", duplicate: false }));
        const onCommittedWake = vi.fn();
        const app = await createApp({
            env: ENABLED_ENV,
            ingest,
            onCommittedWake,
            processAdmission: createPluginWebhookProcessAdmissionV1({ maxRequests: 2, maxWorkingBytes: TEST_PROCESS_WORKING_BYTES }),
            prepareRoute: vi.fn(async () => ({
                route: {
                    routeId: "route-1",
                    verifierKind: "github_hmac_sha256_v1" as const,
                    routingKind: "providerInstallation" as const,
                    policyVersion: 1 as const,
                },
            })),
            distributedAdmission: { acquire: vi.fn(async () => ({ ok: true as const, release: vi.fn(async () => {}) })) },
        });

        const body = Buffer.from('{"installation":{"id":1}}', "utf8");
        const response = await app.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-1",
            headers: {
                "content-type": "application/json",
                "x-hub-signature-256": "sha256=" + "a".repeat(64),
                "x-github-delivery": "delivery-guid-1",
            },
            payload: body,
        });

        expect(ingest).toHaveBeenCalledTimes(1);
        expect(response.statusCode).toBe(202);
        expect(response.body).toBe("");
        expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
            opaqueRouteId: "opaque-1",
            rawBody: expect.any(Uint8Array),
            onCommittedWake,
            deadlineAtMs: expect.any(Number),
        }));
    });

    it("keeps Fastify's live payload as an async byte stream until the ingress owner captures it", async () => {
        let sawRawStream = false;
        const app = await createApp({
            env: ENABLED_ENV,
            ingest: vi.fn(async () => ({ kind: "accepted" as const, deliveryId: "delivery-stream", duplicate: false })),
            processAdmission: createPluginWebhookProcessAdmissionV1({ maxRequests: 2, maxWorkingBytes: TEST_PROCESS_WORKING_BYTES }),
            prepareRoute: vi.fn(async () => ({
                route: {
                    routeId: "route-stream",
                    verifierKind: "github_hmac_sha256_v1" as const,
                    routingKind: "providerInstallation" as const,
                    policyVersion: 1 as const,
                },
            })),
            distributedAdmission: { acquire: vi.fn(async () => ({ ok: true as const, release: vi.fn(async () => {}) })) },
        }, (app) => {
            app.addHook("preHandler", async (request: FastifyRequest) => {
                if (!request.url.startsWith("/v1/plugins/webhooks/")) return;
                const body = request.body as unknown as { [Symbol.asyncIterator]?: unknown };
                expect(body).not.toBeInstanceOf(Uint8Array);
                expect(typeof body?.[Symbol.asyncIterator]).toBe("function");
                sawRawStream = true;
            });
        });

        await expect(app.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-stream",
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.from("{}"),
        })).resolves.toMatchObject({ statusCode: 202 });
        expect(sawRawStream).toBe(true);
    });

    it("reserves the declared raw-body bytes before route preparation or body parsing", async () => {
        const localRelease = vi.fn();
        const acquire = vi.fn(() => ({ release: localRelease }));
        const prepareRoute = vi.fn(async () => ({
            route: {
                routeId: "route-raw-body-bytes",
                verifierKind: "github_hmac_sha256_v1" as const,
                routingKind: "providerInstallation" as const,
                policyVersion: 1 as const,
            },
        }));
        const app = await createApp({
            env: ENABLED_ENV,
            ingest: vi.fn(async () => ({ kind: "accepted" as const, deliveryId: "delivery-raw-body-bytes", duplicate: false })),
            processAdmission: { acquire },
            prepareRoute,
            distributedAdmission: { acquire: vi.fn(async () => ({ ok: true as const, release: vi.fn(async () => {}) })) },
        });
        const body = Buffer.from("{}", "utf8");

        await expect(app.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-raw-body-bytes",
            headers: { "content-type": "application/json" },
            payload: body,
        })).resolves.toMatchObject({ statusCode: 202 });

        expect(acquire).toHaveBeenCalledWith(body.byteLength);
        expect(prepareRoute).toHaveBeenCalledTimes(1);
        expect(localRelease).toHaveBeenCalledTimes(1);
    });

    it("uses the one lower-only host ingress policy for process and distributed admission", async () => {
        const distributedAcquire = vi.fn(async () => ({ ok: true as const, release: vi.fn(async () => {}) }));
        const app = await createApp({
            env: {
                ...ENABLED_ENV,
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES: "1",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: "5",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: "2",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: "3",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: "1",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: "20",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: "4",
            },
            ingest: vi.fn(async () => ({ kind: "accepted" as const, deliveryId: "delivery-policy", duplicate: false })),
            prepareRoute: vi.fn(async () => ({
                route: {
                    routeId: "route-policy",
                    verifierKind: "github_hmac_sha256_v1" as const,
                    routingKind: "accountEndpoint" as const,
                    policyVersion: 1 as const,
                },
            })),
            distributedAdmission: { acquire: distributedAcquire },
        });

        const response = await app.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-policy",
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.from("{}"),
        });

        expect(response.statusCode).toBe(503);
        expect(distributedAcquire).not.toHaveBeenCalled();
    });

    it("charges tenant admission only at the first authenticated routing point", async () => {
        const distributedAcquire = vi.fn(async (
            _scopes: readonly PluginWebhookDistributedScopeV1[],
            _options: Readonly<{ nowMs: number; ttlMs: number; ownerToken: string }>,
        ) => ({ ok: true as const, release: vi.fn(async () => {}) }));
        const endpoint = {
            endpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            revision: 1,
            accountId: "account-policy-distributed",
            pluginId: "acme.github",
            webhookContributionId: "github-events",
            handlerActionId: "handle-webhook",
            sourceInstanceId: "source-policy-distributed",
            routingKind: "accountEndpoint" as const,
            providerInstallationId: null,
            targetMaterialization: { machineId: "machine-1", materializationId: "materialization-1", pluginId: "acme.github" },
            targetMachineInstallationId: "installation-1",
            targetPluginVersion: "1.0.0",
        };
        // Stands in for the verified ingest owner: it resolves the endpoint from
        // the authenticated request and only then reserves the tenant sublimits.
        const ingest = vi.fn(async (params: { reserveResolvedEndpoint?: (value: typeof endpoint) => Promise<unknown> }) => {
            await params.reserveResolvedEndpoint?.(endpoint);
            return { kind: "accepted" as const, deliveryId: "delivery-policy-distributed", duplicate: false };
        });
        const app = await createApp({
            env: {
                ...ENABLED_ENV,
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: "5",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: "2",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: "3",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: "1",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: "20",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: "4",
            },
            ingest: ingest as never,
            processAdmission: createPluginWebhookProcessAdmissionV1({ maxRequests: 1, maxWorkingBytes: TEST_PROCESS_WORKING_BYTES }),
            prepareRoute: vi.fn(async () => ({
                route: {
                    routeId: "route-policy-distributed",
                    verifierKind: "github_hmac_sha256_v1" as const,
                    routingKind: "accountEndpoint" as const,
                    policyVersion: 1 as const,
                },
            })),
            distributedAdmission: { acquire: distributedAcquire },
        });

        await expect(app.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-policy-distributed",
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.from("{}"),
        })).resolves.toMatchObject({ statusCode: 202 });

        // Anyone who learns the public URL can reach the unauthenticated hop, so
        // it charges the shared route only. The endpoint and Account budgets
        // belong to one tenant and are charged after the request authenticated.
        expect(distributedAcquire).toHaveBeenCalledTimes(2);
        expect(distributedAcquire.mock.calls[0]?.[0]).toEqual([
            expect.objectContaining({ ratePerMinute: 5, concurrency: 2 }),
        ]);
        expect(distributedAcquire.mock.calls[1]?.[0]).toEqual([
            expect.objectContaining({ ratePerMinute: 3, concurrency: 1 }),
            expect.objectContaining({ ratePerMinute: 20, concurrency: 4 }),
        ]);
        expect(distributedAcquire).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ ttlMs: 8_000 }));
    });

    it("shares the Account admission scope across distinct endpoints without collapsing endpoint pressure", async () => {
        const acquiredScopes: PluginWebhookDistributedScopeV1[][] = [];
        const releases: Array<ReturnType<typeof vi.fn>> = [];
        const distributedAcquire = vi.fn(async (scopes: readonly PluginWebhookDistributedScopeV1[]) => {
            acquiredScopes.push([...scopes]);
            const release = vi.fn(async () => {});
            releases.push(release);
            return { ok: true as const, release };
        });
        const endpointFor = (opaqueRouteId: string) => ({
            endpointId: opaqueRouteId.endsWith("one")
                ? "wh_ep_AAECAwQFBgcICQoLDA0ODw"
                : "wh_ep_EBESExQVFhcYGRobHB0eHw",
            revision: 1,
            accountId: "account-shared-budget",
            pluginId: "acme.github",
            webhookContributionId: "github-events",
            handlerActionId: "handle-webhook",
            sourceInstanceId: opaqueRouteId,
            routingKind: "accountEndpoint" as const,
            providerInstallationId: null,
            targetMaterialization: { machineId: "machine-1", materializationId: "materialization-1", pluginId: "acme.github" },
            targetMachineInstallationId: "installation-1",
            targetPluginVersion: "1.0.0",
        });
        const ingest = vi.fn(async (params: {
            opaqueRouteId: string;
            reserveResolvedEndpoint?: (value: ReturnType<typeof endpointFor>) => Promise<Readonly<{ release(): void | Promise<void> }> | null>;
        }) => {
            const lease = await params.reserveResolvedEndpoint?.(endpointFor(params.opaqueRouteId));
            await lease?.release();
            return { kind: "accepted" as const, deliveryId: params.opaqueRouteId, duplicate: false };
        });
        const app = await createApp({
            env: ENABLED_ENV,
            ingest: ingest as never,
            processAdmission: createPluginWebhookProcessAdmissionV1({ maxRequests: 2, maxWorkingBytes: TEST_PROCESS_WORKING_BYTES }),
            prepareRoute: vi.fn(async (opaqueRouteId) => ({
                route: {
                    routeId: `route-${opaqueRouteId}`,
                    verifierKind: "github_hmac_sha256_v1" as const,
                    routingKind: "accountEndpoint" as const,
                    policyVersion: 1 as const,
                },
            })),
            distributedAdmission: { acquire: distributedAcquire },
        });

        for (const suffix of ["one", "two"]) {
            await expect(app.inject({
                method: "POST",
                url: `/v1/plugins/webhooks/opaque-${suffix}`,
                headers: { "content-type": "application/octet-stream" },
                payload: Buffer.from("{}"),
            })).resolves.toMatchObject({ statusCode: 202 });
        }

        const routeScopes = acquiredScopes.filter((scopes) => scopes.length === 1);
        const tenantScopes = acquiredScopes.filter((scopes) => scopes.length === 2);
        expect(routeScopes).toHaveLength(2);
        expect(routeScopes[0]?.[0]?.key).not.toBe(routeScopes[1]?.[0]?.key);
        expect(tenantScopes).toHaveLength(2);
        expect(tenantScopes[0]?.[0]?.key).not.toBe(tenantScopes[1]?.[0]?.key);
        expect(tenantScopes[0]?.[1]?.key).toBe(tenantScopes[1]?.[1]?.key);
        expect(releases).toHaveLength(4);
        expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    });

    it("rejects an unverifiable request without ever charging the tenant it names", async () => {
        const distributedAcquire = vi.fn(async (
            _scopes: readonly PluginWebhookDistributedScopeV1[],
            _options: Readonly<{ nowMs: number; ttlMs: number; ownerToken: string }>,
        ) => ({ ok: true as const, release: vi.fn(async () => {}) }));
        // The verified ingest owner never resolves an endpoint for a request it
        // rejects, so it never reaches the tenant reservation seam.
        const ingest = vi.fn(async () => ({
            kind: "rejected" as const,
            statusCode: 401 as const,
            code: "unauthorized" as const,
        }));
        const app = await createApp({
            env: ENABLED_ENV,
            ingest,
            processAdmission: createPluginWebhookProcessAdmissionV1({ maxRequests: 1, maxWorkingBytes: TEST_PROCESS_WORKING_BYTES }),
            prepareRoute: vi.fn(async () => ({
                route: {
                    routeId: "route-unverified",
                    verifierKind: "github_hmac_sha256_v1" as const,
                    routingKind: "accountEndpoint" as const,
                    policyVersion: 1 as const,
                },
            })),
            distributedAdmission: { acquire: distributedAcquire },
        });

        await expect(app.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-unverified",
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.from("{}"),
        })).resolves.toMatchObject({ statusCode: 401 });

        expect(distributedAcquire).toHaveBeenCalledTimes(1);
        expect(distributedAcquire.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ key: expect.stringMatching(/^route:/u) })]);
    });

    it("applies route pressure per route so one exhausted route never consumes an unrelated route's budget", async () => {
        // A stateful stand-in for the Redis admission owner: each scope key has
        // its own rate window of one request. A process-wide route budget — a
        // plausible wrong implementation — would refuse the second, unrelated
        // route exactly like the exhausted one.
        const acquisitionsByKey = new Map<string, number>();
        const distributedAdmission = {
            acquire: async (scopes: readonly PluginWebhookDistributedScopeV1[]) => {
                for (const scope of scopes) {
                    if ((acquisitionsByKey.get(scope.key) ?? 0) >= 1) {
                        return { ok: false as const, code: "rate" as const, retryAfterMs: 60_000 };
                    }
                }
                for (const scope of scopes) acquisitionsByKey.set(scope.key, (acquisitionsByKey.get(scope.key) ?? 0) + 1);
                return { ok: true as const, release: vi.fn(async () => {}) };
            },
        };
        const app = await createApp({
            env: {
                ...ENABLED_ENV,
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: "1",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: "1",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: "100",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: "10",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: "100",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: "10",
            },
            ingest: vi.fn(async () => ({ kind: "accepted" as const, deliveryId: "delivery-route-pressure", duplicate: false })),
            processAdmission: createPluginWebhookProcessAdmissionV1({ maxRequests: 4, maxWorkingBytes: chargePluginWebhookWorkingBytesV1(4_096) }),
            prepareRoute: vi.fn(async (opaqueRouteId: string) => ({
                route: {
                    routeId: `route-${opaqueRouteId}`,
                    verifierKind: "github_hmac_sha256_v1" as const,
                    routingKind: "providerInstallation" as const,
                    policyVersion: 1 as const,
                },
            })),
            distributedAdmission,
        });
        const post = (opaqueRouteId: string) => app.inject({
            method: "POST" as const,
            url: `/v1/plugins/webhooks/${opaqueRouteId}`,
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.from("{}"),
        });

        await expect(post("opaque-route-pressure-one")).resolves.toMatchObject({ statusCode: 202 });
        await expect(post("opaque-route-pressure-one")).resolves.toMatchObject({ statusCode: 429 });
        await expect(post("opaque-route-pressure-two")).resolves.toMatchObject({ statusCode: 202 });
    });

    it("maps authenticated tenant-admission refusal to its typed public response and releases the route reservation", async () => {
        // The route pre-authorizes only the shared route scope; the tenant
        // scopes are acquired at the verified routing point. When that
        // acquisition refuses, the public answer must keep the rate/concurrency
        // distinction and its Retry-After — a bare 503 would collapse the two
        // failure modes the policy owner distinguishes.
        const build = async (code: "rate" | "concurrency", retryAfterMs: number) => {
            const endpoint = {
                endpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                revision: 1,
                accountId: "account-tenant-refusal",
                pluginId: "acme.github",
                webhookContributionId: "github-events",
                handlerActionId: "handle-webhook",
                sourceInstanceId: "source-tenant-refusal",
                routingKind: "accountEndpoint" as const,
                providerInstallationId: null,
                targetMaterialization: { machineId: "machine-1", materializationId: "materialization-1", pluginId: "acme.github" },
                targetMachineInstallationId: "installation-1",
                targetPluginVersion: "1.0.0",
            };
            const localRelease = vi.fn();
            const distributedRelease = vi.fn(async () => {});
            const app = await createApp({
                env: ENABLED_ENV,
                // Stands in for the verified ingest owner: on reservation refusal
                // it reports the same typed unavailable rejection the real owner
                // returns, and the route owns the public refusal mapping.
                ingest: vi.fn(async (params: { reserveResolvedEndpoint?: (value: typeof endpoint) => Promise<unknown> }) => {
                    const lease = await params.reserveResolvedEndpoint?.(endpoint);
                    return lease
                        ? { kind: "accepted" as const, deliveryId: "delivery-tenant-refusal", duplicate: false }
                        : { kind: "rejected" as const, statusCode: 503 as const, code: "unavailable" as const };
                }),
                processAdmission: { acquire: vi.fn(() => ({ release: localRelease })) },
                prepareRoute: vi.fn(async () => ({
                    route: {
                        routeId: `route-tenant-refusal-${code}`,
                        verifierKind: "github_hmac_sha256_v1" as const,
                        routingKind: "accountEndpoint" as const,
                        policyVersion: 1 as const,
                    },
                })),
                distributedAdmission: {
                    acquire: vi.fn(async (scopes: readonly PluginWebhookDistributedScopeV1[]) => (
                        scopes.length === 2
                            ? { ok: false as const, code, retryAfterMs }
                            : { ok: true as const, release: distributedRelease }
                    )),
                },
            });
            return { app, localRelease, distributedRelease };
        };

        const rate = await build("rate", 2_500);
        await expect(rate.app.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-tenant-refusal-rate",
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.from("{}"),
        })).resolves.toMatchObject({ statusCode: 429, headers: { "retry-after": "3" } });
        expect(rate.distributedRelease).toHaveBeenCalledTimes(1);
        expect(rate.localRelease).toHaveBeenCalledTimes(1);

        const concurrency = await build("concurrency", 8_000);
        await expect(concurrency.app.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-tenant-refusal-concurrency",
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.from("{}"),
        })).resolves.toMatchObject({ statusCode: 503, headers: { "retry-after": "8" } });
        expect(concurrency.distributedRelease).toHaveBeenCalledTimes(1);
        expect(concurrency.localRelease).toHaveBeenCalledTimes(1);
    });

    it("applies aggregate process pressure across routes and keeps admission until abandoned ingestion settles", async () => {
        vi.useFakeTimers();
        const localRelease = vi.fn();
        const distributedRelease = vi.fn(async () => {});
        let settleStalledIngest: ((result: { kind: "accepted"; deliveryId: string; duplicate: boolean }) => void) | undefined;
        const ingest = vi.fn()
            .mockImplementationOnce(async () => await new Promise((resolve) => {
                settleStalledIngest = resolve as typeof settleStalledIngest;
            }))
            .mockImplementation(async () => ({ kind: "accepted" as const, deliveryId: "delivery-after", duplicate: false }));
        // One real slot, so reclaiming capacity is observable rather than asserted.
        const processAdmission = createPluginWebhookProcessAdmissionV1({
            maxRequests: 1,
            maxWorkingBytes: TEST_PROCESS_WORKING_BYTES,
        });
        const app = await createApp({
            env: ENABLED_ENV,
            ingest: ingest as never,
            processAdmission: {
                acquire: (bytes: number) => {
                    const lease = processAdmission.acquire(bytes);
                    return lease ? { release: () => { localRelease(); lease.release(); } } : null;
                },
            },
            prepareRoute: vi.fn(async (opaqueRouteId) => ({
                route: {
                    routeId: `route-${opaqueRouteId}`,
                    verifierKind: "github_hmac_sha256_v1" as const,
                    routingKind: "providerInstallation" as const,
                    policyVersion: 1 as const,
                },
            })),
            distributedAdmission: { acquire: vi.fn(async () => ({ ok: true as const, release: distributedRelease })) },
        });
        const post = (opaqueRouteId: string) => app.inject({
            method: "POST",
            url: `/v1/plugins/webhooks/${opaqueRouteId}`,
            headers: { "content-type": "application/json" },
            payload: Buffer.from("{}", "utf8"),
        });

        const stalled = post("opaque-deadline");
        await vi.advanceTimersByTimeAsync(8_000);
        await expect(stalled).resolves.toMatchObject({ statusCode: 503 });

        // The abandoned ingestion still owns the raw body and its database work,
        // so its capacity is not available to anyone else yet.
        const contended = post("opaque-deadline-contended");
        await vi.advanceTimersByTimeAsync(1);
        await expect(contended).resolves.toMatchObject({ statusCode: 503 });
        expect(ingest).toHaveBeenCalledTimes(1);
        expect(localRelease).not.toHaveBeenCalled();
        expect(distributedRelease).not.toHaveBeenCalled();

        settleStalledIngest?.({ kind: "accepted", deliveryId: "delivery-stalled", duplicate: false });
        await vi.advanceTimersByTimeAsync(1);
        expect(localRelease).toHaveBeenCalledTimes(1);
        expect(distributedRelease).toHaveBeenCalledTimes(1);

        const reclaimed = post("opaque-deadline-reclaimed");
        await vi.advanceTimersByTimeAsync(1);
        await expect(reclaimed).resolves.toMatchObject({ statusCode: 202 });
        expect(ingest).toHaveBeenCalledTimes(2);
    });

    it("cancels stalled ingress work when Fastify reports that the client aborted", async () => {
        let routeOptions: any;
        let routeHandler: any;
        let registration: Promise<void> | null = null;
        const scoped = {
            removeContentTypeParser: vi.fn(),
            addContentTypeParser: vi.fn(),
            post: vi.fn((_path: string, options: unknown, handler: unknown) => {
                routeOptions = options;
                routeHandler = handler;
            }),
            route: vi.fn(),
        };
        const app = {
            register: vi.fn((callback: (instance: typeof scoped) => Promise<void>) => {
                registration = callback(scoped);
            }),
        };
        const localRelease = vi.fn();
        const distributedRelease = vi.fn(async () => {});
        registerPluginWebhookIngressRoute(app as never, {
            env: ENABLED_ENV,
            ingest: vi.fn(),
            processAdmission: { acquire: vi.fn(() => ({ release: localRelease })) },
            prepareRoute: vi.fn(async () => ({
                route: {
                    routeId: "route-client-abort",
                    verifierKind: "github_hmac_sha256_v1" as const,
                    routingKind: "providerInstallation" as const,
                    policyVersion: 1 as const,
                },
            })),
            distributedAdmission: { acquire: vi.fn(async () => ({ ok: true as const, release: distributedRelease })) },
        });
        await registration;

        let resolveNext!: (value: IteratorResult<Uint8Array>) => void;
        const request = {
            query: {},
            headers: { "content-length": "1", "content-type": "application/octet-stream" },
            params: { opaqueRouteId: "opaque-client-abort" },
            raw: { complete: false, destroy: vi.fn() },
            body: {
                [Symbol.asyncIterator]() {
                    return {
                        next: () => new Promise<IteratorResult<Uint8Array>>((resolve) => { resolveNext = resolve; }),
                        return: async () => ({ done: true, value: undefined }),
                    };
                },
            },
        };
        const reply: any = {
            sent: false,
            header: vi.fn(() => reply),
            code: vi.fn(() => reply),
            send: vi.fn(() => {
                reply.sent = true;
                return reply;
            }),
        };

        await routeOptions.onRequest(request, reply);
        const handling = routeHandler(request, reply);
        await Promise.resolve();
        await routeOptions.onRequestAbort(request);

        await expect(Promise.race([
            handling,
            new Promise<Readonly<{ kind: "stillPending" }>>((resolve) => {
                setTimeout(() => resolve({ kind: "stillPending" }), 25);
            }),
        ])).resolves.toBe(reply);
        expect(reply.code).toHaveBeenCalledWith(503);
        expect(localRelease).toHaveBeenCalledTimes(1);
        expect(distributedRelease).toHaveBeenCalledTimes(1);

        resolveNext({ done: true, value: undefined });
        await handling;
    });

    it("cancels stalled route preparation when Fastify reports that the client aborted", async () => {
        let routeOptions: any;
        let registration: Promise<void> | null = null;
        const scoped = {
            removeContentTypeParser: vi.fn(),
            addContentTypeParser: vi.fn(),
            post: vi.fn((_path: string, options: unknown) => {
                routeOptions = options;
            }),
            route: vi.fn(),
        };
        const app = {
            register: vi.fn((callback: (instance: typeof scoped) => Promise<void>) => {
                registration = callback(scoped);
            }),
        };
        const localRelease = vi.fn();
        let resolvePreparation!: (value: null) => void;
        let markPreparationStarted!: () => void;
        const preparationStarted = new Promise<void>((resolve) => { markPreparationStarted = resolve; });
        registerPluginWebhookIngressRoute(app as never, {
            env: ENABLED_ENV,
            ingest: vi.fn(),
            processAdmission: { acquire: vi.fn(() => ({ release: localRelease })) },
            prepareRoute: vi.fn(async () => {
                markPreparationStarted();
                return await new Promise<null>((resolve) => { resolvePreparation = resolve; });
            }),
            distributedAdmission: null,
        });
        await registration;

        const request = {
            query: {},
            headers: { "content-length": "1", "content-type": "application/octet-stream" },
            params: { opaqueRouteId: "opaque-client-abort-during-prepare" },
            raw: { complete: false, destroy: vi.fn() },
        };
        const reply: any = {
            sent: false,
            header: vi.fn(() => reply),
            code: vi.fn(() => reply),
            send: vi.fn(() => {
                reply.sent = true;
                return reply;
            }),
        };
        const onRequest = routeOptions.onRequest(request, reply);

        try {
            await preparationStarted;
            await routeOptions.onRequestAbort(request);

            await expect(Promise.race([
                onRequest,
                new Promise<Readonly<{ kind: "stillPending" }>>((resolve) => {
                    setTimeout(() => resolve({ kind: "stillPending" }), 25);
                }),
            ])).resolves.toBe(reply);
            expect(reply.code).toHaveBeenCalledWith(503);
            expect(localRelease).toHaveBeenCalledTimes(1);
        } finally {
            resolvePreparation(null);
            await onRequest;
        }
    });

    it("cancels route preparation when the live Fastify request stream disconnects", async () => {
        const localRelease = vi.fn();
        let markPreparationStarted!: () => void;
        const preparationStarted = new Promise<void>((resolve) => { markPreparationStarted = resolve; });
        let resolvePreparation!: (value: null) => void;
        const app = await createApp({
            env: ENABLED_ENV,
            ingest: vi.fn(),
            processAdmission: { acquire: vi.fn(() => ({ release: localRelease })) },
            prepareRoute: vi.fn(async () => {
                markPreparationStarted();
                return await new Promise<null>((resolve) => { resolvePreparation = resolve; });
            }),
            distributedAdmission: null,
        });
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address();
        if (!address || typeof address === "string") {
            throw new Error("Failed to bind live webhook ingress test server");
        }

        const socket = await new Promise<Socket>((resolve, reject) => {
            const connected = netConnect({ host: "127.0.0.1", port: address.port });
            connected.once("error", reject);
            connected.once("connect", () => {
                connected.off("error", reject);
                connected.write([
                    "POST /v1/plugins/webhooks/opaque-live-client-abort HTTP/1.1",
                    "Host: 127.0.0.1",
                    "Content-Type: application/octet-stream",
                    "Content-Length: 1",
                    "",
                    "",
                ].join("\r\n"));
                resolve(connected);
            });
        });
        try {
            await preparationStarted;
            socket.destroy();

            await vi.waitFor(() => {
                expect(localRelease).toHaveBeenCalledTimes(1);
            }, { timeout: 1_000 });
        } finally {
            socket.destroy();
            resolvePreparation(null);
        }
    });

    it("bounds a stalled route-resolution request before body handling and releases its local reservation", async () => {
        vi.useFakeTimers();
        const localRelease = vi.fn();
        const ingest = vi.fn();
        const app = await createApp({
            env: ENABLED_ENV,
            ingest,
            processAdmission: { acquire: vi.fn(() => ({ release: localRelease })) },
            prepareRoute: vi.fn(async () => await new Promise<never>(() => {})),
            distributedAdmission: null,
        });

        const response = app.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-stalled-route",
            headers: { "content-type": "application/json" },
            payload: Buffer.from("{}", "utf8"),
        });
        await vi.advanceTimersByTimeAsync(8_000);

        await expect(response).resolves.toMatchObject({ statusCode: 503 });
        expect(localRelease).toHaveBeenCalledTimes(1);
        expect(ingest).not.toHaveBeenCalled();
    });

    it("releases a distributed reservation that resolves after the ingress deadline", async () => {
        vi.useFakeTimers();
        const localRelease = vi.fn();
        const lateDistributedRelease = vi.fn(async () => {});
        let resolveDistributed!: (value: Readonly<{ ok: true; release(): Promise<void> }>) => void;
        const app = await createApp({
            env: ENABLED_ENV,
            ingest: vi.fn(),
            processAdmission: { acquire: vi.fn(() => ({ release: localRelease })) },
            prepareRoute: vi.fn(async () => ({
                route: {
                    routeId: "route-late-distributed",
                    verifierKind: "github_hmac_sha256_v1" as const,
                    routingKind: "providerInstallation" as const,
                    policyVersion: 1 as const,
                },
            })),
            distributedAdmission: {
                acquire: vi.fn(() => new Promise<Readonly<{ ok: true; release(): Promise<void> }>>((resolve) => {
                    resolveDistributed = resolve;
                })),
            },
        });

        const response = app.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-late-distributed",
            headers: { "content-type": "application/json" },
            payload: Buffer.from("{}", "utf8"),
        });
        await vi.advanceTimersByTimeAsync(8_000);

        await expect(response).resolves.toMatchObject({ statusCode: 503 });
        expect(localRelease).toHaveBeenCalledTimes(1);
        resolveDistributed({ ok: true, release: lateDistributedRelease });
        await vi.advanceTimersByTimeAsync(0);
        expect(lateDistributedRelease).toHaveBeenCalledTimes(1);
    });

    it("fails closed before ingest when the gate or process raw-body reservation is unavailable", async () => {
        const disabledIngest = vi.fn();
        const disabled = await createApp({
            env: {},
            ingest: disabledIngest,
            processAdmission: createPluginWebhookProcessAdmissionV1({ maxRequests: 1, maxWorkingBytes: 1 }),
            prepareRoute: vi.fn(),
            distributedAdmission: null,
        });
        expect((await disabled.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-1",
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.from("{}"),
        })).statusCode).toBe(404);
        expect(disabledIngest).not.toHaveBeenCalled();

        const fullIngest = vi.fn();
        const full = await createApp({
            env: ENABLED_ENV,
            ingest: fullIngest,
            processAdmission: createPluginWebhookProcessAdmissionV1({ maxRequests: 1, maxWorkingBytes: 1 }),
            prepareRoute: vi.fn(),
            distributedAdmission: null,
        });
        const response = await full.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-1",
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.from("{}"),
        });
        expect(response.statusCode).toBe(503);
        expect(response.headers["retry-after"]).toBe("5");
        expect(fullIngest).not.toHaveBeenCalled();
    });

    it("fails closed on a full-server route when the distributed admission owner is unavailable", async () => {
        const ingest = vi.fn();
        const app = await createApp({
            env: { ...ENABLED_ENV, HAPPIER_SERVER_FLAVOR: "full" },
            ingest,
            processAdmission: createPluginWebhookProcessAdmissionV1({ maxRequests: 1, maxWorkingBytes: TEST_PROCESS_WORKING_BYTES }),
            prepareRoute: vi.fn(),
        });

        const response = await app.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-1",
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.from("{}"),
        });

        expect(response.statusCode).toBe(503);
        expect(response.headers["retry-after"]).toBe("5");
        expect(ingest).not.toHaveBeenCalled();
    });

    it("rejects transfer-encoded framing with the public unsupported-media response before ingest", async () => {
        const ingest = vi.fn();
        const app = await createApp({
            env: ENABLED_ENV,
            ingest,
            processAdmission: createPluginWebhookProcessAdmissionV1({ maxRequests: 1, maxWorkingBytes: TEST_PROCESS_WORKING_BYTES }),
            prepareRoute: vi.fn(),
            distributedAdmission: null,
        });

        const response = await app.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-transfer-encoding",
            headers: {
                "content-type": "application/octet-stream",
                "transfer-encoding": "chunked",
            },
            payload: Buffer.from("{}"),
        });

        expect(response.statusCode).toBe(415);
        expect(response.body).toBe("");
        expect(ingest).not.toHaveBeenCalled();
    });

    it("owns unsupported methods at the webhook route instead of falling through to the global 404", async () => {
        const ingest = vi.fn();
        const app = await createApp({
            env: ENABLED_ENV,
            ingest,
            processAdmission: createPluginWebhookProcessAdmissionV1({ maxRequests: 1, maxWorkingBytes: TEST_PROCESS_WORKING_BYTES }),
            prepareRoute: vi.fn(),
            distributedAdmission: null,
        });

        for (const method of ["GET", "PUT", "TRACE"] as const) {
            const response = await app.inject({
                // light-my-request's type union omits TRACE even though Fastify accepts and routes it.
                method: method === "TRACE" ? method as "GET" : method,
                url: "/v1/plugins/webhooks/opaque-unsupported-method",
            });
            expect(response.statusCode).toBe(405);
            expect(response.body).toBe("");
            expect(response.headers.allow).toBe("POST");
            expect(response.headers["cache-control"]).toBe("no-store");
        }
        expect(ingest).not.toHaveBeenCalled();
    });

    it("keeps unsupported methods non-disclosing while the webhook feature is disabled", async () => {
        const ingest = vi.fn();
        const app = await createApp({
            env: {},
            ingest,
            processAdmission: createPluginWebhookProcessAdmissionV1({ maxRequests: 1, maxWorkingBytes: TEST_PROCESS_WORKING_BYTES }),
            prepareRoute: vi.fn(),
            distributedAdmission: null,
        });

        const response = await app.inject({
            // light-my-request's type union omits TRACE even though Fastify accepts and routes it.
            method: "TRACE" as "GET",
            url: "/v1/plugins/webhooks/opaque-disabled-method",
        });

        expect(response.statusCode).toBe(404);
        expect(response.body).toBe("");
        expect(response.headers.allow).toBeUndefined();
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(ingest).not.toHaveBeenCalled();
    });

    it("maps public rejection to a bounded empty response and releases every reservation", async () => {
        const localRelease = vi.fn();
        const distributedRelease = vi.fn(async () => {});
        const app = await createApp({
            env: ENABLED_ENV,
            ingest: vi.fn(async () => ({ kind: "rejected" as const, statusCode: 401 as const, code: "unauthorized" as const })),
            processAdmission: { acquire: vi.fn(() => ({ release: localRelease })) },
            prepareRoute: vi.fn(async () => ({
                route: {
                    routeId: "route-1",
                    verifierKind: "github_hmac_sha256_v1" as const,
                    routingKind: "accountEndpoint" as const,
                    policyVersion: 1 as const,
                },
            })),
            distributedAdmission: { acquire: vi.fn(async () => ({ ok: true as const, release: distributedRelease })) },
        });
        const response = await app.inject({
            method: "POST",
            url: "/v1/plugins/webhooks/opaque-1",
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.from("{}"),
        });
        expect(response.statusCode).toBe(401);
        expect(response.body).toBe("");
        expect(localRelease).toHaveBeenCalledTimes(1);
        expect(distributedRelease).toHaveBeenCalledTimes(1);
    });

    it("distinguishes rate exhaustion from concurrency pressure at distributed admission", async () => {
        const base = {
            env: ENABLED_ENV,
            ingest: vi.fn(),
            processAdmission: createPluginWebhookProcessAdmissionV1({ maxRequests: 2, maxWorkingBytes: TEST_PROCESS_WORKING_BYTES }),
            prepareRoute: vi.fn(async () => ({
                route: {
                    routeId: "route-1",
                    verifierKind: "github_hmac_sha256_v1" as const,
                    routingKind: "providerInstallation" as const,
                    policyVersion: 1 as const,
                },
            })),
        };
        const rate = await createApp({
            ...base,
            distributedAdmission: {
                acquire: vi.fn(async () => ({ ok: false as const, code: "rate" as const, retryAfterMs: 2_500 })),
            },
        });
        const concurrency = await createApp({
            ...base,
            distributedAdmission: {
                acquire: vi.fn(async () => ({ ok: false as const, code: "concurrency" as const, retryAfterMs: 8_000 })),
            },
        });
        const request = {
            method: "POST" as const,
            url: "/v1/plugins/webhooks/opaque-1",
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.from("{}"),
        };

        expect((await rate.inject(request)).statusCode).toBe(429);
        expect((await concurrency.inject(request)).statusCode).toBe(503);
    });
});
