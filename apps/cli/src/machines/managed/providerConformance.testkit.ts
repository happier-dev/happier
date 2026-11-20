import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginExecSpawnRequest, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { HttpRequest, HttpResponse } from '@happier-dev/plugin-sdk/http';
import type { PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import { createMachineProvisionerFetch } from '@happier-dev/plugin-sdk/machine-provisioners';

export const PRIVATE_BINDING = 'conformance-private-credential-binding';
export const PUBLIC_KEY = 'ssh-ed25519 AQIDBA==';
export const MANAGED_ID = 'cmvnxb7gn009mmcagisyszwlh';
export const NATIVE_EXPIRY = Date.parse('2026-11-03T12:00:00Z');
const text = new TextEncoder();
const decode = new TextDecoder('utf-8', { ignoreBOM: true });

/** A vendor outage (5xx with credential-shaped bodies), a vendor credential refusal (401), or a lost reply:
 * the next request that changes vendor state takes effect, then its reply fails (5xx / nonzero exit). */
export type ProviderConformanceFailure = false | 'outage' | 'credential' | 'effect-reply-lost';
/** Shared state of one fake vendor; each fixture reads and writes it from its own vendor protocol. */
export type ProviderConformanceVendorState = {
    present: boolean; power: string; allocations: number; foreignPresent: boolean; readonly owned: Set<string>;
    readonly failure: ProviderConformanceFailure; readonly evidence: boolean;
};
export type ProviderConformanceHttpRequestFacts = Readonly<{ url: URL; path: string; method: string; isForeign: boolean; targetPresent: boolean }>;
/** Either a JSON/text reply the world encodes, or a complete vendor response. */
export type ProviderConformanceHttpReply = Readonly<{ status?: number; value?: unknown; contentType?: string }> | HttpResponse;

/** What the core harness hands a provider's conformance fixture. Everything here is shared vendor-boundary plumbing. */
export type ProviderConformanceWorld = Readonly<{
    pluginId: string; contribution: string; directory: string;
    /** The provider-visible name the core derives from the managed id. */
    name: string; managedId: string; publicKey: string; privateBinding: string; nativeExpiry: number;
    state: ProviderConformanceVendorState;
    /** The fixture's declared foreign resource, owned by another Happier Machine. */
    readonly foreignId: string;
    /** Settle a vendor delete: the foreign resource or the expected owned one, never anything else. */
    remove(target: string | undefined, expected: string, effect: () => void): void;
    /** Run argv as a local guest process (the fake guest OS). */
    guest(argv: readonly string[], stdin?: Uint8Array): PluginProcessResult;
    result(value?: unknown, exitCode?: number): PluginProcessResult;
    body(request: HttpRequest): Record<string, unknown>;
    object(value: unknown): Record<string, unknown>;
    text: TextEncoder; decode: TextDecoder;
}>;

/** Vendor facts the shared assertions consume where the provisioner declaration does not state them. */
export type ProviderConformanceVendorFacts = Readonly<{
    /** Observed power of a present resource whose vendor read carries no power fact. */
    inspectPower?: 'running' | 'unknown';
    /** When the vendor representation carries a native expiry. */
    nativeExpiry?: 'always' | 'with-evidence';
    /** Native stop time reported with deletion evidence; with declared after-stop rules it dates the notice. */
    stoppedAt?: number;
    /** The vendor read can prove absence of a deleted resource from a lost acquire reply. */
    provesAbsenceAfterDelete?: true;
    /** Vendor request carrying the guest bootstrap user data (cloud-init) of an allocation, when the vendor uses one. */
    allocationUserData?(calls: readonly HttpRequest[]): unknown;
    /** Count of vendor image entries whose description is blank text; the options projection must drop it. */
    blankImageDescriptions?: number;
}>;

/** A fake vendor owned by the provider's own package: `packages/plugins/<leaf>/testkit/providerConformance.ts`. */
export type ProviderConformanceVendor = Readonly<{
    foreignId: string;
    launch: Record<string, unknown>;
    http?(request: HttpRequest, facts: ProviderConformanceHttpRequestFacts): ProviderConformanceHttpReply | Promise<ProviderConformanceHttpReply>;
    process?(request: PluginExecSpawnRequest, args: readonly string[]): PluginProcessResult | Promise<PluginProcessResult>;
    account?: Readonly<{ service?: PluginContributionRef; headers?: Record<string, string>; environment?: Record<string, string> }>;
    /** An origin the provider reaches with global fetch rather than the host HTTP service. */
    dataOrigin?: string;
    /** A worker thread entry that replaces the provider's own (Modal's SDK worker). */
    worker?: Readonly<{ preload: string; state: string; entry: string }>;
    /** A vendor fake with its own state (Railway, Modal); it replaces the shared state readers. */
    external?: Readonly<{ allocationCount(): number; foreignPresent(): boolean; present(): boolean; owned(): ReadonlySet<string>;
        setFailure(failure: ProviderConformanceFailure): void; cleanup(): void }>;
    /** Boundary evidence attached to an unexpected native IO failure. */
    diagnostics?(): unknown;
    facts?: ProviderConformanceVendorFacts;
}>;
export type ProviderConformanceFixture = (world: ProviderConformanceWorld) => ProviderConformanceVendor;
/** Shared cases a provider can be known to fail while a named owner fixes it. */
export type ProviderConformanceCase = 'accountPlacement' | 'nativeLifecycle' | 'deleteAfterLostReply' | 'credentialRefusal';
/** Per contribution id: the case and the owning fix (lane and board post). Removing an entry is how the owner closes it. */
export type ProviderConformanceExpectedFailures = Readonly<Record<string, Partial<Record<ProviderConformanceCase, string>>>>;
export type ProviderFixture = Awaited<ReturnType<typeof cloudFixture>>;

const pluginRoot = new URL('../../../../../packages/plugins/', import.meta.url);

async function importProviderFixtureModule(leaf: string): Promise<Record<string, unknown>> {
    const path = fileURLToPath(new URL(`${leaf}/testkit/providerConformance.ts`, pluginRoot));
    try { return await import(/* @vite-ignore */ path); }
    catch (error) { throw new Error(`${leaf} declares machineProvisioners but has no conformance fixture at ${path}`, { cause: error }); }
}

/** The provider's declared known failures, read when the suite is collected. */
export async function loadProviderConformanceExpectedFailures(leaf: string): Promise<ProviderConformanceExpectedFailures> {
    const declared = (await importProviderFixtureModule(leaf)).providerConformanceExpectedFailures;
    return (declared ?? {}) as ProviderConformanceExpectedFailures;
}

/** Load the provider's own conformance fixture; a provisioner without one fails here, by name. */
async function loadProviderFixture(leaf: string): Promise<ProviderConformanceFixture> {
    const module = await importProviderFixtureModule(leaf);
    const fixture = module.providerConformanceFixture;
    if (typeof fixture !== 'function') throw new Error(`${leaf}/testkit/providerConformance.ts must export providerConformanceFixture(world)`);
    return fixture as ProviderConformanceFixture;
}

/** Stateful vendor boundary only: public registration, roles, codecs and managed owners stay real. */
export async function cloudFixture(input: Readonly<{ leaf: string; pluginId: string; contribution: string }>) {
    const { leaf, pluginId, contribution } = input;
    const createVendor = await loadProviderFixture(leaf);
    const directory = mkdtempSync(join(tmpdir(), 'happier-provider-conformance-'));
    const calls: HttpRequest[] = [];
    const processes: PluginExecSpawnRequest[] = [];
    const logs: unknown[] = [];
    let failure: ProviderConformanceFailure = false, evidence = false;
    const state: ProviderConformanceVendorState = {
        present: false, power: 'running', allocations: 0, foreignPresent: true, owned: new Set<string>(),
        get failure() { return failure; }, get evidence() { return evidence; },
    };
    function result(value: unknown = '', exitCode = 0): PluginProcessResult {
        return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
            stdout: text.encode(typeof value === 'string' ? value : JSON.stringify(value)), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
    }
    function object(value: unknown): Record<string, unknown> {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected vendor object');
        return value as Record<string, unknown>;
    }
    let vendor: ProviderConformanceVendor | undefined;
    const world: ProviderConformanceWorld = {
        pluginId, contribution, directory, name: `happier-${MANAGED_ID}`, managedId: MANAGED_ID, publicKey: PUBLIC_KEY,
        privateBinding: PRIVATE_BINDING, nativeExpiry: NATIVE_EXPIRY, state,
        get foreignId() { return vendor?.foreignId ?? 'happier-foreign'; },
        remove(target, expected, effect) {
            if (target === world.foreignId) { state.foreignPresent = false; return; }
            if (target !== expected) throw new Error(`Unexpected ${leaf} deletion target: ${target}`);
            effect();
        },
        guest(argv, stdin) {
            // The core already probes the guest platform; fixtures answer with this directory as $HOME.
            if (argv.some(arg => arg === 'uname -s; uname -m; printf "%s\\n" "$HOME"')) return result(`Linux\nx86_64\n${directory}\n`);
            const completed = spawnSync(argv[0]!, argv.slice(1), { input: stdin, env: { ...process.env, HOME: directory } });
            if (completed.error) throw completed.error;
            return { ...result('', completed.status ?? 1), stdout: completed.stdout, stderr: completed.stderr };
        },
        result, object, body: request => object(JSON.parse(decode.decode(request.body))), text, decode,
    };
    vendor = createVendor(world);
    const created = vendor;
    async function processRequest(request: PluginExecSpawnRequest): Promise<PluginProcessResult> {
        processes.push(request);
        if (failure === 'outage') return { ...result(PRIVATE_BINDING, 1), stderr: text.encode(PRIVATE_BINDING) };
        if (request.executable.kind === 'systemTool' && request.executable.id === 'ssh-keyscan') return result(`203.0.113.8 ${PUBLIC_KEY}\n`);
        if (!created.process) throw new Error(`Unexpected vendor process for ${leaf}`);
        const before = failure === 'effect-reply-lost' ? snapshot() : undefined;
        const completed = await created.process(request, request.args ?? []);
        if (before === undefined || before === snapshot()) return completed;
        failure = false;
        return { ...result('', 1), stderr: text.encode('connection reset by peer') };
    }
    // Vendor state as seen by the shared assertions; a change marks an applied effect.
    function snapshot() { return JSON.stringify([state.present, state.power, state.allocations, state.foreignPresent, [...state.owned]]); }
    async function request(request: HttpRequest): Promise<HttpResponse> {
        calls.push(request);
        const url = new URL(request.url), path = url.pathname, method = request.method ?? 'GET';
        const isForeign = path.split('/').includes(world.foreignId), targetPresent = isForeign ? state.foreignPresent : state.present;
        if (failure === 'outage') return { status: 503, finalUrl: request.url, headers: {}, body: text.encode(JSON.stringify({
            error: { code: PRIVATE_BINDING, message: PRIVATE_BINDING }, message: PRIVATE_BINDING, code: PRIVATE_BINDING, id: PRIVATE_BINDING,
        })) };
        // A revoked or expired vendor credential: HTTP status is the vendor-neutral refusal fact.
        if (failure === 'credential') return { status: 401, finalUrl: request.url, headers: { 'content-type': 'application/json' },
            body: text.encode(JSON.stringify({ error: { code: 'unauthorized', message: 'Unauthorized' }, message: 'Unauthorized', code: 'unauthorized' })) };
        if (!created.http) throw new Error(`No vendor HTTP fixture for ${leaf}`);
        const before = failure === 'effect-reply-lost' ? snapshot() : undefined;
        const reply = await created.http(request, { url, path, method, isForeign, targetPresent });
        if (before !== undefined && before !== snapshot()) {
            failure = false;
            return { status: 502, finalUrl: request.url, headers: { 'content-type': 'text/plain' }, body: text.encode('upstream connection reset') };
        }
        if ('finalUrl' in reply) return reply;
        const status = reply.status ?? 200, contentType = reply.contentType ?? 'application/json';
        return { status, finalUrl: request.url, headers: { 'content-type': contentType },
            body: status === 204 ? new Uint8Array() : text.encode(contentType === 'application/json' ? JSON.stringify(reply.value) : String(reply.value)) };
    }
    // Host credential storage is a system boundary. No role or native client is replaced.
    const services = {
        http: { request },
        exec: { run: processRequest, systemTools: { resolve: async (resolve: { toolId: string }) => ({ executable: { kind: 'systemTool', id: resolve.toolId } }) } },
        managedServices: { dependencies: { status: async (id: string) => ({ state: 'ready', version: '0.5.0', executable: { kind: 'managedDependency', id: { pluginId, localId: id } } }) } },
        connectedAccounts: {
            getBinding: async () => ({ account: { service: created.account?.service ?? { pluginId, localId: 'account' }, accountId: 'selected' } }),
            materialize: async (_purpose: string, materialization: { kind: string }) => materialization.kind === 'environment'
                ? { kind: 'environment', env: created.account?.environment ?? {} }
                : { kind: 'httpHeaders', headers: created.account?.headers ?? { authorization: `Bearer ${PRIVATE_BINDING}` } },
        },
        machineProvisioners: {
            // The plugin-facing host interaction boundary approves this native fixture guest.
            establishSshHostTrust: async () => {},
            materializeBootstrapCredential: async (credential: { kind: 'file' | 'bytes' }) => {
                const bytes = text.encode('private-bootstrap-fixture-key');
                if (credential.kind === 'bytes') return { kind: 'bytes' as const, bytes, dispose: async () => { bytes.fill(0); } };
                const path = join(directory, 'bootstrap-key');
                writeFileSync(path, bytes, { mode: 0o600 });
                return { kind: 'file' as const, path, dispose: async () => { rmSync(path, { force: true }); } };
            },
            withBootstrapCredentialFile: async (file: { relativePath: string }, effect: (credential: { path: string }) => Promise<unknown>) => effect({ path: join(directory, file.relativePath) }),
            materializeGuestHostCredential: async () => ({ kind: 'bytes', bytes: text.encode('private-guest-host-key'), dispose: async () => {} }),
        },
        logger: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...values: unknown[]) => { logs.push(values); }])),
    } as unknown as PluginTestServicesFixture;
    const dataOrigin = created.dataOrigin;
    const dataFetch = dataOrigin ? createMachineProvisionerFetch({ signal: new AbortController().signal,
        services: { http: { request } } }, { purpose: 'conformance', origins: [dataOrigin], headerName: 'authorization', credential: {} }) : undefined;
    const external = created.external;
    return { directory, launch: created.launch, services, calls, processes, logs, worker: created.worker, dataOrigin, dataFetch,
        facts: created.facts ?? {}, diagnostics: () => created.diagnostics?.(),
        get allocationCount() { return external ? external.allocationCount() : state.allocations; },
        get foreignPresent() { return external ? external.foreignPresent() : state.foreignPresent; },
        get owned(): ReadonlySet<string> { return external ? external.owned() : state.owned; },
        get present() { return external ? external.present() : state.present; },
        setFailure(value: ProviderConformanceFailure) { failure = value; external?.setFailure(value); },
        setEvidence(value: boolean) { evidence = value; },
        cleanup() { external?.cleanup(); rmSync(directory, { recursive: true, force: true }); } };
}
