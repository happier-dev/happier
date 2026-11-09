import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Capture gate for the OS rename boundary the continuity writer uses for its
 * atomic temp+rename commit. It is passthrough by default; the durability
 * ordering test arms it so rename landing order is controlled by the test
 * instead of by the filesystem. Releasing a captured write still performs the
 * real rename — the OS filesystem is the genuine boundary here and the real
 * continuity writer logic stays in the path.
 */
const renameGate = vi.hoisted(() => ({
    capture: false,
    captures: [] as Array<{ landed: boolean; complete: () => Promise<void> }>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
        ...actual,
        rename(from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) {
            if (!renameGate.capture || !String(to).endsWith("home.descriptor.json")) {
                return actual.rename(from, to);
            }
            return new Promise<void>((resolve, reject) => {
                const entry = {
                    landed: false,
                    complete: (): Promise<void> => {
                        if (entry.landed) return Promise.resolve();
                        entry.landed = true;
                        return actual.rename(from, to).then(resolve, reject);
                    },
                };
                renameGate.captures.push(entry);
            });
        },
    };
});

import type { HomeIrohEndpointState } from "@/app/iroh/homeIrohEndpoint";
import { projectHomeReachability } from "@/app/home/reachability/homeReachability";

import {
    composeHomeConnectionDescriptor,
    readCommittedHomeConnectionDescriptor,
    readHomeConnectionDescriptor,
    readRequiredAuthenticatedHomeConnectionDescriptor,
    readPreparedHomeCredentialDestination,
    resolvePublishedHomeConnectionDescriptor,
    resetHomeConnectionDescriptorRevisionOwnerForTests,
    type HomeDescriptorPublicationFacts,
} from "./homeConnectionDescriptorPublication";
import {
    createFileHomeConnectionDescriptorContinuityStore,
    createHomeConnectionDescriptorContentKey,
    createSimpleCacheHomeConnectionDescriptorContinuityStore,
    createHomeConnectionDescriptorContinuityStoreForServer,
    resolveHomeConnectionDescriptorContinuityPath,
    type HomeConnectionDescriptorContinuityStore,
} from "./homeConnectionDescriptorContinuity";

const irohSnapshot = {
    endpoint: {
        endpointId: "a".repeat(64),
        relayUrls: ["https://relay.example.test"],
        directAddresses: ["192.168.1.10:4242"],
    },
} as NonNullable<HomeIrohEndpointState["snapshot"]>;

const activeIroh = (): HomeIrohEndpointState => ({ status: "active", snapshot: irohSnapshot, failureReason: null });
const inactiveIroh = (): HomeIrohEndpointState => ({ status: "not-composed", snapshot: null, failureReason: null });

function facts(overrides: Partial<HomeDescriptorPublicationFacts> = {}): HomeDescriptorPublicationFacts {
    return {
        homeServerIdentityId: "srv_home",
        canonicalServerUrl: "https://home.example.test",
        publicServerUrl: null,
        minimumOuterRevisionExclusive: null,
        persistedOuterRevisionOwner: null,
        iroh: inactiveIroh(),
        ...overrides,
    };
}

describe("home connection descriptor publication owner", () => {
    beforeEach(() => {
        resetHomeConnectionDescriptorRevisionOwnerForTests();
    });

    it("never infers an HTTPS ingress endpoint from the canonical auth origin alone", () => {
        // Canonical auth origin is HTTPS, but no explicit ingress fact and no
        // Iroh endpoint exist: publishing an endpoint here would fabricate
        // ingress that the Home never observed.
        expect(composeHomeConnectionDescriptor(facts())).toBeUndefined();
    });

    it("publishes an HTTPS-only descriptor from the explicit ingress fact with a first monotonic revision", () => {
        const descriptor = composeHomeConnectionDescriptor(facts({
            publicServerUrl: "https://ingress.example.test",
        }));
        expect(descriptor).toEqual({
            v: 1,
            homeServerIdentityId: "srv_home",
            canonicalServerUrl: "https://home.example.test",
            revision: 1,
            endpoints: [{ kind: "https", url: "https://ingress.example.test" }],
        });
    });

    it("projects only a committed generation without invoking the continuity writer", async () => {
        let stored: { revision: number; contentKey: string } | null = null;
        const write = vi.fn(async (continuity: { revision: number; contentKey: string }) => {
            stored = continuity;
            return { status: "committed" as const, continuity };
        });
        const continuityStore = {
            read: async () => stored,
            write,
        } satisfies HomeConnectionDescriptorContinuityStore;
        const committed = await readHomeConnectionDescriptor({
            env: { HAPPIER_SERVER_IDENTITY_ID: "srv_home", HAPPIER_CANONICAL_SERVER_URL: "https://home.example.test" },
            continuityStore,
            visibility: "authenticated",
            resolveIrohEndpointState: activeIroh,
        });
        expect(committed).toBeDefined();
        write.mockClear();
        const projected = await readCommittedHomeConnectionDescriptor({
            env: { HAPPIER_SERVER_IDENTITY_ID: "srv_home", HAPPIER_CANONICAL_SERVER_URL: "https://home.example.test" },
            continuityStore,
            resolveIrohEndpointState: activeIroh,
        });
        expect(projected?.revision).toBe(committed?.revision);
        expect(projected?.endpoints[0]).not.toHaveProperty("directAddresses");
        expect(write).not.toHaveBeenCalled();
    });

    it.each([
        "http://localhost:3005",
        "http://qa.localhost:3005",
        "http://127.0.0.1:3005",
        "http://127.0.0.2:3005",
        "http://[::1]:3005",
    ])("publishes explicit loopback HTTP ingress %s", (publicServerUrl) => {
        const descriptor = composeHomeConnectionDescriptor(facts({ publicServerUrl }));
        expect(descriptor?.endpoints).toEqual([{ kind: "https", url: publicServerUrl }]);
        expect(resolvePublishedHomeConnectionDescriptor(facts({ publicServerUrl }))).toEqual(descriptor);
    });

    it.each([
        "http://192.168.1.10:3005",
        "http://home.example.test",
        "http://0.0.0.0:3005",
        "http://localhost.example.test:3005",
        "http://localhost:3005?token=private",
        "http://localhost:3005#fragment",
        "http://user:password@localhost:3005",
        "ftp://localhost:3005",
        "not a url",
    ])("rejects unsafe or invalid ingress %s instead of publishing it", (publicServerUrl) => {
        expect(composeHomeConnectionDescriptor(facts({ publicServerUrl }))).toBeUndefined();
    });

    it("publishes an Iroh-only descriptor and allocates its outer revision locally", () => {
        const descriptor = composeHomeConnectionDescriptor(facts({
            canonicalServerUrl: "http://127.0.0.1:43123",
            iroh: activeIroh(),
        }));
        expect(descriptor).toEqual({
            v: 1,
            homeServerIdentityId: "srv_home",
            canonicalServerUrl: "http://127.0.0.1:43123",
            revision: 1,
            endpoints: [{
                kind: "iroh",
                endpointId: "a".repeat(64),
                relayUrls: ["https://relay.example.test"],
                directAddresses: ["192.168.1.10:4242"],
            }],
        });
    });

    it("includes both endpoints when actual HTTPS ingress and the Iroh endpoint are available", () => {
        const descriptor = composeHomeConnectionDescriptor(facts({
            publicServerUrl: "https://ingress.example.test",
            iroh: activeIroh(),
        }));
        expect(descriptor?.endpoints).toEqual([
            { kind: "https", url: "https://ingress.example.test" },
            {
                kind: "iroh",
                endpointId: "a".repeat(64),
                relayUrls: ["https://relay.example.test"],
                directAddresses: ["192.168.1.10:4242"],
            },
        ]);
        expect(descriptor?.revision).toBe(1);
    });

    it("keeps the in-process revision monotonic across effective endpoint-set changes while the process runs", () => {
        // First HTTPS-only publication.
        const first = composeHomeConnectionDescriptor(facts({ publicServerUrl: "https://ingress.example.test" }));
        expect(first?.revision).toBe(1);
        // Focused repeated-read stability: unchanged content returns the
        // identical publication, revision included.
        const repeat = composeHomeConnectionDescriptor(facts({ publicServerUrl: "https://ingress.example.test" }));
        expect(repeat?.revision).toBe(1);
        expect(repeat).toEqual(first);
        // The Iroh lifecycle joins: only the outer owner advances the set.
        expect(composeHomeConnectionDescriptor(facts({
            publicServerUrl: "https://ingress.example.test",
            iroh: activeIroh(),
        }))?.revision).toBe(2);
        // Only an explicit retirement may remove Iroh and advance the set.
        expect(composeHomeConnectionDescriptor(facts({
            publicServerUrl: "https://ingress.example.test",
            iroh: { status: "retired", snapshot: null, failureReason: null },
        }))?.revision).toBe(3);
    });

    it("advances the outer revision when current endpoint facts change", () => {
        expect(composeHomeConnectionDescriptor(facts({
            iroh: activeIroh(),
        }))?.revision).toBe(1);
        expect(composeHomeConnectionDescriptor(facts({
            iroh: {
                status: "active",
                snapshot: {
                    endpoint: {
                        ...irohSnapshot.endpoint,
                        directAddresses: ["192.168.1.11:4242"],
                    },
                },
                failureReason: null,
            },
        }))?.revision).toBe(2);
    });

    it("continues the outer descriptor revision across an Iroh-to-HTTPS restart", () => {
        const irohContentKey = createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: "srv_home",
            canonicalServerUrl: "https://home.example.test",
            endpoints: [{
                kind: "iroh",
                endpointId: "a".repeat(64),
                relayUrls: ["https://relay.example.test"],
                directAddresses: ["192.168.1.10:4242"],
            }],
        });
        resetHomeConnectionDescriptorRevisionOwnerForTests();
        const httpsFacts = facts({
            publicServerUrl: "https://ingress.example.test",
            persistedOuterRevisionOwner: { revision: 7, contentKey: irohContentKey },
            iroh: { status: "retired", snapshot: null, failureReason: null },
        });
        const retired = composeHomeConnectionDescriptor(httpsFacts);
        expect(retired?.revision).toBe(8);

        const httpsContentKey = createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: "srv_home",
            canonicalServerUrl: "https://home.example.test",
            endpoints: [{ kind: "https", url: "https://ingress.example.test" }],
        });
        resetHomeConnectionDescriptorRevisionOwnerForTests();
        expect(composeHomeConnectionDescriptor(facts({
            publicServerUrl: "https://ingress.example.test",
            persistedOuterRevisionOwner: { revision: 8, contentKey: httpsContentKey },
        }))?.revision).toBe(8);
    });

    it("honors the explicit connectivity revision floor for freshly materialized Homes", () => {
        const descriptor = composeHomeConnectionDescriptor(facts({
            homeServerIdentityId: "srv_moved",
            canonicalServerUrl: "https://moved.example.test",
            publicServerUrl: "https://moved.example.test",
            minimumOuterRevisionExclusive: 9,
        }));
        expect(descriptor?.revision).toBe(10);
    });

    it("fails closed instead of overflowing the durable revision frontier", () => {
        const previousContentKey = createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: "srv_home",
            canonicalServerUrl: "https://home.example.test",
            endpoints: [{ kind: "https", url: "https://previous.example.test" }],
        });

        expect(composeHomeConnectionDescriptor(facts({
            publicServerUrl: "https://next.example.test",
            persistedOuterRevisionOwner: {
                revision: Number.MAX_SAFE_INTEGER,
                contentKey: previousContentKey,
            },
        }))).toBeUndefined();
    });

    it("projects the public descriptor without private direct-address hints", () => {
        const descriptor = resolvePublishedHomeConnectionDescriptor(facts({ iroh: activeIroh() }));
        expect(descriptor?.endpoints).toEqual([{
            kind: "iroh",
            endpointId: "a".repeat(64),
            relayUrls: ["https://relay.example.test"],
        }]);
        expect(JSON.stringify(descriptor)).not.toContain("192.168.1.10:4242");
    });

    it("withdraws a failed Iroh carrier while keeping the Home reachable and its native identity recoverable", () => {
        const published = composeHomeConnectionDescriptor(facts({
            publicServerUrl: "https://ingress.example.test",
            iroh: activeIroh(),
        }));
        expect(published?.revision).toBe(1);

        // A settled optional-carrier failure withdraws that carrier, while
        // the explicitly configured ingress keeps ordinary Home access ready.
        expect(composeHomeConnectionDescriptor(facts({
            publicServerUrl: "https://ingress.example.test",
            iroh: { status: "failed", snapshot: null, failureReason: "acceptor_not_running" },
        }))).toMatchObject({ revision: 2, endpoints: [{ kind: "https" }] });

        // Recovery is a real endpoint-set change, with the same native identity.
        expect(composeHomeConnectionDescriptor(facts({
            publicServerUrl: "https://ingress.example.test",
            iroh: activeIroh(),
        }))?.revision).toBe(3);
    });

    it.each(["unavailable", "failed"] as const)("keeps ordinary Home readiness available when the retained Iroh carrier is %s", (status) => {
        const publicServerUrl = "http://127.0.0.1:15728";
        const previous = {
            homeServerIdentityId: "srv_home",
            canonicalServerUrl: publicServerUrl,
            endpoints: [{ kind: "https" as const, url: publicServerUrl }, {
                kind: "iroh" as const, endpointId: irohSnapshot.endpoint.endpointId,
            }],
        };
        const irohState: HomeIrohEndpointState = { status, snapshot: null, failureReason: "endpoint_identity_drift" };
        const descriptor = composeHomeConnectionDescriptor(facts({
            publicServerUrl,
            canonicalServerUrl: publicServerUrl,
            persistedOuterRevisionOwner: { revision: 6,
                contentKey: createHomeConnectionDescriptorContentKey(previous),
                irohEndpointId: irohSnapshot.endpoint.endpointId },
            iroh: irohState,
        }));
        expect(descriptor).toMatchObject({
            homeServerIdentityId: "srv_home", revision: 7,
            endpoints: [{ kind: "https", url: publicServerUrl }],
        });
        expect(projectHomeReachability({ env: { HAPPIER_PUBLIC_SERVER_URL: publicServerUrl },
            access: null, iroh: irohState, irohAvailable: true,
        }).iroh).toMatchObject({ state: status, failureReason: "endpoint_identity_drift", endpointId: null });
        // Temporary carrier unavailability does not retire or replace its pinned
        // identity. Only the original endpoint can rejoin this Home afterwards.
        expect(composeHomeConnectionDescriptor(facts({ publicServerUrl, canonicalServerUrl: publicServerUrl,
            iroh: { status: "active", snapshot: { endpoint: { endpointId: "b".repeat(64) } }, failureReason: null },
        }))).toBeUndefined();
        expect(composeHomeConnectionDescriptor(facts({ publicServerUrl, canonicalServerUrl: publicServerUrl,
            iroh: activeIroh(),
        }))?.revision).toBe(8);
    });

    it("keeps explicit ingress reachable across a restart with a failed optional carrier", () => {
        const irohContentKey = createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: "srv_home",
            canonicalServerUrl: "https://home.example.test",
            endpoints: [{
                kind: "iroh",
                endpointId: "a".repeat(64),
                relayUrls: ["https://relay.example.test"],
                directAddresses: ["192.168.1.10:4242"],
            }],
        });
        expect(composeHomeConnectionDescriptor(facts({
            publicServerUrl: "https://ingress.example.test",
            persistedOuterRevisionOwner: { revision: 7, contentKey: irohContentKey },
            iroh: { status: "failed", snapshot: null, failureReason: "native_error" },
        }))).toMatchObject({ revision: 8, endpoints: [{ kind: "https" }] });
    });

    it("does not treat an uncomposed startup transition as an explicit Iroh retirement", () => {
        const irohContentKey = createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: "srv_home",
            canonicalServerUrl: "https://home.example.test",
            endpoints: [{
                kind: "iroh",
                endpointId: "a".repeat(64),
                relayUrls: ["https://relay.example.test"],
                directAddresses: ["192.168.1.10:4242"],
            }],
        });

        expect(composeHomeConnectionDescriptor(facts({
            publicServerUrl: "https://ingress.example.test",
            persistedOuterRevisionOwner: { revision: 7, contentKey: irohContentKey },
            iroh: inactiveIroh(),
        }))).toBeUndefined();
    });

    it("publishes the HTTPS-only set when a fail-closed lifecycle never published an Iroh endpoint", () => {
        // Nothing was retired here: this Home has no published Iroh endpoint,
        // so the remaining explicit ingress fact is the whole current set.
        expect(composeHomeConnectionDescriptor(facts({
            publicServerUrl: "https://ingress.example.test",
            iroh: { status: "failed", snapshot: null, failureReason: "endpoint_key_unavailable" },
        }))?.revision).toBe(1);
    });

});

describe("home connection descriptor production read path", () => {
    const dataDirs: string[] = [];
    let dataDir: string;
    let env: NodeJS.ProcessEnv;

    const continuityPath = (): string => resolveHomeConnectionDescriptorContinuityPath(
        join(dataDir, "runtime", "iroh", "endpoint.key"),
    );

    /** A process restart keeps the durable file and drops every in-process fact. */
    const restart = (): void => resetHomeConnectionDescriptorRevisionOwnerForTests();

    /** An Iroh lifecycle read the test releases at a chosen point in the race. */
    const deferredIrohEndpointState = (): {
        state: Promise<HomeIrohEndpointState>;
        resolve: (state: HomeIrohEndpointState) => void;
    } => {
        let resolve!: (state: HomeIrohEndpointState) => void;
        const state = new Promise<HomeIrohEndpointState>((res) => {
            resolve = res;
        });
        return { state, resolve };
    };

    beforeEach(async () => {
        restart();
        dataDir = await mkdtemp(join(tmpdir(), "home-descriptor-read-"));
        dataDirs.push(dataDir);
        env = {
            HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
            HAPPIER_SERVER_IDENTITY_ID: "srv_home",
            HAPPIER_CANONICAL_SERVER_URL: "https://home.example.test",
        };
    });

    afterEach(async () => {
        renameGate.capture = false;
        renameGate.captures.length = 0;
        restart();
        await Promise.all(dataDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    it("validates live destination authorities after preparation without publishing another revision", async () => {
        env.HAPPIER_PUBLIC_SERVER_URL = "https://home.example.test";
        const store = createFileHomeConnectionDescriptorContinuityStore(continuityPath());
        const prepared = await readRequiredAuthenticatedHomeConnectionDescriptor({ env, continuityStore: store });
        if (!prepared) throw new Error("Expected prepared Home descriptor");
        const persisted = await readFile(continuityPath(), "utf8");
        expect(readPreparedHomeCredentialDestination({ env, prepared })).toEqual(prepared);
        env.HAPPIER_PUBLIC_SERVER_URL = "https://replacement.test";
        expect(readPreparedHomeCredentialDestination({ env, prepared })?.endpoints).toEqual([
            { kind: "https", url: "https://replacement.test" },
        ]);
        env.HAPPIER_CANONICAL_SERVER_URL = "https://new-home.test";
        expect(readPreparedHomeCredentialDestination({ env, prepared })?.canonicalServerUrl).toBe("https://new-home.test");
        expect(await readFile(continuityPath(), "utf8")).toBe(persisted);
        restart();
        expect(() => readPreparedHomeCredentialDestination({ env, prepared })).toThrowError(
            "Home connection descriptor publication is unavailable",
        );
    });

    it("advances a shared-DB Home's retained descriptor across an HTTPS-to-loopback-HTTP move", async () => {
        const oldOrigin = "https://qa.localhost";
        const newOrigin = "http://qa.localhost:3030";
        const oldEnv = { ...env, HAPPIER_DB_PROVIDER: "postgres",
            HAPPIER_STACK_SHARED_DB_SOURCE_STACK: "dev",
            HAPPIER_CANONICAL_SERVER_URL: oldOrigin, HAPPIER_PUBLIC_SERVER_URL: oldOrigin };
        let sharedRevision = 32;
        const dependencies = {
            // Only the database boundary is substituted; publication and private-file storage are real.
            readSimpleCache: async () => JSON.stringify({ revision: sharedRevision,
                contentKey: `v1:n:${"b".repeat(64)}` }),
            compareAndSetSimpleCache: async () => { throw new Error("Must not mutate shared continuity"); },
        };
        const retainedStore = createHomeConnectionDescriptorContinuityStoreForServer(oldEnv, dependencies)!;
        await retainedStore.write({ revision: 60, contentKey: createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: "srv_home", canonicalServerUrl: oldOrigin,
            endpoints: [{ kind: "https", url: oldOrigin }],
        }) });
        const oldDescriptor = await readHomeConnectionDescriptor({
            env: oldEnv,
            continuityStore: retainedStore,
            visibility: "authenticated", resolveIrohEndpointState: inactiveIroh,
        });
        expect(oldDescriptor).toMatchObject({ canonicalServerUrl: oldOrigin, revision: 60 });
        restart();
        sharedRevision = 99;
        const movedEnv = { ...oldEnv, HAPPIER_CANONICAL_SERVER_URL: newOrigin, HAPPIER_PUBLIC_SERVER_URL: newOrigin };
        const moved = await readHomeConnectionDescriptor({
            env: movedEnv,
            continuityStore: createHomeConnectionDescriptorContinuityStoreForServer(movedEnv, dependencies)!,
            visibility: "authenticated", resolveIrohEndpointState: inactiveIroh,
        });
        expect(moved).toEqual({ ...oldDescriptor, canonicalServerUrl: newOrigin, revision: 61,
            endpoints: [{ kind: "https", url: newOrigin }] });
        restart();
        expect(await readHomeConnectionDescriptor({ env: movedEnv,
            continuityStore: createHomeConnectionDescriptorContinuityStoreForServer(movedEnv, dependencies)!,
            visibility: "authenticated", resolveIrohEndpointState: inactiveIroh,
        })).toEqual(moved);
    });

    it.each([null, 1, 40])("publishes from private continuity independently of shared history (private revision: %s)", async (privateRevision) => {
        const oldOrigin = "http://qa.localhost:3016";
        const newOrigin = "http://qa.localhost:3023";
        const movedEnv = { ...env, HAPPIER_DB_PROVIDER: "postgres",
            HAPPIER_STACK_SHARED_DB_SOURCE_STACK: "dev",
            HAPPIER_CANONICAL_SERVER_URL: newOrigin, HAPPIER_PUBLIC_SERVER_URL: newOrigin };
        const previous = { revision: 32, contentKey: createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: "srv_home", canonicalServerUrl: oldOrigin,
            endpoints: [{ kind: "https", url: oldOrigin }],
        }) };
        // This is retained database state from the previous publisher, not a client-supplied floor.
        const currentContentKey = createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: "srv_home", canonicalServerUrl: newOrigin,
            endpoints: [{ kind: "https", url: newOrigin }],
        });
        const path = join(dataDir, "runtime", "home.descriptor.json");
        if (privateRevision !== null) {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, JSON.stringify({ revision: privateRevision, contentKey: currentContentKey }));
        }
        let shared = previous;
        const dependencies = {
            readSimpleCache: async () => JSON.stringify(shared),
            compareAndSetSimpleCache: async () => { throw new Error("Must not mutate shared continuity"); },
        };
        const store = createHomeConnectionDescriptorContinuityStoreForServer(movedEnv, dependencies)!;
        const moved = await readHomeConnectionDescriptor({ env: movedEnv, continuityStore: store,
            visibility: "authenticated", resolveIrohEndpointState: inactiveIroh });
        expect(moved).toEqual({ v: 1, homeServerIdentityId: "srv_home", canonicalServerUrl: newOrigin,
            revision: privateRevision ?? 1, endpoints: [{ kind: "https", url: newOrigin }] });
        restart();
        // Shared publication is never this private Home's history.
        shared = { revision: 99, contentKey: `v1:n:${"b".repeat(64)}` };
        const reloadedStore = createHomeConnectionDescriptorContinuityStoreForServer(movedEnv, dependencies)!;
        expect(await readCommittedHomeConnectionDescriptor({ env: movedEnv, continuityStore: reloadedStore,
            resolveIrohEndpointState: inactiveIroh })).toEqual(moved);
        expect(await readHomeConnectionDescriptor({ env: movedEnv, continuityStore: reloadedStore,
            visibility: "authenticated", resolveIrohEndpointState: inactiveIroh })).toEqual(moved);
    });

    it.each(["unavailable", "malformed"])("publishes private continuity while shared history is %s", async (failure) => {
        const movedEnv = { ...env, HAPPIER_DB_PROVIDER: "postgres",
            HAPPIER_STACK_SHARED_DB_SOURCE_STACK: "dev",
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" };
        const store = createHomeConnectionDescriptorContinuityStoreForServer(movedEnv, {
            readSimpleCache: async () => {
                if (failure === "unavailable") throw new Error("temporary database outage");
                return "{malformed";
            },
            compareAndSetSimpleCache: async () => { throw new Error("Must not mutate shared continuity"); },
        })!;
        const read = () => readRequiredAuthenticatedHomeConnectionDescriptor({ env: movedEnv,
            continuityStore: store, resolveIrohEndpointState: inactiveIroh });
        const descriptor = await read();
        expect(descriptor).toMatchObject({ revision: 1 });
        if (!descriptor) throw new Error("Expected authenticated Home descriptor");
        expect(JSON.parse(await readFile(join(dataDir, "runtime", "home.descriptor.json"), "utf8")))
            .toEqual({ revision: 1, contentKey: createHomeConnectionDescriptorContentKey(descriptor) });
    });

    it("allocates the outer revision and keeps it across retirement to loopback HTTP ingress", async () => {
        const active = await readHomeConnectionDescriptor({
            env,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
            visibility: "authenticated",
            resolveIrohEndpointState: activeIroh,
        });
        expect(active?.revision).toBe(1);
        expect(active?.endpoints).toEqual([{
            kind: "iroh",
            endpointId: "a".repeat(64),
            relayUrls: ["https://relay.example.test"],
            directAddresses: ["192.168.1.10:4242"],
        }]);

        // Restart with the Iroh carrier deliberately gone: the one outer
        // revision owner covers the full endpoint set, so retirement publishes
        // strictly past the Iroh revision.
        restart();
        const retiredEnv = { ...env, HAPPIER_PUBLIC_SERVER_URL: "http://qa.localhost:3005" };
        const retired = await readHomeConnectionDescriptor({
            env: retiredEnv,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
            visibility: "authenticated",
            resolveIrohEndpointState: () => ({ status: "retired", snapshot: null, failureReason: null }),
        });
        expect(retired).toEqual({
            v: 1,
            homeServerIdentityId: "srv_home",
            canonicalServerUrl: "https://home.example.test",
            revision: 2,
            endpoints: [{ kind: "https", url: "http://qa.localhost:3005" }],
        });
        expect(await readCommittedHomeConnectionDescriptor({
            env: retiredEnv,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
            resolveIrohEndpointState: () => ({ status: "retired", snapshot: null, failureReason: null }),
        })).toEqual(retired);

        // An unchanged later restart republishes the identical revision.
        restart();
        expect((await readHomeConnectionDescriptor({
            env: retiredEnv,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
            visibility: "authenticated",
            resolveIrohEndpointState: () => ({ status: "retired", snapshot: null, failureReason: null }),
        }))?.revision).toBe(2);
    });

    it("persists the outer revision, content key, and pinned EndpointId with private-directory permissions", async () => {
        await readHomeConnectionDescriptor({
            env,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
            visibility: "public",
            resolveIrohEndpointState: activeIroh,
        });

        const persisted: unknown = JSON.parse(await readFile(continuityPath(), "utf8"));
        expect(Object.keys(persisted as Record<string, unknown>).sort()).toEqual(["contentKey", "irohEndpointId", "revision"]);
        expect(persisted).toMatchObject({ revision: 1, irohEndpointId: "a".repeat(64) });
        if (process.platform !== "win32") {
            expect((await stat(continuityPath())).mode & 0o777).toBe(0o600);
            expect((await stat(dirname(continuityPath()))).mode & 0o777).toBe(0o700);
        }
    });

    it("redacts direct addresses publicly and returns the exact descriptor to an authenticated Home client", async () => {
        const publicDescriptor = await readHomeConnectionDescriptor({
            env,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
            visibility: "public",
            resolveIrohEndpointState: activeIroh,
        });
        expect(JSON.stringify(publicDescriptor)).not.toContain("192.168.1.10:4242");

        const authenticated = await readHomeConnectionDescriptor({
            env,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
            visibility: "authenticated",
            resolveIrohEndpointState: activeIroh,
        });
        expect(authenticated?.endpoints[0]).toMatchObject({ directAddresses: ["192.168.1.10:4242"] });
        expect(authenticated?.revision).toBe(publicDescriptor?.revision);
    });

    it("fails closed on malformed persisted continuity instead of regressing to a first revision", async () => {
        await mkdir(dirname(continuityPath()), { recursive: true, mode: 0o700 });
        await writeFile(continuityPath(), '{"revision":0,"contentKey":""}\n', "utf8");

        expect(await readHomeConnectionDescriptor({
            env,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
            visibility: "authenticated",
            resolveIrohEndpointState: activeIroh,
        })).toBeUndefined();
        expect(await readFile(continuityPath(), "utf8")).toBe('{"revision":0,"contentKey":""}\n');
    });

    it("retries a transient first continuity read instead of poisoning the process", async () => {
        let reads = 0;
        let persisted: { revision: number; contentKey: string } | null = {
            revision: 7,
            contentKey: createHomeConnectionDescriptorContentKey({
                homeServerIdentityId: "srv_home",
                canonicalServerUrl: "https://home.example.test",
                endpoints: [{
                    kind: "iroh",
                    endpointId: "a".repeat(64),
                    relayUrls: ["https://relay.example.test"],
                    directAddresses: ["192.168.1.10:4242"],
                }],
            }),
        };
        const store: HomeConnectionDescriptorContinuityStore = {
            read: async () => {
                reads += 1;
                if (reads === 1) throw new Error("temporary database outage");
                return persisted;
            },
            write: async (continuity) => {
                persisted = continuity;
                return { status: "committed", continuity };
            },
        };

        expect(await readHomeConnectionDescriptor({
            env,
            continuityStore: store,
            visibility: "authenticated",
            resolveIrohEndpointState: activeIroh,
        })).toBeUndefined();
        expect((await readHomeConnectionDescriptor({
            env,
            continuityStore: store,
            visibility: "authenticated",
            resolveIrohEndpointState: activeIroh,
        }))?.revision).toBe(7);
        expect(reads).toBe(2);
    });

    it("surfaces transient continuity failure to required credential/bootstrap readers", async () => {
        let reads = 0;
        const store: HomeConnectionDescriptorContinuityStore = {
            read: async () => {
                reads += 1;
                if (reads === 1) throw new Error("temporary database outage");
                return null;
            },
            write: async (continuity) => ({ status: "committed", continuity }),
        };

        await expect(readRequiredAuthenticatedHomeConnectionDescriptor({
            env,
            continuityStore: store,
            resolveIrohEndpointState: activeIroh,
        })).rejects.toMatchObject({
            code: "home_connection_descriptor_publication_unavailable",
        });
        await expect(readRequiredAuthenticatedHomeConnectionDescriptor({
            env,
            continuityStore: store,
            resolveIrohEndpointState: activeIroh,
        })).resolves.toMatchObject({ homeServerIdentityId: "srv_home" });
    });

    it.each([false, true])("surfaces a retained Iroh publication failure to required credential/bootstrap readers (restart: %s)", async (restartBeforeFailure) => {
        let persisted: { revision: number; contentKey: string } | null = null;
        const store: HomeConnectionDescriptorContinuityStore = {
            read: async () => persisted,
            write: async (continuity) => {
                persisted = continuity;
                return { status: "committed", continuity };
            },
        };

        await expect(readRequiredAuthenticatedHomeConnectionDescriptor({
            env,
            continuityStore: store,
            resolveIrohEndpointState: activeIroh,
        })).resolves.toMatchObject({ homeServerIdentityId: "srv_home" });
        if (restartBeforeFailure) resetHomeConnectionDescriptorRevisionOwnerForTests();
        await expect(readRequiredAuthenticatedHomeConnectionDescriptor({
            env: { ...env, HAPPIER_PUBLIC_SERVER_URL: undefined },
            continuityStore: store,
            resolveIrohEndpointState: async () => ({
                status: "failed",
                snapshot: null,
                failureReason: "acceptor_not_running",
            }),
        })).rejects.toMatchObject({
            code: "home_connection_descriptor_publication_unavailable",
        });
    });

    it("durably publishes ordinary ingress after optional Iroh failure without retiring its pinned identity", async () => {
        const ingressEnv = { ...env, HAPPIER_CANONICAL_SERVER_URL: "http://127.0.0.1:15728",
            HAPPIER_PUBLIC_SERVER_URL: "http://127.0.0.1:15728" };
        const continuityStore = createFileHomeConnectionDescriptorContinuityStore(continuityPath());
        const initial = await readRequiredAuthenticatedHomeConnectionDescriptor({ env: ingressEnv,
            continuityStore, resolveIrohEndpointState: activeIroh });
        expect(initial?.endpoints.map(endpoint => endpoint.kind)).toEqual(["https", "iroh"]);
        restart();
        const unavailable = (): HomeIrohEndpointState => ({ status: "failed", snapshot: null,
            failureReason: "endpoint_identity_drift" });
        const fallback = await readRequiredAuthenticatedHomeConnectionDescriptor({ env: ingressEnv,
            continuityStore, resolveIrohEndpointState: unavailable });
        expect(fallback).toMatchObject({ homeServerIdentityId: "srv_home", revision: initial!.revision + 1,
            endpoints: [{ kind: "https", url: ingressEnv.HAPPIER_PUBLIC_SERVER_URL }] });
        expect(await continuityStore.read()).toMatchObject({ revision: fallback!.revision,
            irohEndpointId: irohSnapshot.endpoint.endpointId });
        expect(await readRequiredAuthenticatedHomeConnectionDescriptor({ env: ingressEnv,
            continuityStore, resolveIrohEndpointState: unavailable })).toEqual(fallback);
        expect(await readCommittedHomeConnectionDescriptor({ env: ingressEnv,
            continuityStore, resolveIrohEndpointState: unavailable })).toEqual(fallback);
        const recovered = await readRequiredAuthenticatedHomeConnectionDescriptor({ env: ingressEnv,
            continuityStore, resolveIrohEndpointState: activeIroh });
        expect(recovered?.revision).toBe(fallback!.revision + 1);
        expect(recovered?.endpoints.map(endpoint => endpoint.kind)).toEqual(["https", "iroh"]);
    });

    it("retries publication after a transient continuity write failure", async () => {
        let writes = 0;
        let persisted: { revision: number; contentKey: string } | null = null;
        const store: HomeConnectionDescriptorContinuityStore = {
            read: async () => persisted,
            write: async (continuity) => {
                writes += 1;
                if (writes === 1) throw new Error("temporary database outage");
                persisted = continuity;
                return { status: "committed", continuity };
            },
        };

        expect(await readHomeConnectionDescriptor({
            env,
            continuityStore: store,
            visibility: "authenticated",
            resolveIrohEndpointState: activeIroh,
        })).toBeUndefined();
        expect((await readHomeConnectionDescriptor({
            env,
            continuityStore: store,
            visibility: "authenticated",
            resolveIrohEndpointState: activeIroh,
        }))?.revision).toBe(1);
        expect(writes).toBe(2);
    });

    it("does not publish a candidate superseded by a conflicting cross-process commit", async () => {
        const winner = {
            revision: 7,
            contentKey: createHomeConnectionDescriptorContentKey({
                homeServerIdentityId: "srv_home",
                canonicalServerUrl: "https://home.example.test",
                endpoints: [{ kind: "https", url: "https://winner.example.test" }],
            }),
        };
        const store: HomeConnectionDescriptorContinuityStore = {
            read: async () => null,
            write: async () => ({ status: "superseded", continuity: winner }),
        };

        expect(await readHomeConnectionDescriptor({
            env,
            continuityStore: store,
            visibility: "authenticated",
            resolveIrohEndpointState: activeIroh,
        })).toBeUndefined();
    });

    it("does not advance unchanged stale local facts after they lose an equal-revision commit", async () => {
        let persisted: string | null = null;
        const dependencies = {
            readSimpleCache: async () => persisted,
            compareAndSetSimpleCache: async (_key: string, expectedValue: string | null, nextValue: string) => {
                if (persisted !== expectedValue) return false;
                persisted = nextValue;
                return true;
            },
        };
        const winnerStore = createSimpleCacheHomeConnectionDescriptorContinuityStore(dependencies);
        const winner = {
            revision: 7,
            contentKey: createHomeConnectionDescriptorContentKey({
                homeServerIdentityId: "srv_home",
                canonicalServerUrl: "https://home.example.test",
                endpoints: [{ kind: "https", url: "https://winner.example.test" }],
            }),
        };
        await expect(winnerStore.write(winner)).resolves.toEqual({ status: "committed", continuity: winner });

        // Simulate the losing process having primed before the winner landed:
        // its first continuity read is stale/null, while its CAS and every
        // subsequent read use the shared committed row.
        let loserReads = 0;
        const sharedLoserStore = createSimpleCacheHomeConnectionDescriptorContinuityStore(dependencies);
        const loserStore: HomeConnectionDescriptorContinuityStore = {
            read: async () => {
                loserReads += 1;
                return loserReads === 1 ? null : await sharedLoserStore.read();
            },
            write: async (continuity) => await sharedLoserStore.write(continuity),
        };

        expect(await readHomeConnectionDescriptor({
            env,
            continuityStore: loserStore,
            visibility: "authenticated",
            resolveIrohEndpointState: activeIroh,
        })).toBeUndefined();
        expect(await readHomeConnectionDescriptor({
            env,
            continuityStore: loserStore,
            visibility: "authenticated",
            resolveIrohEndpointState: activeIroh,
        })).toBeUndefined();
        await expect(winnerStore.read()).resolves.toEqual(winner);

        const freshIroh = (): HomeIrohEndpointState => ({
            status: "active",
            snapshot: {
                ...irohSnapshot,
                endpoint: {
                    ...irohSnapshot.endpoint,
                    endpointId: "c".repeat(64),
                },
            },
            failureReason: null,
        });
        const fresh = await readHomeConnectionDescriptor({
            env,
            continuityStore: loserStore,
            visibility: "authenticated",
            resolveIrohEndpointState: freshIroh,
        });
        expect(fresh?.revision).toBe(8);
        expect(fresh?.endpoints[0]).toMatchObject({ endpointId: "c".repeat(64) });
    });

    it("never lets an earlier in-flight continuity write rename over a newer committed revision", async () => {
        // Two reads compose in sequence while the OS rename boundary is
        // captured: read 1 composes revision 1 (Iroh-only); read 2 composes
        // revision 2 (Iroh + newly observed HTTPS ingress). Each persistence
        // turn uses an independent temp+rename, so without owner-side
        // serialization the older rename can complete after the newer one and
        // regress the durable revision below what clients already adopted.
        renameGate.capture = true;
        try {
            const first = deferredIrohEndpointState();
            const read1 = readHomeConnectionDescriptor({
                env,
                continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
                visibility: "authenticated",
                resolveIrohEndpointState: () => first.state,
            });
            first.resolve(activeIroh());
            await vi.waitFor(() => expect(renameGate.captures).toHaveLength(1));

            const second = deferredIrohEndpointState();
            const read2 = readHomeConnectionDescriptor({
                env: { ...env, HAPPIER_PUBLIC_SERVER_URL: "https://ingress.example.test" },
                continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
                visibility: "authenticated",
                resolveIrohEndpointState: () => second.state,
            });
            second.resolve(activeIroh());

            // The second persistence turn must stay queued until the first
            // atomic rename settles. Only the unserialized interleaving can
            // reach the rename boundary during this window; the serialized
            // owner keeps the capture at exactly the first rename until the
            // test starts landing writes below.
            await vi.waitFor(() => expect(renameGate.captures).toHaveLength(2)).catch(() => undefined);

            // Release the first serialized write. Only after it settles may
            // the newer write reach the rename boundary.
            await renameGate.captures[0].complete();
            await vi.waitFor(() => expect(renameGate.captures).toHaveLength(2));
            for (const capture of renameGate.captures) await capture.complete();

            const [, newerDescriptor] = await Promise.all([read1, read2]);
            expect(newerDescriptor?.revision).toBe(2);

            const durable: { revision: number; contentKey: string } = JSON.parse(
                await readFile(continuityPath(), "utf8"),
            );
            expect(durable.revision).toBe(2);
            expect(durable.contentKey).toBe(createHomeConnectionDescriptorContentKey({
                homeServerIdentityId: "srv_home",
                canonicalServerUrl: "https://home.example.test",
                endpoints: [
                    { kind: "https", url: "https://ingress.example.test" },
                    {
                        kind: "iroh",
                        endpointId: "a".repeat(64),
                        relayUrls: ["https://relay.example.test"],
                        directAddresses: ["192.168.1.10:4242"],
                    },
                ],
            }));

            // The concurrency interleaving under test is complete. The
            // following restart assertion performs another legitimate write,
            // which must use the normal filesystem boundary rather than be
            // captured without a corresponding test release.
            renameGate.capture = false;

            // A restart must never republish a revision below the already
            // adopted revision 2, even once the ingress fact is withdrawn.
            restart();
            const restarted = await readHomeConnectionDescriptor({
                env,
                continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
                visibility: "authenticated",
                resolveIrohEndpointState: activeIroh,
            });
            expect(restarted?.revision).toBeGreaterThanOrEqual(2);
        } finally {
            renameGate.capture = false;
            renameGate.captures.length = 0;
        }
    });

    it("serializes endpoint observation, revision allocation, and persistence in invocation order", async () => {
        const first = deferredIrohEndpointState();
        const second = deferredIrohEndpointState();
        const resolveFirstState = vi.fn(() => first.state);
        const resolveSecondState = vi.fn(() => second.state);
        const newerIroh = (): HomeIrohEndpointState => ({
            status: "active",
            snapshot: {
                endpoint: {
                    ...irohSnapshot.endpoint,
                    directAddresses: ["192.168.1.11:4242"],
                },
            },
            failureReason: null,
        });

        const read1 = readHomeConnectionDescriptor({
            env,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
            visibility: "authenticated",
            resolveIrohEndpointState: resolveFirstState,
        });
        const read2 = readHomeConnectionDescriptor({
            env,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
            visibility: "authenticated",
            resolveIrohEndpointState: resolveSecondState,
        });

        // Make the later observation ready first. A write-only queue lets it
        // compose and commit before the older invocation has observed its
        // facts; a full owner transaction still commits in invocation order.
        second.resolve(newerIroh());
        await vi.waitFor(() => expect(resolveFirstState).toHaveBeenCalledTimes(1));
        expect(resolveSecondState).not.toHaveBeenCalled();
        first.resolve(activeIroh());

        const [olderDescriptor, newerDescriptor] = await Promise.all([read1, read2]);
        expect(olderDescriptor?.revision).toBe(1);
        expect(olderDescriptor?.endpoints[0]).toMatchObject({ endpointId: "a".repeat(64) });
        expect(newerDescriptor?.revision).toBe(2);
        expect(newerDescriptor?.endpoints[0]).toMatchObject({
            endpointId: "a".repeat(64),
            directAddresses: ["192.168.1.11:4242"],
        });

        restart();
        const restarted = await readHomeConnectionDescriptor({
            env,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
            visibility: "authenticated",
            resolveIrohEndpointState: newerIroh,
        });
        expect(restarted?.revision).toBe(2);
        expect(restarted?.endpoints[0]).toMatchObject({
            endpointId: "a".repeat(64),
            directAddresses: ["192.168.1.11:4242"],
        });
    });

    it("does not poison later publication transactions when endpoint observation fails", async () => {
        await expect(readHomeConnectionDescriptor({
            env,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
            visibility: "authenticated",
            resolveIrohEndpointState: async () => {
                throw new Error("endpoint observation failed");
            },
        })).rejects.toThrow("endpoint observation failed");

        const recovered = await readHomeConnectionDescriptor({
            env,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(continuityPath()),
            visibility: "authenticated",
            resolveIrohEndpointState: activeIroh,
        });
        expect(recovered?.revision).toBe(1);
        expect(recovered?.endpoints[0]).toMatchObject({ endpointId: "a".repeat(64) });
    });
});
