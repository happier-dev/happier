import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema, CurrentCursorResponseSchema, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { vi } from 'vitest';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import {
    adoptHomeProfile,
    getServerProfileById,
    removeServerProfile,
    resolveServerProfileScopeIdForIdentifier,
    setActiveServerId,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '../fixtures/projectAccountRows';
import { createArtifactStoreBoundary, type ArtifactStoreBoundary } from './artifactStoreBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '../fixtures/accountEncryptionCurrentness';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { parseToken } from '@/utils/auth/parseToken';
import type { Settings } from '@/sync/domains/settings/settings';
import { waitForNetworkResponseForTests } from '../mocks/runtimeFetch';

/**
 * One or more Homes, each answering for itself.
 *
 * Home Administration surfaces are only worth testing through the path they
 * actually take: the real credential binding, the real scoped request authority,
 * the real strict schemas and the real status classification. So this harness
 * stops at the two places that genuinely leave the process — the network and the
 * device credential store — and leaves everything above them running.
 *
 * That is what lets these tests fail for the right reasons. A moved feature bit,
 * a schema that stopped accepting a Home's answer, a status that stopped being
 * classified, or a request addressed to the wrong Home all surface here instead
 * of being mocked away.
 */

export type HomeDomainAnswer = Readonly<{
    /**
     * One path serving several reads told apart by their body (the active and the archived Team
     * list): return the answer for this request, or `undefined` for this answer's own fields.
     */
    select?: (input: unknown) => HomeDomainAnswer | undefined | Promise<HomeDomainAnswer | undefined>;
    status?: number;
    /** Sent as the JSON body. Omit for an empty body. */
    body?: unknown;
    /** Holds this genuine network boundary open until the test releases it. */
    respondAfter?: PromiseLike<void>;
    /**
     * The request reaches the network and then no answer comes back.
     *
     * This is the one real failure a client cannot resolve on its own: the Home
     * may or may not have committed the mutation. The boundary records the
     * request first, exactly as a dispatched request is recorded, and then
     * fails, so the production classification decides between "not dispatched"
     * and "outcome unknown" instead of a test asserting the outcome directly.
     */
    dispatchThenFail?: boolean;
}>;

export type RecordedHomeRequest = Readonly<{
    serverId: string;
    serverUrl: string;
    path: string;
    input: unknown;
    /** The bearer the scoped authority actually attached, for authority checks. */
    token: string | null;
}>;

export type AddHomeOptions = Readonly<{
    name: string;
    serverUrl: string;
    /** Seeds the Home-published public HTTPS projection when the surface requires it. */
    publicServerUrl?: string | null;
    /**
     * The Home's stable portable identity, as a Home publishes it. A surface
     * that stamps or resolves that identity (approval origins, portable links)
     * needs it; omission models a manually added Home that published none.
     */
    serverIdentityId?: string;
    /** The Account this device holds there. `null` means signed out of it. */
    accountId?: string | null;
    /** Explicit genuine encryption material for encrypted Account fixtures. Plain defaults are token-only. */
    credentials?: AuthCredentials;
    /** Seeds the canonical `teams` feature decision for that Home. */
    teamsEnabled?: boolean;
    /**
     * Seeds the canonical `teams.credentialResources` decision for that Home.
     *
     * It is separate from `teamsEnabled` because the catalog makes it a child
     * feature: a Home may have Teams and not shared credentials, and a suite
     * about the credential destination has to be able to say which.
     */
    credentialResourcesEnabled?: boolean;
    /** Seeds the separately gated public broker ingress surface. */
    credentialResourcesExternalApiEnabled?: boolean;
    /** Explicit operation-scoped deployment projection; omission models an older Home. */
    credentialResourcesExternalApiAvailability?: unknown;
    /** Seeds the canonical personal Machine Pool decision for that Home. */
    machinePoolsEnabled?: boolean;
    /** Whether this Home becomes the active one. Defaults to true. */
    active?: boolean;
    /**
     * The Account mode this Home reports to the shared Action front door, which
     * reads it before it dispatches anything.
     *
     * `plain` is the default because it is a real supported Account mode and it
     * keeps a governance suite about governance: an E2EE Account would pull
     * real key material into every Team assertion. A suite that is genuinely
     * about encryption sets `e2ee` and supplies that material itself.
     */
    accountEncryptionMode?: 'plain' | 'e2ee';
    /** Current signed ordinary-Account claims for native Action ingress; omitted remains legacy. */
    currentAccount?: boolean;
}>;

const ACCOUNT_ENCRYPTION_PATH = '/v1/account/encryption';
const ACCOUNT_SETTINGS_V2_PATH = '/v2/account/settings';
const ARTIFACT_CREATE_PATH = '/v1/artifacts';

type HomeRecord = {
    serverId: string;
    serverUrl: string;
    /** The Account this device holds there, for Account-scoped policy writes. */
    accountId: string | null;
    token: string | null;
    answers: Map<string, HomeDomainAnswer>;
    /** This Home's Artifact rows for its Account; an explicit `answer` for a path wins. */
    artifacts: ArtifactStoreBoundary;
};

export type HomeGovernanceHarness = Readonly<{
    /** Every request that reached the network boundary, in order. */
    requests: RecordedHomeRequest[];
    /** The same Home answers at the external fetch boundary for real Sync/request consumers. */
    request: RuntimeFetch;
    /** Saves a Home on this device and returns the id every path is keyed by. */
    addHome(options: AddHomeOptions): Promise<string>;
    /**
     * What one Home answers for one path. A later call replaces an earlier one.
     * A route that serves several methods on one path (a read and a create of
     * the same resource) is answered per method by prefixing it: `'POST /v1/x'`.
     * A method-prefixed answer wins over the bare path for that method.
     */
    answer(serverId: string, path: string, answer: HomeDomainAnswer): void;
    /**
     * Makes one exact Action explicitly approval-required for this Home's
     * Account, through the real persisted Actions policy the shared Action front
     * door reads. That requirement is what turns an ordinary mutation into an
     * approval request instead of an immediate Home call, so a case asserting
     * approval routing exercises the shipped policy rather than a stub.
     *
     * The harness owns this write because it also owns undoing it: the policy
     * lives in the shared Account settings baseline, which no other reset owner
     * clears, and a leftover requirement silently defers the *next* test's
     * mutation into an approval Artifact its Home was never asked to answer for
     * — which surfaces as a domain failure rather than the isolation defect it
     * is. `reset` therefore removes exactly what this seeded.
     */
    requireUiApproval(serverId: string, actionId: string): Promise<void>;
    /** Requests recorded for one path, for asserting what was asked and where. */
    requestsFor(path: string): RecordedHomeRequest[];
    /**
     * The Artifact rows this Home persists for its Account. Every Home serves
     * its Artifact routes statefully, with the Home's versioned
     * compare-and-set, so approval requests are created, read, claimed and
     * settled through the real client writer and codec.
     */
    artifacts(serverId: string): ArtifactStoreBoundary;
    /**
     * Puts several saved Homes into the exact set the user is looking at, using
     * the real Home-view selection owner rather than a stubbed selection hook.
     */
    selectHomes(serverIds: readonly string[]): Promise<void>;
    /**
     * Someone else signs in on one saved Home: its credential now belongs to `accountId`, written
     * through the real credential store so every credential-lifetime observer sees the change.
     */
    switchAccount(serverId: string, accountId: string, credentials?: AuthCredentials): Promise<void>;
    /** Used by the installed boundaries; tests address Homes by id. */
    findByServerUrl(serverUrl: string): HomeRecord | null;
    reset(): Promise<void>;
}>;

const installed = vi.hoisted(() => ({ current: null as HomeGovernanceHarness | null }));

function base64Url(value: string): string {
    return globalThis.btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * A structurally real token for one Account.
 *
 * Persisted through the real credential store: the production decoder runs on
 * this, so a token this device cannot read fails here the same way a malformed
 * one fails in the app.
 */
export function createAccountTokenForTests(accountId: string, options?: Readonly<{ currentAccount?: boolean }>): string {
    return `e30.${base64Url(JSON.stringify({ sub: accountId, ...(options?.currentAccount ? {
        provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'account', authority: 'present_user' }), tokenEpoch: 0,
    } : {}) }))}.signature`;
}

export function createHomeGovernanceHarness(): HomeGovernanceHarness {
    const homesByServerId = new Map<string, HomeRecord>();
    const homesByServerUrl = new Map<string, HomeRecord>();
    const requests: RecordedHomeRequest[] = [];
    /** Whether this harness wrote an explicit approval requirement to undo. */
    let seededApprovalRequirement: Readonly<{ serverId: string; accountId: string; policy: Settings['actionsSettingsV1'] }> | null = null;
    const credentialWrites: Array<NonNullable<Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>>> = [];
    const installedLocks: Array<ReturnType<typeof installWebLockManagerMock>> = [];

    let harness: HomeGovernanceHarness;
    harness = Object.freeze({
        requests,
        request: async (input: Parameters<RuntimeFetch>[0], init: Parameters<RuntimeFetch>[1]) => {
            const url = input instanceof Request ? input.url : String(input);
            const authorization = new Headers(init?.headers).get('Authorization');
            return await answerForEndpoint(harness, new URL(url).origin, url, init,
                authorization?.startsWith('Bearer ') ? authorization.slice(7) : null);
        },
        async addHome(options: AddHomeOptions): Promise<string> {
            if (typeof globalThis.navigator?.locks?.request !== 'function') installedLocks.push(installWebLockManagerMock());
            const profile = options.publicServerUrl === undefined && options.serverIdentityId === undefined
                ? await upsertServerProfile({ serverUrl: options.serverUrl, name: options.name })
                : await adoptHomeProfile({
                    descriptor: {
                        serverUrl: options.serverUrl,
                        ...(options.publicServerUrl === undefined ? {} : { publicServerUrl: options.publicServerUrl }),
                        ...(options.serverIdentityId === undefined ? {} : { homeServerIdentityId: options.serverIdentityId }),
                        displayName: options.name,
                    },
                    source: 'manual',
                    suggestedName: options.name,
                });
            const serverId = profile.id;
            const storedServerUrl = getServerProfileById(serverId)?.serverUrl ?? options.serverUrl;
            const accountId = options.accountId === null
                ? null
                : options.accountId ?? `account-${serverId}`;
            const record: HomeRecord = {
                serverId,
                serverUrl: storedServerUrl,
                accountId,
                token: accountId === null ? null : options.credentials?.token ?? createAccountTokenForTests(accountId, { currentAccount: options.currentAccount }),
                answers: new Map(),
                artifacts: createArtifactStoreBoundary({
                    ownerAccountId: () => record.accountId,
                    encryptionMode: options.accountEncryptionMode ?? 'plain',
                }),
            };
            homesByServerId.set(serverId, record);
            homesByServerUrl.set(storedServerUrl, record);

            // The Action front door captures the Account context before every
            // dispatch: it reads the Account mode, then the settings baseline.
            // A Home answers both by default — unanswered, the 404 for settings
            // reads as "server too old for v2", which a Plain Account treats as
            // fatal and which would fail every Action for the wrong reason. A
            // case may still replace either answer.
            record.answers.set(ACCOUNT_ENCRYPTION_PATH, {
                body: { mode: options.accountEncryptionMode ?? 'plain', updatedAt: 0 },
            });
            record.answers.set(ACCOUNT_SETTINGS_V2_PATH, { body: { content: null, version: 0 } });
            record.answers.set('/health', { body: {} });
            record.answers.set('/v1/auth/ping', { body: {} });
            // The real managed Socket transport probes this authenticated
            // endpoint before constructing its external SDK connection.
            record.answers.set('/v2/cursor', { body: CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }) });
            if ((options.accountEncryptionMode ?? 'plain') === 'plain') {
                record.answers.set('/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
            }
            record.answers.set(`GET ${AUTHORING_MEMORY_ROUTE_V1}`, { body: AuthoringMemoryListResponseV1Schema.parse({ rows: [] }) });
            if ((options.accountEncryptionMode ?? 'plain') === 'plain') {
                record.answers.set(`POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body: createPlainProjectAccountRowListFixture() });
            }

            const features = createRootLayoutFeaturesResponse();
            if (options.teamsEnabled !== undefined
                || options.credentialResourcesEnabled !== undefined
                || options.credentialResourcesExternalApiEnabled !== undefined
                || options.credentialResourcesExternalApiAvailability !== undefined
                || options.machinePoolsEnabled !== undefined) {
                if (options.teamsEnabled !== undefined
                    && !tryWriteServerEnabledBitInPlace(features, 'teams', options.teamsEnabled)) {
                    throw new Error('The teams feature bit could not be written by its own writer');
                }
                if (options.credentialResourcesEnabled !== undefined
                    && !tryWriteServerEnabledBitInPlace(
                        features,
                        'teams.credentialResources',
                        options.credentialResourcesEnabled,
                    )) {
                    throw new Error('The teams.credentialResources feature bit could not be written by its own writer');
                }
                if (options.credentialResourcesExternalApiEnabled !== undefined
                    && !tryWriteServerEnabledBitInPlace(
                        features,
                        'teams.credentialResources.externalApi',
                        options.credentialResourcesExternalApiEnabled,
                    )) {
                    throw new Error('The teams.credentialResources.externalApi feature bit could not be written by its own writer');
                }
                if (options.machinePoolsEnabled !== undefined
                    && !tryWriteServerEnabledBitInPlace(
                        features,
                        'machines.pools',
                        options.machinePoolsEnabled,
                    )) {
                    throw new Error('The machines.pools feature bit could not be written by its own writer');
                }
                if (options.credentialResourcesExternalApiAvailability) {
                    Reflect.set(features.capabilities, 'teams', {
                        credentialResources: {
                            externalApi: options.credentialResourcesExternalApiAvailability,
                        },
                    });
                }
                // Imported here for the same reason as the storage graph below:
                // this module binds the real `@/sync/http/client` leaves at
                // evaluation, and the boundaries are installed with `vi.doMock`,
                // which only affects later imports. Pulling it in at testkit
                // evaluation resolves the real transport first and every Home
                // request then leaves the harness.
                const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
                primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
            }
            // The Action front door may force-refresh capabilities for approval and
            // stored-content compatibility. Keep that real network boundary aligned
            // with the primed snapshot instead of letting a 404 masquerade as an
            // old Home during mutation tests.
            record.answers.set('/v1/features', { body: features });
            record.answers.set('/v1/features/authenticated', { body: features });

            if (record.token) {
                const write = await TokenStorage.setCredentialsForServerUrlWithRollback(
                    storedServerUrl, { serverId }, options.credentials ?? { token: record.token },
                );
                if (!write) throw new Error(`The credential store refused Home ${serverId}`);
                credentialWrites.push(write);
            }

            if (options.active !== false) await setActiveServerId(serverId, { scope: 'device' });
            return serverId;
        },
        answer(serverId: string, path: string, answer: HomeDomainAnswer): void {
            const record = homesByServerId.get(serverId);
            if (!record) throw new Error(`No Home saved for ${serverId}`);
            record.answers.set(path, answer);
        },
        async requireUiApproval(serverId: string, actionId: string): Promise<void> {
            const record = homesByServerId.get(serverId);
            if (!record) throw new Error(`No Home saved for ${serverId}`);
            if (!record.accountId) {
                throw new Error(`Home ${serverId} holds no Account to require approval for`);
            }
            const { storage } = await import('@/sync/domains/state/storage');
            const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
            const scope = getActiveServerAccountScope();
            const isAppliedAccount = scope?.serverId === resolveServerProfileScopeIdForIdentifier(serverId)
                && scope.accountId === record.accountId;
            const { settingsParse } = await import('@/sync/domains/settings/settings');
            const current = isAppliedAccount ? storage.getState().settings : settingsParse({});
            const settings = settingsParse({
                ...current,
                actionsSettingsV1: {
                    v: 1,
                    actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
                },
            });
            // A local settings publication can only belong to an actually
            // restored Account. Persisted target policy below also serves a
            // saved/nonfocused Home without forging a focused Account scope.
            if (isAppliedAccount && scope) {
                seededApprovalRequirement ??= { ...scope, policy: current.actionsSettingsV1 };
                storage.getState().applySettingsLocal({ actionsSettingsV1: settings.actionsSettingsV1 });
            }
            // The Action front door may capture the exact Home while another
            // surface changes the device's live settings scope. Persist the same
            // policy at this Home's real settings boundary so the request still
            // observes the Account-owned decision instead of falling back to the
            // harness's empty baseline.
            record.answers.set(ACCOUNT_SETTINGS_V2_PATH, {
                body: { content: { t: 'plain', v: settings }, version: 1 },
            });
            // The approval request itself crosses the Artifact write boundary,
            // which every Home already answers statefully (`artifacts`).
        },
        requestsFor(path: string): RecordedHomeRequest[] {
            return requests.filter((request) => request.path === path);
        },
        artifacts(serverId: string): ArtifactStoreBoundary {
            const record = homesByServerId.get(serverId);
            if (!record) throw new Error(`No Home saved for ${serverId}`);
            return record.artifacts;
        },
        async switchAccount(serverId: string, accountId: string, credentials?: AuthCredentials): Promise<void> {
            const record = homesByServerId.get(serverId);
            if (!record) throw new Error(`No saved Home ${serverId}`);
            const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
            const active = getActiveServerAccountScope();
            const isAppliedHome = active?.serverId === resolveServerProfileScopeIdForIdentifier(serverId);
            if (isAppliedHome && seededApprovalRequirement && active?.serverId === seededApprovalRequirement.serverId
                && active.accountId === seededApprovalRequirement.accountId) {
                const { storage } = await import('@/sync/domains/state/storage');
                storage.getState().applySettingsLocal({ actionsSettingsV1: seededApprovalRequirement.policy });
                seededApprovalRequirement = null;
            }
            const { disconnectActiveServerConnection, restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
            if (isAppliedHome) await disconnectActiveServerConnection();
            const nextCredentials = credentials ?? { token: createAccountTokenForTests(accountId) };
            const write = await TokenStorage.setCredentialsForServerUrlWithRollback(
                record.serverUrl,
                { serverId },
                nextCredentials,
            );
            if (!write) throw new Error(`The credential store refused the switch on ${serverId}`);
            credentialWrites.push(write);
            record.accountId = accountId;
            record.token = nextCredentials.token;
            if (isAppliedHome) await restoreConnectionToActiveServer(nextCredentials);
        },
        async selectHomes(serverIds: readonly string[]): Promise<void> {
            const groupId = 'home-governance-test-group';
            await updateEffectiveHomeViewState((current) => ({
                ...current,
                groups: [{ id: groupId, name: 'Test group', serverIds: [...serverIds] }],
                activeTargetKind: 'group',
                activeTargetId: groupId,
            }), { scope: 'device' });
        },
        findByServerUrl(serverUrl: string): HomeRecord | null {
            return homesByServerUrl.get(serverUrl) ?? null;
        },
        async reset(): Promise<void> {
            // Vitest may collect several Home-governance suites in one worker.
            // Each suite installs its own harness at module evaluation, so the
            // last collected suite would otherwise own every shared boundary.
            // `beforeEach` always resets the suite-local harness; reclaim the
            // boundary here so execution order cannot redirect its requests.
            installed.current = harness;
            setRuntimeFetch((input, init) => requireHarness().request(input, init));
            const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
            const active = getActiveServerAccountScope();
            if (seededApprovalRequirement && active?.serverId === seededApprovalRequirement.serverId
                && active.accountId === seededApprovalRequirement.accountId) {
                const { storage } = await import('@/sync/domains/state/storage');
                storage.getState().applySettingsLocal({ actionsSettingsV1: seededApprovalRequirement.policy });
            }
            seededApprovalRequirement = null;
            if (active && [...homesByServerId.keys()].some(id => resolveServerProfileScopeIdForIdentifier(id) === active.serverId)) {
                const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
                await disconnectActiveServerConnection();
            }
            for (const write of credentialWrites.splice(0).reverse()) await write.rollback();
            // The Homes were saved through the real profile owner, so they are
            // removed through it too: a leftover Home would silently rejoin the
            // next test's selection. Standard cleanup may already have dropped
            // the underlying storage, so only a Home still present is removed.
            for (const serverId of homesByServerId.keys()) {
                if (getServerProfileById(serverId)) await removeServerProfile(serverId);
            }
            homesByServerId.clear();
            homesByServerUrl.clear();
            for (const locks of installedLocks.splice(0).reverse()) locks.restore();
            requests.length = 0;
        },
    });
    return harness;
}

function requireHarness(): HomeGovernanceHarness {
    const current = installed.current;
    if (!current) throw new Error('The Home governance harness is not installed');
    return current;
}

/**
 * Answers one request from whichever Home the endpoint belongs to.
 *
 * Shared by both network boundaries so a Home has exactly one set of answers no
 * matter which transport a path arrives on.
 */
async function answerForEndpoint(
    current: HomeGovernanceHarness,
    serverUrl: string,
    url: string,
    init: RequestInit | undefined,
    token: string | null,
): Promise<Response> {
    const body = init?.body;
    const record = current.findByServerUrl(serverUrl);
    const path = url.startsWith(serverUrl) ? url.slice(serverUrl.length) : url;

    let input: unknown = null;
    try {
        input = typeof body === 'string' ? JSON.parse(body) : null;
    } catch {
        input = null;
    }
    current.requests.push(Object.freeze({
        serverId: record?.serverId ?? '',
        serverUrl,
        path,
        input,
        token,
    }));

    const method = (init?.method ?? 'GET').toUpperCase();
    const pathAnswer = record?.answers.get(`${method} ${path}`) ?? record?.answers.get(path);
    const answer = await pathAnswer?.select?.(input) ?? pathAnswer;
    if (!answer && path === '/v1/account/profile') {
        let accountId: string | null = null;
        try { accountId = token ? parseToken(token) : null; } catch { /* Invalid external bearer stays unauthenticated. */ }
        return accountId ? Response.json(AccountProfileSchema.parse({ id: accountId }))
            : Response.json({ error: 'Not authenticated' }, { status: 401 });
    }
    if (!answer) {
        const artifactResponse = record?.artifacts.handle(path, init);
        if (artifactResponse) return await artifactResponse;
    }
    // A Home that was given no answer for this path behaves like one that does
    // not serve it, rather than silently succeeding.
    if (!answer) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    if (answer.respondAfter) await waitForNetworkResponseForTests(answer.respondAfter, init?.signal);
    // No `code`, because a lost connection after dispatch carries none. That is
    // precisely what makes the committed outcome unknowable to the client.
    if (answer.dispatchThenFail) throw new TypeError('Failed to fetch');
    const responseBody = path === ARTIFACT_CREATE_PATH
        && input && typeof input === 'object'
        && !Array.isArray(input)
        && answer.body && typeof answer.body === 'object'
        && !Array.isArray(answer.body)
        ? { ...(answer.body as Record<string, unknown>), id: (input as { id?: unknown }).id }
        : answer.body;
    return new Response(
        responseBody === undefined ? '' : JSON.stringify(responseBody),
        { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } },
    );
}

/**
 * Installs the external HTTP port. Both request orchestration paths remain
 * real and converge on runtimeFetch, so authentication, reachability and
 * captured-Account retirement cannot be bypassed by this fixture.
 */
export function installHomeGovernanceBoundaries(harness: HomeGovernanceHarness): void {
    installed.current = harness;
    setRuntimeFetch((input, init) => requireHarness().request(input, init));

    vi.doUnmock('@/sync/http/client');
    vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
}

/**
 * Waits for a Home Administration render the way the runner already decided
 * these waits should be bounded.
 *
 * `vi.waitFor` applies a 1 s cutoff — a default meant for a quick synchronous
 * poll. What these suites wait on is a React render behind this harness's real
 * request boundary, on a fork-capped runner whose `testTimeout`
 * (`apps/ui/vitest.config.ts`) was deliberately raised so "unrelated load
 * doesn't cause spurious failures". The 1 s poll silently overrode that
 * decision, which is why this family reads red on a busy host and green on a
 * quiet one while the bytes never changed. A subordinate wait must not impose a
 * shorter competing cutoff than the case containing it, so the budget is read
 * from the runner's own resolved configuration rather than chosen here.
 */
export function waitForHomeGovernance<T>(assertion: () => T | Promise<T>): Promise<T> {
    return vi.waitFor(assertion, { timeout: resolveRunnerTestTimeoutMs() });
}

function resolveRunnerTestTimeoutMs(): number {
    // Vitest keeps the resolved project config on the worker that runs the
    // case, and bounds the case with `config.testTimeout` from it. Reading the
    // same field is what makes this an inherited deadline instead of a second
    // copy of the number.
    const configured = (globalThis as {
        __vitest_worker__?: { config?: { testTimeout?: unknown } };
    }).__vitest_worker__?.config?.testTimeout;
    if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
        // Failing here is deliberate: a local default would reintroduce exactly
        // the second, shorter deadline this helper exists to remove.
        throw new Error('home governance harness: the runner exposed no test timeout to inherit');
    }
    return configured;
}
