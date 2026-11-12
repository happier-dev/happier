import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
// @vitest-environment jsdom
import * as React from 'react';
import { createHash } from 'node:crypto';
import { act, cloneElement, type ReactElement } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiSemanticSurfaceAdapter } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
    PluginUiCollectionQueryInput,
    PluginUiCollectionQueryPager,
    PluginUiCollectionQuerySnapshot,
    PluginUiDataClient,
} from '@happier-dev/plugin-ui/data';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createUnavailablePluginUiAccountKv } from '../../../../../plugin-ui/src/data/accountKv.js';
import { createPluginUiHostApiResourceClient, createPluginUiResourceStore, type PluginUiResourceStore } from '../../../../../plugin-ui/src/hostApi/resourceStore.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_SESSION_LINKS_FIELD, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../../corpus/collections/rows.js';
import { sessionLinkTagComponents } from '../../corpus/identity/components.js';
import { TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME } from '../sessionLinksResource.js';
import { TriageReadSourceSessionLinksResultV1Schema } from '../../actions/sessionLinksProtocol.js';
import { LinkEntryPicker, renderSurface as renderSessionLinkedEntriesSurface } from './sessionLinkedEntriesSurface.js';
import { TRIAGE_ENTRY_DETAIL_DESTINATION_V1 } from '../../composer/openEntryDetails.js';
import { parseTriageRouteSubPathV1 } from '../../ui/navigation/location.js';
import type { PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import { Button, Text, defineUiSurface } from '@happier-dev/plugin-ui';
import { useLinkedPullRequestStatus } from './useLinkedPullRequestStatus.js';
import { useTriageScmPullRequestCardV1 } from '../scmPullRequestCard.js';
import { TriageScmPullRequestCard } from '../../ui/scmPullRequestCard.js';
import { projectTriageSessionLinkedEntrySummary } from './linkedEntrySummary.js';
import { useTriageSessionLinkCandidates } from './useSessionLinkCandidates.js';
import type { TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';
import { testkitEntryRef, testkitObservation, testkitSnapshot } from '../../corpus/testkit/observations.test-support.js';
import { acquireTriageListWindow, refreshTriageListWindow } from '../../ui/window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from '../../ui/window/ephemeralSharedScope.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { toTriageListWireRows } from '../../projection/listWindowWire.js';
import { TriageListEntriesResultV1Schema } from '../../actions/listEntriesProtocol.js';
import { PluginUiHostApiSurfaceContextV1Schema } from '@happier-dev/protocol/plugins/ui/client';
import { getActionSpec } from '@happier-dev/plugin-sdk/actions';
import { createTriageReadSourceSessionLinksActionHandler } from '../../actions/sessionLinks.js';
import { createTestkitCorpusCollections } from '../../corpus/testkit/corpusCollections.test-support.js';
import { testkitConfiguredInstance, testkitReadOnlySourceSnapshot } from '../testkit/entrySessionTestkit.test-support.js';
import { operationOffers } from '../testkit/sessionPullRequestOperations.test-support.js';

/**
 * The mounted Session cockpit, driven through the real host boundary.
 *
 * Exactly one thing is replaced: the Account Collection transport, which is a
 * genuine system boundary the host installs privately after `renderSurface`
 * returns. Everything above it — the declared static UI query, the private row
 * hydration, the projection and the rendered rows — is the real path.
 *
 * The failures this file exists to catch are the ones a green surface hides: a
 * second query, a Session id taken from anywhere but the mounted target, a
 * hydration read per render, and a durable link that quietly disappears because
 * the entry it names is not stored anywhere.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLUGIN_ID = 'happier.triage';
const SESSION_ID = 'session-cockpit-1';
const navigationFailures: unknown[] = [];
const navigationNotifications: string[] = [];

function linkRow(overrides: Partial<CorpusSessionLinkRowV1> = {}): CorpusSessionLinkRowV1 {
    return {
        linkTag: 'a'.repeat(43),
        entryTag: 'b'.repeat(43),
        sessionId: SESSION_ID,
        linkedAtMs: 1_000,
        entryRef: {
            source: { pluginId: 'happier.example.source', localId: 'example-forge' },
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '42',
        },
        identityEntryRef: {
            source: { pluginId: 'happier.example.source', localId: 'example-forge' },
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '42',
        },
        displayPathAtLink: 'example/repository#42',
        ...overrides,
    };
}

type PagerControl = Readonly<{
    pager: PluginUiCollectionQueryPager;
    publish(snapshot: PluginUiCollectionQuerySnapshot): void;
    loadMoreCalls(): number;
}>;

function createPagerControl(
    initial: PluginUiCollectionQuerySnapshot,
    onLoadMore: ((publish: (snapshot: PluginUiCollectionQuerySnapshot) => void) => Promise<void>) | undefined,
): PagerControl {
    const listeners = new Set<() => void>();
    let current = initial;
    let loadMoreCallCount = 0;
    const publish = (snapshot: PluginUiCollectionQuerySnapshot): void => {
        current = snapshot;
        for (const listener of listeners) listener();
    };
    return {
        pager: {
            getSnapshot: () => current,
            subscribe(listener) {
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            },
            refresh: async () => {},
            loadMore: async () => {
                loadMoreCallCount += 1;
                await onLoadMore?.(publish);
            },
            dispose: () => { listeners.clear(); },
        },
        publish,
        loadMoreCalls: () => loadMoreCallCount,
    };
}

function queryRow(rowId: string, linkedAtMs: number, revision = 1) {
    return {
        context: {
            collection: { pluginId: PLUGIN_ID, collectionId: CORPUS_SESSION_LINKS_COLLECTION_ID },
            rowId,
            revision,
        },
        fields: {
            [CORPUS_SESSION_LINKS_FIELD.sessionId]: SESSION_ID,
            [CORPUS_SESSION_LINKS_FIELD.entryTag]: `${rowId}-entry`,
            [CORPUS_SESSION_LINKS_FIELD.linkedAtMs]: linkedAtMs,
        },
    } as const;
}

type DataHarness = Readonly<{
    client: PluginUiDataClient;
    opened: PluginUiCollectionQueryInput[];
    gets: string[];
    identityRequests: Array<Readonly<{ field: string; components: readonly string[] }>>;
    deletes: Array<Readonly<{ rowId: string; expectedRevision: number }>>;
    control: PagerControl;
    readRelations(): Promise<unknown>;
}>;

function createDataHarness(input: Readonly<{
    snapshot: PluginUiCollectionQuerySnapshot;
    rowsById?: ReadonlyMap<string, CorpusSessionLinkRowV1>;
    failingRowIds?: ReadonlySet<string>;
    deleteFails?: boolean;
    onLoadMore?: (publish: (snapshot: PluginUiCollectionQuerySnapshot) => void) => Promise<void>;
}>): DataHarness {
    const opened: PluginUiCollectionQueryInput[] = [];
    const gets: string[] = [];
    const identityRequests: Array<Readonly<{ field: string; components: readonly string[] }>> = [];
    const deletes: Array<Readonly<{ rowId: string; expectedRevision: number }>> = [];
    const control = createPagerControl(input.snapshot, input.onLoadMore);
    const rowsById = input.rowsById ?? new Map<string, CorpusSessionLinkRowV1>();
    const failingRowIds = input.failingRowIds ?? new Set<string>();

    const client: PluginUiDataClient = {
        collection: () => ({
            async identityTag(request: Readonly<{ field: string; components: readonly string[] }>) {
                identityRequests.push(request);
                return `identity:${JSON.stringify([request.field, ...request.components])}`;
            },
            async get(rowId: string) {
                gets.push(rowId);
                if (failingRowIds.has(rowId)) throw new Error('The Account Collection refused this read.');
                const row = rowsById.get(rowId) ?? [...rowsById.values()].find((candidate) => (
                    rowId === `identity:${JSON.stringify([
                        CORPUS_SESSION_LINKS_FIELD.linkTag,
                        ...sessionLinkTagComponents(candidate.identityEntryRef, candidate.sessionId),
                    ])}`
                ));
                return row === undefined
                    ? null
                    : { rowId, revision: 1, value: toCorpusStoredValue(row) };
            },
            put: async () => { throw new Error('The cockpit never writes Account data.'); },
            async delete(rowId: string, options: Readonly<{ expectedRevision: number }>) {
                if (input.deleteFails === true) throw new Error('The Account Collection refused this delete.');
                deletes.push({ rowId, expectedRevision: options.expectedRevision });
                return { rowId, revision: options.expectedRevision + 1 };
            },
            query: async () => { throw new Error('The cockpit never opens a direct index query.'); },
            batch: async () => { throw new Error('The cockpit never batches Account data.'); },
        }) as ReturnType<PluginUiDataClient['collection']>,
        async openCollectionQuery(request) {
            opened.push(request);
            return control.pager;
        },
        async watchAccountData() { return { dispose() {} }; },
        accountKv: createUnavailablePluginUiAccountKv(),
    };

    return { client, opened, gets, identityRequests, deletes, control,
        async readRelations() {
            const snapshot = control.pager.getSnapshot();
            if (snapshot.status !== 'ready') throw new Error('The relation Action could not read Account state.');
            return { kind: 'complete', links: [...rowsById.values()].map(row => ({
                entryRef: row.entryRef, sessionId: row.sessionId, linkedAtMs: row.linkedAtMs, displayPath: row.displayPathAtLink,
            })), lanes: [] };
        },
    };
}

/** Mirrors the host's post-render private Data binding without widening author context. */
function createCockpitAdapter(
    dataClient: PluginUiDataClient | null,
    sharedScope?: PluginUiEphemeralSharedScope | (() => PluginUiEphemeralSharedScope),
): PluginUiSemanticSurfaceAdapter<typeof renderSessionLinkedEntriesSurface> {
    // Overlays mounted, so the link picker a press opens is observable like the host's.
    const rnwAdapter = createPluginUiRnwSemanticSurfaceAdapter({ overlays: true });
    return {
        async mount(mountInput) {
            function HostedCockpit(context: RenderContext): ReactElement {
                    const scope = typeof sharedScope === 'function' ? sharedScope() : sharedScope;
                    // Model the host's admitted declaration placement while
                    // keeping the real Resource store and transport path.
                    const resourceStore = React.useMemo<PluginUiResourceStore>(() => {
                        const store = createPluginUiResourceStore({ client: createPluginUiHostApiResourceClient(context.hostApi), pluginId: PLUGIN_ID });
                        return { ...store, requiresMachine(resource) {
                            if (typeof resource !== 'string' && 'hostRead' in resource) return false;
                            if (typeof resource !== 'string' && resource.pluginId !== PLUGIN_ID) return true;
                            const localId = typeof resource === 'string' ? resource : resource.localId;
                            return PLUGIN_MANIFEST.contributes.resources.find(declaration => declaration.id === localId)?.execution?.target !== 'account';
                        } };
                    }, [context.hostApi, scope]);
                    React.useEffect(() => () => resourceStore.dispose(), [resourceStore]);
                    return cloneElement(
                        mountInput.surface(context) as ReactElement<{ dataClient?: PluginUiDataClient; ephemeralSharedScope?: PluginUiEphemeralSharedScope; resourceStoreGeneration?: unknown; resourceStore?: PluginUiResourceStore }>,
                        { ...(dataClient === null ? {} : { dataClient }),
                            resourceStore,
                            ...(scope === undefined ? {} : { ephemeralSharedScope: scope, resourceStoreGeneration: scope }) },
                    );
            }
            return await rnwAdapter.mount({
                ...mountInput,
                surface: context => React.createElement(HostedCockpit, context),
            });
        },
    };
}

const mounted: PluginUiTestkit[] = [];
type ActionCall = Readonly<{ action: string; input: unknown }>;
const actionCalls: ActionCall[] = [];
type SurfaceOpen = Readonly<{ view: unknown; input?: unknown; subPath?: string }>;
const surfaceOpens: SurfaceOpen[] = [];

/**
 * The one Action the cockpit can invoke, scripted per test.
 *
 * `null` keeps the original behaviour — any dispatch is a failure — which is
 * what the read-only cases still assert. A scripted result stands in for the
 * host Action boundary so a press can be followed all the way through.
 */
async function mountCockpit(
    harness: DataHarness,
    target: ReturnType<typeof createSurfaceContextFixture>['target'],
    unlinkResult: unknown = null,
    accountReachable = true,
    openSurfaceError: unknown = null,
    statusFixture?: Readonly<{ scope: PluginUiEphemeralSharedScope; readStatus: () => Promise<TriagePullRequestStatusV1> }>,
    sourceOccurrencePresent = true,
    listEntries?: () => Promise<unknown>,
    sourceLinks?: () => Promise<unknown>,
    sourceScope?: () => PluginUiEphemeralSharedScope,
    machinePending = false,
    observeResource = false,
    surface = renderSessionLinkedEntriesSurface,
    executeUnlink?: (input: unknown) => Promise<unknown>,
): Promise<PluginUiTestkit> {
    let fixture!: PluginUiTestkit;
    let resourceReady: ((digest: string) => void) | undefined;
    const firstResource = new Promise<string>(resolve => { resourceReady = resolve; });
    const readRelations = async () => {
        actionCalls.push({ action: 'sessions/read-source-links-v1', input: { v: 1, sessionId: 'sessionId' in target ? target.sessionId : SESSION_ID } });
        const result = TriageReadSourceSessionLinksResultV1Schema.parse(await (sourceLinks ?? harness.readRelations)());
        return result.lanes !== undefined && result.lanes.length > 0 ? result : { ...result, lanes: [{
            source: linkRow().entryRef.source, sourceInstanceId: '11111111-1111-4111-8111-111111111111', displayLabel: 'Example forge',
            kindIds: ['pull-request', 'merge-request', 'issue', 'dependency-finding', 'scan-finding'],
            health: result.kind === 'complete' ? { kind: 'complete' as const } : { kind: 'unavailable' as const },
        }] };
    };
    const surfaceContext = createSurfaceContextFixture({
        ...(machinePending ? { machineConnectionPending: true, machineExecutionReady: false } : {}),
        mount: {
            kind: 'destination',
            destination: { pluginId: PLUGIN_ID, localId: 'session-linked-entries' },
            container: 'rightSidebarTab',
        },
        target,
        targetedContributions: {
            ...createSurfaceContextFixture().targetedContributions!,
            points: [{ pointId: 'sources', protocols: [{ protocol: { id: 'happier.triage/sources', version: 1 },
                contributions: [{
                    contributor: { pluginId: 'happier.example.source', contributionId: 'example-forge',
                        occurrenceId: 'example-forge-1', sourceCustody: { kind: 'development', registeredRootId: 'example-root' } },
                    protocol: { id: 'happier.triage/sources', version: 1 },
                    descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example forge',
                        kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' },
                            { id: 'merge-request', workflowSubject: 'pullRequest', displayName: 'Merge request' },
                            { id: 'dependency-finding', workflowSubject: 'errorIssue', displayName: 'Dependency finding' },
                            { id: 'scan-finding', workflowSubject: 'errorIssue', displayName: 'Scanning finding' },
                            { id: 'issue', workflowSubject: 'issue', displayName: 'Issue' }] },
                    operations: sourceLinks === undefined ? [] : ['readSessionLinks', 'linkSession'].map((role) => ({
                        point: { pointId: 'sources', protocol: { id: 'happier.triage/sources', version: 1 } },
                        contributor: { pluginId: 'happier.example.source', contributionId: 'example-forge',
                            occurrenceId: 'example-forge-1', sourceCustody: { kind: 'development', registeredRootId: 'example-root' } },
                        role, action: { pluginId: 'happier.example.source', localId: role === 'linkSession' ? 'link-session' : 'read-session-links' },
                    })), surfaces: [],
                }],
            }] }],
        },
    });
    if (!sourceOccurrencePresent) delete surfaceContext.targetedContributions;
    const admittedContext = PluginUiHostApiSurfaceContextV1Schema.safeParse(surfaceContext);
    if (!admittedContext.success) throw new Error(JSON.stringify(admittedContext.error));
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-165', mountNonce: 'fixture-mount-165' },
            authorPlugin: { id: PLUGIN_ID, version: '0.0.0' },
            surface,
            surfaceContext,
            adapter: createCockpitAdapter(accountReachable ? harness.client : null, sourceScope ?? statusFixture?.scope),
            handlers: {
                confirm: async () => true,
                presentActionFailure: async ({ failure }) => { navigationFailures.push(failure); return { reason: 'Cannot open', nextStep: 'Try again', technicalDetails: [
                    { key: 'code', label: 'Code', value: failure.errorCode },
                    { key: 'requestId', label: 'Request ID', value: failure.requestId ?? '' },
                ] }; },
                notify: async ({ message }) => { navigationNotifications.push(message); },
                // Direct Account writes use the host's Action admission boundary.
                admitAction: async () => true,
                readResource: async ({ resource }) => {
                    const localId = typeof resource === 'string' ? resource : 'localId' in resource ? resource.localId : null;
                    if (localId === 'session-pull-request-status-v1') {
                        if (statusFixture === undefined) throw new Error('This mount scripts no PR status demand.');
                        actionCalls.push({ action: 'resources/session-pull-request-status-v1', input: {} });
                        const status = await statusFixture.readStatus();
                        const bytes = new TextEncoder().encode(JSON.stringify({ kind: 'ready',
                            sessionId: 'sessionId' in target ? target.sessionId : SESSION_ID,
                            pullRequests: [{ bindingId: 'binding-1', revision: 1,
                                link: { provider: 'github', repository: 'example/repository', number: 42,
                                    url: 'https://github.com/example/repository/pull/42' },
                                watch: { policy: { mode: 'notify', archiveAfterMerge: false },
                                    reason: null, fixAttemptLimit: 3, roundsStarted: 0, watchingMachine: null }, latestUpdate: null,
                                nativeStatus: { kind: 'current', value: status, checkedAtMs: status.observedAtMs } }],
                        }));
                        return { contentType: 'application/json', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes };
                    }
                    const text = await TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME.read(createTestResourceInvocationContext({
                        context: { kind: 'session', sessionId: 'sessionId' in target ? target.sessionId : SESSION_ID },
                        signal: new AbortController().signal,
                        readAction: async () => ({ ok: true, result: await readRelations() }),
                    }));
                    const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
                    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
                    resourceReady?.(digest);
                    return { contentType: 'application/json', digest, bytes };
                },
                ...(observeResource ? { watchResource: async () => ({ digest: await firstResource }) } : {}),
                executeAction: async ({ action, input }) => {
                    actionCalls.push({ action: String(action), input });
                    if (String(action) === 'sessions/unlink-entry-v1' && executeUnlink !== undefined) return await executeUnlink(input) as never;
                    if (String(action) === 'sessions/read-source-links-v1') {
                        return await (sourceLinks ?? harness.readRelations)() as never;
                    }
                    if (listEntries !== undefined && String(action) === 'entries/list-v1') {
                        return await listEntries() as never;
                    }
                    if (unlinkResult === null) {
                        throw new Error('This mount scripts no host Action.');
                    }
                    if (unlinkResult instanceof Error) throw unlinkResult;
                    return unlinkResult as never;
                },
                openSurface: async ({ view, input, subPath }) => {
                    surfaceOpens.push({ view, ...(input === undefined ? {} : { input }), ...(subPath === undefined ? {} : { subPath }) });
                    if (openSurfaceError !== null) throw openSurfaceError;
                },
            },
        });
    });
    mounted.push(fixture);
    // Let the query open and the first hydration wave settle.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    return fixture;
}

afterEach(async () => {
    actionCalls.splice(0);
    surfaceOpens.splice(0);
    navigationFailures.splice(0);
    navigationNotifications.splice(0);
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

/** Round 2 (lab `plugin-tabs` P1/PP): a linked row opens in place; its actions sit at the bottom of the open row. */
async function openRow(fixture: PluginUiTestkit, name: string): Promise<void> {
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name })); });
    await act(async () => { await Promise.resolve(); });
}

describe('expanded PR status from the exact linked source observation', () => {
    describe('createdHere PR linking', () => {
        function createdPullRequestFixture(options: Readonly<{ failFirst?: boolean; project?: boolean; initialRead?: Promise<void>; initialAttach?: Promise<void> }> = {}) {
            const url = 'https://github.com/acme/widgets/pull/42';
            const calls: unknown[] = [];
            let linked = false;
            let reads = 0;
            const signal = new AbortController().signal;
            const surface = defineUiSurface(() => <TriageScmPullRequestCard signal={signal} launchInput={{
                homeServerId: 'home-1', origin: 'createdHere', pullRequest: {
                    provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'acme/widgets' },
                    number: 42, url, title: 'Created PR', headBranch: 'topic', baseBranch: 'main', state: 'open',
                },
            }} />);
            const mount = async () => {
                const fixture = await createPluginUiTestkit({
                    identity: { instanceId: `created-pr-${reads}`, mountNonce: `created-pr-nonce-${reads}` },
                    authorPlugin: { id: PLUGIN_ID, version: '0.0.0' }, surface,
                    surfaceContext: createSurfaceContextFixture({
                        target: options.project ? { kind: 'app' } : { kind: 'session', sessionId: SESSION_ID, agentId: 'codex' },
                        accountScope: { serverId: 'home-1', accountId: 'viewer-1' },
                    }),
                    adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {
                        readResource: async () => {
                            reads += 1;
                            if (reads === 1) await options.initialRead;
                            return { contentType: 'application/json', digest: `sha256:${(linked ? 'b' : 'a').repeat(64)}`,
                                bytes: new TextEncoder().encode(JSON.stringify({ kind: 'ready', sessionId: SESSION_ID,
                                    pullRequests: linked ? [{ bindingId: 'binding-42', revision: 1,
                                        link: { provider: 'github', repository: 'acme/widgets', number: 42, url },
                                        watch: { policy: { mode: 'off', archiveAfterMerge: false }, reason: null,
                                            fixAttemptLimit: 3, roundsStarted: 0, watchingMachine: null }, latestUpdate: null,
                                        nativeStatus: { kind: 'unavailable', failure: { class: 'transient', code: 'offline' } },
                                    }] : [],
                                })) };
                        },
                        executeAction: async ({ action, input }) => {
                            if (action === 'plugins.settings.list') return getActionSpec(action).outputSchema.parse({
                                ok: true, kind: action, data: {
                                    scope: { kind: 'account' }, target: { kind: 'account' }, revision: 'settings-1',
                                    fields: [
                                        { localId: 'pr-watch-default-mode', secret: false, value: 'off' },
                                        { localId: 'pr-watch-fix-attempt-limit', secret: false, value: 3 },
                                        { localId: 'pr-watch-archive-after-merge', secret: false, value: false },
                                    ],
                                },
                            });
                            calls.push({ action, input });
                            if (options.failFirst && calls.length === 1) throw new Error('Attach unavailable');
                            await options.initialAttach;
                            linked = true;
                            return { kind: 'attached', bindingId: 'binding-42' };
                        },
                    },
                });
                mounted.push(fixture);
                await act(async () => { await Promise.resolve(); });
                return fixture;
            };
            return { mount, calls, url, reads: () => reads };
        }

        it('attaches the exact Session and URL once per createdHere mount before reads settle and retains the link after remount', async () => {
            let settleRead!: () => void;
            let settleAttach!: () => void;
            const scenario = createdPullRequestFixture({
                initialRead: new Promise<void>(resolve => { settleRead = resolve; }),
                initialAttach: new Promise<void>(resolve => { settleAttach = resolve; }),
            });
            const first = await scenario.mount();
            // A createdHere intent goes straight to Channels; PR reads do not admit attachment.
            expect(scenario.calls).toEqual([{ action: { pluginId: 'happier.channels', localId: 'session-pull-request-binding-v1' },
                input: { kind: 'attach', sessionId: SESSION_ID, pullRequestUrl: scenario.url } }]);
            // A PR created here is an intent to link, never presented as an unwatched branch hint.
            await expect(first.getByText('Created from this session. Linking it here…')).resolves.toBeDefined();
            await expect(first.queryByText('Branch hint')).resolves.toBeUndefined();
            await act(async () => { settleRead(); settleAttach(); });
            expect(scenario.calls).toHaveLength(1);
            await expect(first.queryByRole('button', { name: 'Link this PR' })).resolves.toBeUndefined();
            await act(async () => { await first.dispose(); });
            mounted.splice(mounted.indexOf(first), 1);
            const remounted = await scenario.mount();
            await expect(remounted.getByText('Not watching')).resolves.toBeDefined();
            await expect(remounted.queryByRole('button', { name: 'Link this PR' })).resolves.toBeUndefined();
            // A cold createdHere mount repeats the intent before its read can
            // reveal the link. Channels rejoins the retained binding-42.
            expect(scenario.calls).toEqual(Array.from({ length: 2 }, () => ({
                action: { pluginId: 'happier.channels', localId: 'session-pull-request-binding-v1' },
                input: { kind: 'attach', sessionId: SESSION_ID, pullRequestUrl: scenario.url },
            })));
        });

        it('renders a failed automatic attach and retries only when Link is pressed', async () => {
            const scenario = createdPullRequestFixture({ failFirst: true });
            const fixture = await scenario.mount();
            await expect(fixture.getByText('Couldn’t link this PR. The branch and the session are unchanged.')).resolves.toBeDefined();
            expect(scenario.calls).toHaveLength(1);
            await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Link this PR' })); });
            expect(scenario.calls).toHaveLength(2);
            await expect(fixture.queryByRole('button', { name: 'Link this PR' })).resolves.toBeUndefined();
        });

        it('keeps a createdHere Project hint manual without an exact Session', async () => {
            const scenario = createdPullRequestFixture({ project: true });
            const fixture = await scenario.mount();
            await expect(fixture.findByRole('button', { name: 'Link to a session…' })).resolves.toBeDefined();
            expect(scenario.calls).toEqual([]);
            expect(scenario.reads()).toBe(0);
        });
    });

    it('offers one-click Link for a Session branch hint and never auto-links it', async () => {
        const calls: unknown[] = [];
        const signal = new AbortController().signal;
        const surface = defineUiSurface(() => <TriageScmPullRequestCard signal={signal} launchInput={{ homeServerId: 'home-1', pullRequest: {
            provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'acme/widgets' },
            number: 42, url: 'https://github.com/acme/widgets/pull/42', title: 'Branch PR', headBranch: 'topic', baseBranch: 'main', state: 'open',
        } }} />);
        const fixture = await createPluginUiTestkit({
            identity: { instanceId: 'session-branch-link', mountNonce: 'session-branch-link-nonce' },
            authorPlugin: { id: PLUGIN_ID, version: '0.0.0' }, surface,
            surfaceContext: createSurfaceContextFixture({ target: { kind: 'session', sessionId: SESSION_ID, agentId: 'codex' },
                accountScope: { serverId: 'home-1', accountId: 'viewer-1' } }),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {
                readResource: () => ({ contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
                    bytes: new TextEncoder().encode(JSON.stringify({ kind: 'ready', sessionId: SESSION_ID, pullRequests: [] })) }),
                executeAction: ({ action, input }) => { calls.push({ action, input }); return { kind: 'attached', bindingId: 'binding-42' }; },
            },
        });
        mounted.push(fixture);
        const link = await fixture.findByRole('button', { name: 'Link this PR' });
        expect(calls).toEqual([]);
        await act(async () => { await fixture.press(link); });
        expect(calls).toEqual([{ action: { pluginId: 'happier.channels', localId: 'session-pull-request-binding-v1' },
            input: { kind: 'attach', sessionId: SESSION_ID, pullRequestUrl: 'https://github.com/acme/widgets/pull/42' } }]);
    });

    it('renders linked merged PRs without a snapshot hint and never attaches on mount', async () => {
        let reads = 0;
        const calls: unknown[] = [];
        const surface = defineUiSurface(() => <TriageScmPullRequestCard
            launchInput={{ homeServerId: 'home-1' }} signal={new AbortController().signal} />);
        const fixture = await createPluginUiTestkit({
            identity: { instanceId: 'no-branch-hint', mountNonce: 'no-branch-hint-nonce' },
            authorPlugin: { id: PLUGIN_ID, version: '0.0.0' }, surface,
            surfaceContext: createSurfaceContextFixture({ target: { kind: 'session', sessionId: SESSION_ID, agentId: 'codex' },
                accountScope: { serverId: 'home-1', accountId: 'viewer-1' } }),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {
                readResource: () => {
                    reads += 1;
                    return { contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
                        bytes: new TextEncoder().encode(JSON.stringify({ kind: 'ready', sessionId: SESSION_ID,
                            pullRequests: [7, 8].map(number => ({ bindingId: `binding-${number}`, revision: 1,
                                link: { provider: 'github', repository: 'acme/widgets', number, url: `https://github.com/acme/widgets/pull/${number}`, state: 'merged' },
                                watch: { policy: { mode: 'notify', archiveAfterMerge: false }, reason: null, fixAttemptLimit: 3, roundsStarted: 0, watchingMachine: null },
                                latestUpdate: null, nativeStatus: { kind: 'current', checkedAtMs: 200, value: {
                                    kind: 'status', observedAtMs: 100, title: `Completed PR ${number}`, checks: null, review: null,
                                    merge: null, branch: null, facts: [] } },
                            })) })) };
                },
                executeAction: ({ action, input }) => { calls.push({ action, input }); throw new Error('No write expected'); },
            },
        });
        mounted.push(fixture);
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.getByText('Completed PR 7')).resolves.toBeDefined();
        await expect(fixture.queryByText('Completed PR 8')).resolves.toBeUndefined();
        await act(async () => { await fixture.press(await fixture.findByRole('radio', { name: '#8' })); });
        await expect(fixture.getByText('Completed PR 8')).resolves.toBeDefined();
        await expect(fixture.queryByText('Completed PR 7')).resolves.toBeUndefined();
        expect(reads).toBe(1);
        expect(calls).toEqual([]);
    });
    it('keeps Project branch hints cold and links the detected URL only after exact Session choice', async () => {
        const url = 'https://github.com/acme/widgets/pull/42';
        const calls: unknown[] = [];
        let reads = 0;
        const signal = new AbortController().signal;
        const surface = defineUiSurface(() => <TriageScmPullRequestCard signal={signal} launchInput={{ homeServerId: 'home-1', pullRequest: {
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'acme/widgets' },
                number: 42, url, title: 'Detected PR', baseBranch: 'main', headBranch: 'topic', state: 'open', checks: { state: 'pending' },
            } }} />);
        const fixture = await createPluginUiTestkit({
            identity: { instanceId: 'project-pr-link', mountNonce: 'project-pr-link-nonce' },
            authorPlugin: { id: PLUGIN_ID, version: '0.0.0' }, surface,
            surfaceContext: createSurfaceContextFixture({ target: { kind: 'app' }, accountScope: { serverId: 'home-1', accountId: 'viewer-1' } }),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {
                readResource: () => { reads += 1; throw new Error('Project-only branch discovery cannot acquire Session status'); },
                selectActionInput: ({ request }) => {
                    calls.push(request);
                    return { kind: 'sessionAddress', session: { serverId: 'home-1', sessionId: 'chosen-session' } };
                },
                executeAction: ({ action, input }) => {
                    calls.push({ action, input });
                    return { kind: 'attached', bindingId: 'binding-1' };
                },
            },
        });
        mounted.push(fixture);
        await expect(fixture.getByText('Detected PR')).resolves.toBeDefined();
        expect(calls).toEqual([]);
        expect(reads).toBe(0);
        await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Link to a session…' })); });
        expect(calls).toEqual([
            { hostAction: { action: 'session.transcript.get', projection: 'sessionAddress' } },
            { action: { pluginId: 'happier.channels', localId: 'session-pull-request-binding-v1' },
                input: { kind: 'attach', sessionId: 'chosen-session', pullRequestUrl: url } },
        ]);
        expect(reads).toBe(0);
    });

    it('shares one demanded Session Resource across linked PR presentations without a legacy Action read', async () => {
        const url = 'https://github.com/acme/widgets/pull/42';
        const observation = testkitObservation({ entryRef: linkRow().entryRef, outcome: {
            kind: 'present', locator: { v: 1, displayPath: 'acme/widgets#42', webUrl: url },
            snapshot: testkitSnapshot(), viewer: { involvement: [] },
        } });
        const row = foldTriageListWindow({ observations: [observation], lanes: [],
            activeSourceInstanceIds: [observation.sourceInstanceId], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: observation.observedAtMs }).rows[0]!;
        const entry = projectTriageSessionLinkedEntrySummary(row, 'pullRequest');
        let resourceReads = 0;
        let legacyReads = 0;
        let rowRenders = 0;
        let resourceError: unknown;
        let releaseRefresh: (() => void) | undefined;
        const snapshot = { kind: 'ready', sessionId: SESSION_ID, pullRequests: [{
            bindingId: 'binding-1', revision: 1,
            link: { provider: 'github', repository: 'acme/widgets', number: 42, url },
            watch: { policy: { mode: 'notify', archiveAfterMerge: false },
                reason: null, fixAttemptLimit: 3, roundsStarted: 0, watchingMachine: null },
            latestUpdate: null,
            nativeStatus: { kind: 'current', checkedAtMs: 200, value: {
                kind: 'status', observedAtMs: 100, checks: null, review: null, merge: null, branch: null, facts: [],
            } },
        }] };
        const RowStatus = () => {
            rowRenders += 1;
            const first = useLinkedPullRequestStatus(entry, true, 0);
            return <Text value={`row:${first.phase}`} />;
        };
        const ScmStatus = () => {
            const second = useTriageScmPullRequestCardV1({ homeServerId: 'home-1', pullRequest: {
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'acme/widgets' },
                number: 42, url, title: 'Shared PR', baseBranch: 'main', headBranch: 'topic', state: 'open', checks: { state: 'pending' },
            } });
            resourceError = second.resource.error;
            return <><Text value={`card:${second.cards[0]?.kind === 'bound' ? 'ready' : 'unavailable'}`} />
                <Button title="Refresh shared PR" onPress={() => { void second.refresh(); }} /></>;
        };
        const surface = defineUiSurface(() => <><RowStatus /><ScmStatus /></>);
        const fixture = await createPluginUiTestkit({
            identity: { instanceId: 'shared-status-read', mountNonce: 'shared-status-read-nonce' },
            authorPlugin: { id: PLUGIN_ID, version: '0.0.0' }, surface,
            surfaceContext: createSurfaceContextFixture({ target: { kind: 'session', sessionId: SESSION_ID, agentId: 'codex' } }),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: {
                readResource: async ({ resource }) => {
                    expect(resource).toEqual({ pluginId: PLUGIN_ID, localId: 'session-pull-request-status-v1' });
                    resourceReads += 1;
                    if (resourceReads > 1) await new Promise<void>(resolve => { releaseRefresh = resolve; });
                    return { contentType: 'application/json', digest: `sha256:${(resourceReads === 1 ? 'a' : 'b').repeat(64)}`,
                        bytes: new TextEncoder().encode(JSON.stringify(snapshot)) };
                },
                watchResource: () => ({ digest: `sha256:${'a'.repeat(64)}` }),
                executeAction: () => { legacyReads += 1; throw new Error('The retired per-hook PR loader must not run.'); },
            },
        });
        mounted.push(fixture);
        await act(async () => { await Promise.resolve(); });
        expect(resourceError).toBeUndefined();
        await expect(fixture.getByText('row:ready')).resolves.toBeDefined();
        await expect(fixture.getByText('card:ready')).resolves.toBeDefined();
        expect(resourceReads).toBe(1);
        expect(legacyReads).toBe(0);
        const admittedRenders = rowRenders;
        await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Refresh shared PR' })); });
        expect(resourceReads).toBe(2);
        await expect(fixture.getByText('row:ready')).resolves.toBeDefined();
        expect(rowRenders).toBe(admittedRenders);
        snapshot.pullRequests[0]!.nativeStatus.checkedAtMs = 300;
        await act(async () => { releaseRefresh?.(); await Promise.resolve(); });
        await expect(fixture.getByText('row:ready')).resolves.toBeDefined();
        expect(rowRenders).toBe(admittedRenders);
        expect(legacyReads).toBe(0);
    });

    it('stays cold without an exact mounted Session or canonical PR URL', async () => {
        const observation = testkitObservation({ entryRef: linkRow().entryRef, outcome: {
            kind: 'present', locator: { v: 1, displayPath: 'example/repository#42' },
            snapshot: testkitSnapshot(), viewer: { involvement: [] },
        } });
        const row = foldTriageListWindow({ observations: [observation], lanes: [],
            activeSourceInstanceIds: [observation.sourceInstanceId], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: observation.observedAtMs }).rows[0]!;
        const entry = projectTriageSessionLinkedEntrySummary(row, 'pullRequest');
        expect(entry?.detailSource).toBeTruthy();
        let reads = 0;
        const initial = { ...createSurfaceContextFixture(), machineConnectionPending: true, machineExecutionReady: false };
        const surface = defineUiSurface(() => <Text value={useLinkedPullRequestStatus(entry, true, 0).phase} />);
        const fixture = await createPluginUiTestkit({ identity: { instanceId: 'status-read', mountNonce: 'status-read-nonce' },
            authorPlugin: { id: PLUGIN_ID, version: '0.0.0' }, surface, surfaceContext: initial,
            adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {
                readResource: () => { reads += 1; throw new Error('No exact Session/URL means no demand.'); },
                executeAction: () => { throw new Error('The legacy per-row Action reader is retired.'); },
            },
        });
        mounted.push(fixture);
        await expect(fixture.getByText('idle')).resolves.toBeDefined();
        await act(async () => { await fixture.updateSurface({ ...initial, machineConnectionPending: false, machineExecutionReady: true }); });
        await expect(fixture.getByText('idle')).resolves.toBeDefined();
        expect(reads).toBe(0);
    });

    it('keeps source-declared findings visible and openable without reading PR status', async () => {
        const scope = createTriageEphemeralSharedScopeFixture();
        const rows = ['dependency-finding', 'scan-finding'].map((kindId, index) => {
            const ref = { ...linkRow().entryRef, kindId };
            return linkRow({ entryRef: ref, identityEntryRef: ref, displayPathAtLink: `Finding ${index + 1}` });
        });
        const observations = rows.map((link, index) => testkitObservation({ entryRef: link.entryRef, outcome: {
            kind: 'present', locator: { v: 1, displayPath: link.displayPathAtLink, routingToken: 'exact-route' },
            snapshot: testkitSnapshot({ title: `Finding ${index + 1}`, state: { presentation: 'suppressed', nativeLabel: 'Dismissed' } }),
            viewer: { involvement: [] },
        } }));
        const sourceInstanceId = observations[0]!.sourceInstanceId;
        const response = TriageListEntriesResultV1Schema.parse({ v: 1, configuredSourcesStatus: 'complete',
            configuredSources: [{ sourceInstanceId, configurationRowId: sourceInstanceId, source: rows[0]!.entryRef.source, available: true }],
            window: { v: 1, assembledAtMs: observations[0]!.observedAtMs, coverage: 'complete',
                lanes: [{ sourceInstanceId, source: rows[0]!.entryRef.source, health: { kind: 'walkFinished' }, exhausted: true }],
                rows: toTriageListWireRows(foldTriageListWindow({ observations, lanes: [], activeSourceInstanceIds: [sourceInstanceId],
                    configuredSourcesStatus: 'complete', lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: observations[0]!.observedAtMs })),
            } });
        const seedHost = { executeAction: async () => response };
        const lease = acquireTriageListWindow(seedHost, scope);
        await refreshTriageListWindow('manual', seedHost, scope);
        lease.release();
        const harness = createDataHarness({ snapshot: { status: 'ready', rows: rows.map((row, index) => queryRow(`finding-${index}`, row.linkedAtMs)) },
            rowsById: new Map(rows.map((row, index) => [`finding-${index}`, row])) });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID }, null, true, null,
            { scope, readStatus: async () => { throw new Error('Finding must not read PR status'); } });
        await expect(fixture.getByText('Finding 1')).resolves.toBeDefined();
        await expect(fixture.getByText('Finding 2')).resolves.toBeDefined();
        await openRow(fixture, 'Finding 1');
        expect(actionCalls.filter((call) => call.action === 'entries/read-pull-request-status-v1')).toHaveLength(0);
        await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Open' })); });
        expect(surfaceOpens).toEqual([expect.objectContaining({ view: TRIAGE_ENTRY_DETAIL_DESTINATION_V1 })]);
        expect(parseTriageRouteSubPathV1(surfaceOpens[0]?.subPath).selection).toEqual(rows[0]!.entryRef);
    });

    it('loads only on expansion and retains source facts across collapse and failed refresh, then recovers', async () => {
        const scope = createTriageEphemeralSharedScopeFixture();
        const link = linkRow();
        const observation = testkitObservation({ entryRef: link.entryRef, outcome: {
            kind: 'present',
            locator: { v: 1, displayPath: link.displayPathAtLink, routingToken: 'exact-route', webUrl: 'https://github.com/example/repository/pull/42' },
            snapshot: testkitSnapshot({ title: 'Key settings modals by route' }),
            viewer: { involvement: [] },
        } });
        const seedHost = { executeAction: async () => ({
            v: 1, configuredSourcesStatus: 'complete',
            configuredSources: [{ sourceInstanceId: observation.sourceInstanceId, configurationRowId: observation.sourceInstanceId, source: link.entryRef.source, available: true }],
            window: { v: 1, assembledAtMs: observation.observedAtMs, coverage: 'complete',
                lanes: [{ sourceInstanceId: observation.sourceInstanceId, source: link.entryRef.source, health: { kind: 'walkFinished' }, exhausted: true }],
                rows: toTriageListWireRows(foldTriageListWindow({
                    observations: [observation], lanes: [], activeSourceInstanceIds: [observation.sourceInstanceId],
                    configuredSourcesStatus: 'complete', lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: observation.observedAtMs,
                })),
            },
        }) };
        TriageListEntriesResultV1Schema.parse(await seedHost.executeAction());
        const lease = acquireTriageListWindow(seedHost, scope);
        await refreshTriageListWindow('manual', seedHost, scope);
        lease.release();
        const status: TriagePullRequestStatusV1 = {
            kind: 'status', observedAtMs: observation.observedAtMs,
            checks: { state: 'complete', passed: 9, failed: 1, pending: 0, total: 10, incomplete: false,
                rows: [{ id: 'web', name: 'ui-tests (web)', state: 'failed' },
                    ...Array.from({ length: 9 }, (_, index) => ({ id: `unit-${index}`, name: `unit-tests ${index}`, state: 'passed' as const }))] },
            review: { decision: 'changesRequested', incomplete: false,
                reviewers: [{ id: 'user:ana', name: 'Ana', verb: 'changesRequested' }, { id: 'user:jonas', name: 'Jonas', verb: 'pending' }] },
            merge: { state: 'blocked', blocker: 'Blocked by the failing check and required review' },
            operations: { ...operationOffers, readiness: 'blocked' },
            branch: { head: 'fix/settings-remount', base: 'main', additions: 48, deletions: 12 }, facts: [],
        };
        const harness = createDataHarness({
            snapshot: { status: 'ready', rows: [queryRow('link-pr', link.linkedAtMs)] },
            rowsById: new Map([['link-pr', link]]),
        });
        let currentStatus = status;
        let readFails = false;
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID }, null, true, null, { scope, readStatus: async () => {
            if (readFails) throw new Error('The source is temporarily unavailable.');
            return currentStatus;
        } }, true, undefined, async () => ({ kind: 'partial', links: [{
            entryRef: link.entryRef, sessionId: SESSION_ID, linkedAtMs: link.linkedAtMs, displayPath: link.displayPathAtLink,
        }] }));
        expect(actionCalls.filter((call) => call.action === 'entries/read-pull-request-status-v1')).toEqual([]);
        await openRow(fixture, 'Key settings modals by route');
        await expect(fixture.getByText('ui-tests (web)')).resolves.toBeDefined();
        await expect(fixture.getByText('Ana')).resolves.toBeDefined();
        // The shared PR facts name who decided the review (Ana); a reviewer still pending is not a decision.
        await expect(fixture.getByText(status.merge!.blocker!)).resolves.toBeDefined();
        await expect(fixture.getByText('fix/settings-remount')).resolves.toBeDefined();
        await expect(fixture.getByText('+48')).resolves.toBeDefined();
        await expect(fixture.getByText('−12')).resolves.toBeDefined();
        await expect(fixture.getByText('9/10')).resolves.toBeDefined();
        const calls = actionCalls.filter((call) => call.action === 'resources/session-pull-request-status-v1');
        expect(calls).toHaveLength(1);
        expect(actionCalls.filter((call) => call.action === 'entries/read-pull-request-status-v1')).toEqual([]);
        await openRow(fixture, 'Key settings modals by route');
        await openRow(fixture, 'Key settings modals by route');
        await expect(fixture.getByText('ui-tests (web)')).resolves.toBeDefined();
        expect(actionCalls.filter((call) => call.action === 'resources/session-pull-request-status-v1')).toHaveLength(2);
        readFails = true;
        // The incomplete relationship read and status recovery use the same Refresh control.
        await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Refresh' })); });
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.getByText('PR status is unavailable.')).resolves.toBeDefined();
        await expect(fixture.getByText('ui-tests (web)')).resolves.toBeDefined();
        await expect(fixture.getByText('9/10')).resolves.toBeDefined();
        const anaNameNode = [...document.querySelectorAll<HTMLElement>('*')]
            .find((node) => node.textContent === 'Ana' && node.children.length === 0);
        expect(anaNameNode).toBeDefined();
        readFails = false;
        currentStatus = { ...status, checks: { ...status.checks!, passed: 10, failed: 0,
            rows: status.checks!.rows.map((check) => ({ ...check, state: 'passed' as const })) },
            review: { ...status.review!, reviewers: [...status.review!.reviewers].reverse() } };
        // The query failure line and status recovery use the same existing refresh owner.
        const refreshButtons = (await fixture.queryAllByRole('button')).filter((button) => button.name === 'Refresh');
        await act(async () => { await fixture.press(refreshButtons.at(-1)!); });
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.getByText('10/10')).resolves.toBeDefined();
        await expect(fixture.queryByText('PR status is unavailable.')).resolves.toBeUndefined();
        // Reordering source-native reviewers must preserve their mounted rows.
        expect(document.body.contains(anaNameNode!)).toBe(true);
    });
});

async function unlinkThroughSharedPolicy(fixture: PluginUiTestkit, name: string): Promise<void> {
    await openRow(fixture, name);
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: `Unlink ${name}` })); });
    await act(async () => { await Promise.resolve(); });
}

describe('the Session tab, round 2', () => {
    it.each([true, false])('retains linked rows with a source occurrence present: %s', async (sourceOccurrencePresent) => {
        const issueRef = {
            source: { pluginId: 'happier.example.source', localId: 'example-forge' },
            kindId: 'issue',
            collisionScope: 'example/repository',
            entryId: '7',
        } as const;
        const harness = createDataHarness({
            snapshot: { rows: [queryRow('link-a', 2_000), queryRow('link-b', 1_000)], hasMore: false, status: 'ready' },
            rowsById: new Map([
                ['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })],
                ['link-b', linkRow({ displayPathAtLink: 'example/repository#7', entryRef: issueRef, identityEntryRef: issueRef })],
            ]),
        });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID }, null, true, null, undefined, sourceOccurrencePresent);

        await expect(fixture.findByRole('button', { name: 'example/repository#42' })).resolves.toBeDefined();
        await expect(fixture.findByRole('button', { name: 'example/repository#7' })).resolves.toBeDefined();
        if (sourceOccurrencePresent) {
            await expect(fixture.getByText('Pull requests')).resolves.toBeDefined();
            await expect(fixture.getByText('Issues')).resolves.toBeDefined();
        } else {
            await expect(fixture.getByText('Other links')).resolves.toBeDefined();
            expect(await fixture.queryByText('Pull requests')).toBeUndefined();
            expect(await fixture.queryByText('Issues')).toBeUndefined();
        }
        // Rows are not a list of Unlink buttons any more: removing a link is one step down, in the open row.
        expect((await fixture.queryAllByRole('button')).filter((button) => button.name === 'Unlink')).toHaveLength(0);
    });

    it('opens a linked row in place and submits Unlink through the shared Action policy without a second local step', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [queryRow('link-a', 2_000)], hasMore: false, status: 'ready' },
            rowsById: new Map([['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })]]),
        });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID }, { v: 1, status: 'unlinked' });

        await openRow(fixture, 'example/repository#42');
        // Pressing the row opened it; it did not navigate.
        expect(surfaceOpens).toHaveLength(0);
        await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Open' })); });
        await act(async () => { await Promise.resolve(); });
        expect(surfaceOpens[0]).toMatchObject({ view: TRIAGE_ENTRY_DETAIL_DESTINATION_V1 });

        await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Unlink example/repository#42' })); });
        await act(async () => { await Promise.resolve(); });
        expect(actionCalls.filter(call => call.action === 'sessions/unlink-entry-v1')).toHaveLength(1);
        expect(harness.deletes).toHaveLength(0);
    });
});

describe('the mounted Session cockpit', () => {
    it('discloses the original whole-read failure and request identity', async () => {
        const harness = createDataHarness({ snapshot: { status: 'ready', rows: [], hasMore: false } });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID },
            null, true, null, undefined, true, undefined, async () => {
                throw new PluginError({ code: 'session_relations_unavailable', retryable: false,
                    details: { requestId: 'whole-read-request-1' } });
            });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Details' })); });
        await expect(fixture.getByText('session_relations_unavailable')).resolves.toBeDefined();
        await expect(fixture.getByText('whole-read-request-1')).resolves.toBeDefined();
    });
    it('keeps readable links beside per-source diagnostic details through a failed refresh', async () => {
        const harness = createDataHarness({ snapshot: { status: 'ready', rows: [], hasMore: false } });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID },
            null, true, null, undefined, true, undefined, async () => ({ kind: 'partial',
                links: [{ entryRef: linkRow().entryRef, sessionId: SESSION_ID, linkedAtMs: 10, displayPath: 'Readable PR' }],
                lanes: [{ source: { pluginId: 'acme.ledger', localId: 'items' },
                    sourceInstanceId: '22222222-2222-4222-8222-222222222222', displayLabel: 'acme/ledger',
                    kindIds: ['issue'], health: { kind: 'failed',
                        failure: { class: 'transient', code: 'sessionLinksReadFailed' },
                        invocationError: { code: 'source_transport_unavailable', retryable: false,
                            requestId: 'source-read-request-1' } } }],
            }));
        await expect(fixture.getByText('Readable PR')).resolves.toBeDefined();
        await expect(fixture.getByText('acme/ledger: Could not be reached just now.')).resolves.toBeDefined();
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Details: acme/ledger' })); });
        await expect(fixture.getByText('source_transport_unavailable')).resolves.toBeDefined();
        await expect(fixture.getByText('source-read-request-1')).resolves.toBeDefined();
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh' })); });
        await expect(fixture.getByText('Readable PR')).resolves.toBeDefined();
    });
    it('offers complete-lane candidates when an unrelated configured source is unavailable', async () => {
        const scope = createTriageEphemeralSharedScopeFixture();
        const observation = testkitObservation({ entryRef: testkitEntryRef() });
        const instanceId = observation.sourceInstanceId;
        const lane = { sourceInstanceId: instanceId, source: observation.entryRef.source,
            health: { kind: 'walkFinished' as const }, exhausted: true };
        const window = foldTriageListWindow({ observations: [observation], lanes: [lane],
            activeSourceInstanceIds: [instanceId], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: Date.now() });
        const listEntries = async () => ({ v: 1,
            configuredSources: [{ sourceInstanceId: instanceId, configurationRowId: instanceId, source: observation.entryRef.source, available: true }],
            configuredSourcesStatus: 'complete',
            window: { v: 1, rows: toTriageListWireRows(window), lanes: [lane], coverage: 'complete', assembledAtMs: Date.now() } });
        const seedHost = { executeAction: listEntries };
        const lease = acquireTriageListWindow(seedHost, scope);
        const probe = defineUiSurface(() => {
            const result = useTriageSessionLinkCandidates(SESSION_ID, '');
            return <Text value={JSON.stringify({ status: result.status,
                candidates: result.candidates.map(candidate => candidate.entry.title),
                unavailableSources: result.sourceHealth?.filter(lane => lane.health.kind !== 'complete').map(lane => lane.displayLabel),
            })} />;
        });
        let partial = false;
        const relation = () => ({ kind: partial ? 'partial' : 'complete', links: [], lanes: [
            { source: observation.entryRef.source, sourceInstanceId: instanceId, displayLabel: 'Example forge',
                kindIds: ['pull-request'], health: { kind: 'complete' } },
            ...(partial ? [{ source: { pluginId: 'acme.ledger', localId: 'acme-ledger' },
                sourceInstanceId: '22222222-2222-4222-8222-222222222222', displayLabel: 'acme/ledger',
                health: { kind: 'unavailable' } }] : []),
        ] });
        try {
            await refreshTriageListWindow('manual', seedHost, scope);
            const harness = createDataHarness({ snapshot: { status: 'ready', rows: [], hasMore: false } });
            const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID }, null, true, null,
                undefined, true, listEntries, async () => relation(), () => scope, false, true, probe);
            await expect(fixture.getByText(JSON.stringify({ status: 'ready',
                candidates: ['Replace the duplicated normalizer'], unavailableSources: [] }))).resolves.toBeDefined();
            partial = true;
            const bytes = new TextEncoder().encode(JSON.stringify(TriageReadSourceSessionLinksResultV1Schema.parse(relation())));
            await act(async () => { fixture.invalidateResource('session-links-v1', `sha256:${createHash('sha256').update(bytes).digest('hex')}`); });
            await expect(fixture.getByText(JSON.stringify({ status: 'partial',
                candidates: ['Replace the duplicated normalizer'], unavailableSources: ['acme/ledger'] }))).resolves.toBeDefined();
            expect(actionCalls.filter(call => call.action === 'sessions/read-source-links-v1')).toHaveLength(2);
            expect(actionCalls.filter(call => call.action === 'sessions/link-entry-v1')).toHaveLength(0);
        } finally { await act(async () => { lease.release(); }); }
    });
    it('shares one live relation snapshot with the picker and reacquires once on qualified invalidation', async () => {
        const harness = createDataHarness({ snapshot: { status: 'ready', rows: [], hasMore: false } });
        let linked = false;
        const result = () => ({ kind: 'complete', links: linked ? [{ entryRef: linkRow().entryRef, sessionId: SESSION_ID,
            linkedAtMs: 1, displayPath: 'New live link' }] : [], lanes: [{ source: linkRow().entryRef.source,
            sourceInstanceId: '11111111-1111-4111-8111-111111111111', displayLabel: 'Example forge', kindIds: ['pull-request'],
            health: { kind: 'complete' } }] });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID },
            null, true, null, undefined, true, undefined, async () => result(), undefined, false, true);
        const linkControls = await fixture.getAllByRole('button', { name: 'Link a PR or issue' });
        await act(async () => { await fixture.press(linkControls.at(-1)!); });
        await expect(fixture.findByRole('textbox', { name: 'Search PRs & Issues' })).resolves.toBeDefined();
        expect(actionCalls.filter(call => call.action === 'sessions/read-source-links-v1')).toHaveLength(1);
        linked = true;
        const bytes = new TextEncoder().encode(JSON.stringify(TriageReadSourceSessionLinksResultV1Schema.parse(result())));
        await act(async () => { fixture.invalidateResource('session-links-v1', `sha256:${createHash('sha256').update(bytes).digest('hex')}`); });
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.getByText('New live link')).resolves.toBeDefined();
        expect(actionCalls.filter(call => call.action === 'sessions/read-source-links-v1')).toHaveLength(2);
        expect(harness.opened).toHaveLength(0);
        expect(harness.gets).toHaveLength(0);
    });

    it('uses only the composed relation read and never revives a stale raw PR beside healthy co-links', async () => {
        const issue = linkRow({ entryRef: { ...linkRow().entryRef, kindId: 'issue', entryId: '7' }, displayPathAtLink: 'Healthy issue' });
        const harness = createDataHarness({
            snapshot: { status: 'ready', rows: [queryRow('stale-pr', 100)], hasMore: false },
            rowsById: new Map([['stale-pr', linkRow({ displayPathAtLink: 'Stale raw PR' })]]),
        });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID },
            null, true, null, undefined, true, undefined, async () => ({ kind: 'partial',
                links: [{ entryRef: issue.entryRef, sessionId: SESSION_ID, linkedAtMs: 10, displayPath: 'Healthy issue' }],
                lanes: [{ source: issue.entryRef.source, sourceInstanceId: '11111111-1111-4111-8111-111111111111', displayLabel: 'Example forge',
                    kindIds: ['pull-request'], health: { kind: 'failed', failure: { class: 'transient', code: 'offline' } } },
                    { source: issue.entryRef.source, sourceInstanceId: '11111111-1111-4111-8111-111111111111', displayLabel: 'Example forge',
                        kindIds: ['issue'], health: { kind: 'complete' } }],
            }));
        await expect(fixture.getByText('Healthy issue')).resolves.toBeDefined();
        await expect(fixture.queryByText('Stale raw PR')).resolves.toBeUndefined();
        expect(harness.opened).toHaveLength(0);
        expect(harness.gets).toHaveLength(0);
        expect(actionCalls.filter(call => call.action === 'sessions/read-source-links-v1')).toHaveLength(1);
        expect(actionCalls.find(call => call.action === 'sessions/read-source-links-v1')?.input).toEqual({ v: 1, sessionId: SESSION_ID });
    });

    it('reads source relations through the Account aggregate without a Machine', async () => {
        const harness = createDataHarness({ snapshot: { status: 'ready', rows: [], hasMore: false } });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID },
            null, true, null, undefined, true, undefined, async () => ({ kind: 'complete', links: [{
                entryRef: linkRow().entryRef, sessionId: SESSION_ID, linkedAtMs: 10, displayPath: 'My linked Account task',
            }] }), undefined, true);
        await expect(fixture.getByText('My linked Account task')).resolves.toBeDefined();
        expect(actionCalls.filter(call => call.action === 'sessions/read-source-links-v1')).toHaveLength(1);
        expect(actionCalls.find(call => call.action === 'sessions/read-source-links-v1')?.input).toEqual({ v: 1, sessionId: SESSION_ID });
        expect(harness.gets).toHaveLength(0);
    });

    it('never carries source-only links into another Account scope with the same Session id', async () => {
        const harness = createDataHarness({ snapshot: { status: 'ready', rows: [], hasMore: false } });
        let scope = createTriageEphemeralSharedScopeFixture();
        const firstAccount = scope;
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID },
            null, true, null, undefined, true, undefined, async () => {
                if (scope !== firstAccount) throw new Error('The new Account is unavailable.');
                return { kind: 'complete', links: [{
                entryRef: linkRow().entryRef, sessionId: SESSION_ID, linkedAtMs: 10, displayPath: 'First Account private task',
            }] }; }, () => scope);
        await expect(fixture.getByText('First Account private task')).resolves.toBeDefined();
        scope = createTriageEphemeralSharedScopeFixture();
        const nextContext = createSurfaceContextFixture({ target: { kind: 'session', sessionId: SESSION_ID } });
        delete nextContext.targetedContributions;
        await act(async () => { await fixture.updateSurface(nextContext); });
        await expect(fixture.queryByText('First Account private task')).resolves.toBeUndefined();
        expect(harness.gets).toHaveLength(0);
    });

    it('shows healthy source links beside named incomplete coverage and never reports a partial empty read as empty', async () => {
        const harness = createDataHarness({ snapshot: { status: 'ready', rows: [], hasMore: false } });
        const { collections, control } = createTestkitCorpusCollections();
        const configured = testkitConfiguredInstance();
        for (const [index, instance] of [configured, { ...configured,
            instance: { source: { pluginId: 'acme.uninstalled', localId: 'items' }, sourceInstanceId: '22222222-2222-4222-8222-222222222222' },
            locator: { v: 1 as const, displayLabel: 'Retained source' },
        }].entries()) control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: `${index}${'a'.repeat(42)}`, lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            sourceQualifiedId: `${instance.instance.source.pluginId}/${instance.instance.source.localId}`, configured: instance,
        }));
        let links = [{ localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '42' }, sessionId: SESSION_ID,
            linkedAtMs: 10, displayPath: 'Healthy linked work' }];
        const snapshot = testkitReadOnlySourceSnapshot();
        const context = { surface: 'ui', caller: { kind: 'plugin', pluginId: PLUGIN_ID }, signal: new AbortController().signal,
            services: {
                storage: { account: { collection: (definition: { id: string }) => definition.id === 'source-instances'
                    ? collections.sourceInstances : definition.id === 'session-links' ? collections.sessionLinks : collections.userMarks } },
                targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [
                    { ...snapshot.contributions[0], operations: { readSessionLinks: { role: 'readSessionLinks' }, linkSession: { role: 'linkSession' } } },
                ] }), dispose: () => {} }) },
                actions: { executeAdmittedTargetedOperation: async () => ({ kind: 'complete', links }) },
            },
        } as unknown as PluginInvocationContext;
        const read = createTriageReadSourceSessionLinksActionHandler();
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID },
            null, true, null, undefined, true, undefined, async () => await read({ v: 1, sessionId: SESSION_ID }, context));
        await expect(fixture.getByText('Healthy linked work')).resolves.toBeDefined();
        // The source is named with why, in the shell's own words for an uninstalled source, never a raw code.
        await expect(fixture.getByText('Retained source: Not installed or enabled on this machine.')).resolves.toBeDefined();
        links = [];
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh' })); });
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.queryByText('Healthy linked work')).resolves.toBeUndefined();
        await expect(fixture.getByText('Linked entries could not be read')).resolves.toBeDefined();
        // With no links, the unavailable state presents all source reasons in one description.
        await expect(fixture.getByText('Happier tasks: Not installed or enabled on this machine. Retained source: Not installed or enabled on this machine.')).resolves.toBeDefined();
        await expect(fixture.queryByText('Keep this session’s PRs and issues at hand')).resolves.toBeUndefined();
    });

    describe('the link picker over a partial relation read', () => {
        /** One PR is in the retained window; `readableKinds` are the kinds the one healthy source could read for links. */
        async function mountPartialPicker(readableKinds: readonly string[], linkResult: unknown = null): Promise<PluginUiTestkit> {
            const scope = createTriageEphemeralSharedScopeFixture();
            const link = linkRow();
            const observation = testkitObservation({ entryRef: link.entryRef, outcome: {
                kind: 'present',
                locator: { v: 1, displayPath: link.displayPathAtLink, routingToken: 'exact-route' },
                snapshot: testkitSnapshot({ title: 'Key settings modals by route' }),
                viewer: { involvement: [] },
            } });
            const listResult = {
                v: 1, configuredSourcesStatus: 'complete',
                configuredSources: [{ sourceInstanceId: observation.sourceInstanceId, configurationRowId: observation.sourceInstanceId, source: link.entryRef.source, available: true }],
                window: { v: 1, assembledAtMs: observation.observedAtMs, coverage: 'complete',
                    lanes: [{ sourceInstanceId: observation.sourceInstanceId, source: link.entryRef.source, health: { kind: 'walkFinished' }, exhausted: true }],
                    rows: toTriageListWireRows(foldTriageListWindow({
                        observations: [observation], lanes: [], activeSourceInstanceIds: [observation.sourceInstanceId],
                        configuredSourcesStatus: 'complete', lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: observation.observedAtMs,
                    })),
                },
            };
            const relation = async () => ({ kind: 'partial', links: [], lanes: [
                { source: link.entryRef.source, sourceInstanceId: observation.sourceInstanceId, displayLabel: 'Example forge',
                    kindIds: [...readableKinds], health: { kind: 'complete' } },
                { source: { pluginId: 'acme.ledger', localId: 'acme-ledger' }, sourceInstanceId: '22222222-2222-4222-8222-222222222222',
                    displayLabel: 'acme/ledger', kindIds: ['issue'],
                    health: { kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksSourceNotAdmitted' } } },
            ] });
            // The picker is the Popover's content: mounted on its own, the pane's linked rows and header are not around it.
            const picker = defineUiSurface(() => <LinkEntryPicker sessionId={SESSION_ID} label="Link a PR or issue" onLinked={() => undefined} />);
            const harness = createDataHarness({ snapshot: { rows: [], hasMore: false, status: 'ready' } });
            return await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID }, linkResult, true, null,
                { scope, readStatus: async () => { throw new Error('No status read is expected here.'); } }, true,
                async () => listResult, relation, undefined, false, true, picker);
        }

        /** The open picker asks the list window for entries; let that read and the relation read settle. */
        const settlePicker = async (): Promise<void> => {
            for (let turn = 0; turn < 3; turn += 1) await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
        };

        it('shows a typed link refusal in Details and settles without replaying the mutation', async () => {
            const fixture = await mountPartialPicker([linkRow().entryRef.kindId], new PluginError({
                code: 'unavailable', message: 'The PR binding could not be attached.', retryable: false,
                diagnostics: [{ code: 'channels_pr_link_binding_not_ready', severity: 'error' }],
                details: { requestId: 'session-attach-request-1' },
            }));
            await settlePicker();
            await act(async () => {
                const rows = await fixture.queryAllByRole('button');
                const row = rows.find(target => target.name?.includes('Key settings modals by route'));
                expect(row, JSON.stringify(rows.map(target => target.name))).toBeDefined();
                await fixture.press(row!);
            });
            await expect(fixture.getByText('The PR binding could not be attached.')).resolves.toBeDefined();
            await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Details' })); });
            await expect(fixture.getByText('Code')).resolves.toBeDefined();
            await expect(fixture.getByText('unavailable channels_pr_link_binding_not_ready')).resolves.toBeDefined();
            await expect(fixture.getByText('Request ID')).resolves.toBeDefined();
            await expect(fixture.getByText('session-attach-request-1')).resolves.toBeDefined();
            expect(actionCalls.filter(call => call.action === 'sessions/link-entry-v1')).toHaveLength(1);
        });

        it('keeps the healthy rows and search, and names the unavailable source with why and its one Refresh', async () => {
            const fixture = await mountPartialPicker([linkRow().entryRef.kindId]);
            await settlePicker();
            await expect(fixture.findByRole('textbox', { name: 'Search PRs & Issues' })).resolves.toBeDefined();
            await expect(fixture.getByText('Key settings modals by route')).resolves.toBeDefined();
            await expect(fixture.getByText('acme/ledger: Not installed or enabled on this machine.')).resolves.toBeDefined();
            await expect(fixture.getByRole('button', { name: 'Refresh' })).resolves.toBeDefined();
        });

        it('says the read was partial, never that nothing matches, when no readable source covers an entry', async () => {
            const fixture = await mountPartialPicker(['issue']);
            await settlePicker();
            await expect(fixture.getByText('Nothing matches in the sources that could be read')).resolves.toBeDefined();
            await expect(fixture.queryByText('Nothing matches in PRs & Issues yet')).resolves.toBeUndefined();
            await expect(fixture.queryByText('Key settings modals by route')).resolves.toBeUndefined();
            await expect(fixture.getByText('acme/ledger: Not installed or enabled on this machine.')).resolves.toBeDefined();
        });
    });

    it('joins source-owned work without a v2 row and retains it after a failed source refresh', async () => {
        const harness = createDataHarness({ snapshot: { status: 'ready', rows: [], hasMore: false } });
        let failSource = false;
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID },
            { v: 1, status: 'unlinked' }, true, null, undefined, true, undefined, async () => {
                if (failSource) throw new Error('The source is offline');
                return { kind: 'partial', links: [{ entryRef: linkRow().entryRef, sessionId: SESSION_ID,
                    linkedAtMs: 10, displayPath: 'Personal task without external storage' }] };
            });
        await expect(fixture.getByText('Personal task without external storage')).resolves.toBeDefined();
        expect(harness.gets).toHaveLength(0);
        failSource = true;
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh' })); });
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.getByText('Personal task without external storage')).resolves.toBeDefined();
        await openRow(fixture, 'Personal task without external storage');
        await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Unlink Personal task without external storage' })); });
        expect(actionCalls.filter((call) => call.action === 'sessions/unlink-entry-v1')).toHaveLength(1);
        expect(harness.deletes).toHaveLength(0);
    });

    it('keeps every link in the complete owner result reachable beyond the first corpus page', async () => {
        const links = Array.from({ length: 101 }, (_, index) => linkRow({
            entryRef: { ...linkRow().entryRef, entryId: String(index + 1) },
            displayPathAtLink: `example/repository#${index + 1}`,
            linkedAtMs: index === 100 ? 1000 : 100 - index,
        }));
        const harness = createDataHarness({ snapshot: { rows: [], status: 'ready' } });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID }, { v: 1, status: 'unlinked' },
            true, null, undefined, true, undefined, async () => ({ kind: 'complete', links: links.map(link => ({
                entryRef: link.entryRef, sessionId: link.sessionId, linkedAtMs: link.linkedAtMs, displayPath: link.displayPathAtLink,
            })) }));
        await expect(fixture.getByText('example/repository#101')).resolves.toBeDefined();
        await expect(fixture.queryByRole('button', { name: 'Load more' })).resolves.toBeUndefined();
        await unlinkThroughSharedPolicy(fixture, 'example/repository#101');
        expect(actionCalls.filter(call => call.action === 'sessions/unlink-entry-v1')).toEqual([{
            action: 'sessions/unlink-entry-v1', input: { v: 1, sessionId: SESSION_ID, entryRef: links[100]!.entryRef },
        }]);
        expect(harness.opened).toHaveLength(0);
        expect(harness.gets).toHaveLength(0);
    });

    it('opens a linked row through the qualified Triage destination and keeps Unlink beside Open', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [queryRow('link-a', 2_000)], hasMore: false, status: 'ready' },
            rowsById: new Map([['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })]]),
        });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        // The row opens in place; Open is its primary and Unlink a separate control beside it.
        await openRow(fixture, 'example/repository#42');
        await fixture.press(await fixture.findByRole('button', { name: 'Open' }));
        await act(async () => { await Promise.resolve(); });

        expect(surfaceOpens).toHaveLength(1);
        expect(surfaceOpens[0]).toMatchObject({
            view: TRIAGE_ENTRY_DETAIL_DESTINATION_V1,
            subPath: 'e,happier.example.source,example-forge,pull-request,example%2Frepository,42',
        });
        expect(surfaceOpens[0]?.input).toBeUndefined();
        expect((await fixture.queryAllByRole('button'))
            .filter((button) => button.name === 'Unlink example/repository#42'))
            .toHaveLength(1);
        expect(actionCalls.filter(call => call.action !== 'sessions/read-source-links-v1')).toEqual([]);
    });

    it('keeps an open refusal visible and leaves unlink available', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [queryRow('link-a', 2_000)], hasMore: false, status: 'ready' },
            rowsById: new Map([['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })]]),
        });
        const fixture = await mountCockpit(
            harness,
            { kind: 'session', sessionId: SESSION_ID },
            null,
            true,
            new PluginError({ code: 'destination_unavailable', details: { requestId: 'cockpit-open-17' } }),
        );

        await openRow(fixture, 'example/repository#42');
        await fixture.press(await fixture.findByRole('button', { name: 'Open' }));
        await act(async () => { await Promise.resolve(); });

        await expect(fixture.getByText('This entry could not be opened.')).resolves
            .toEqual({ content: 'This entry could not be opened.' });
        await vi.waitFor(() => expect(navigationNotifications.join(' ')).toContain('cockpit-open-17'));
        expect(navigationFailures).toEqual([expect.objectContaining({ errorCode: 'destination_unavailable', requestId: 'cockpit-open-17' })]);
        expect(navigationNotifications.join(' ')).toContain('destination_unavailable');
        expect(navigationNotifications.join(' ')).toContain('cockpit-open-17');
        expect((await fixture.queryAllByRole('button'))
            .filter((button) => button.name === 'Unlink example/repository#42'))
            .toHaveLength(1);
        expect(actionCalls.filter(call => call.action !== 'sessions/read-source-links-v1')).toEqual([]);
    });






    it('never presents an unavailable page as an empty link set', async () => {
        const harness = createDataHarness({
            snapshot: {
                rows: [],
                hasMore: false,
                status: 'unavailable',
                error: { error: 'collection_unavailable' },
            },
        });

        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        await expect(fixture.getByText('Linked entries could not be read')).resolves
            .toEqual({ content: 'Linked entries could not be read' });
        expect(harness.gets).toEqual([]);
    });


    it('reports a settled empty page as an empty link set', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [], hasMore: false, status: 'ready' },
        });

        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        await expect(fixture.getByText('Keep this session’s PRs and issues at hand')).resolves
            .toEqual({ content: 'Keep this session’s PRs and issues at hand' });
    });

    it('leads the empty state with its one action, linking a PR or issue, and keeps browsing quiet beside it', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [], hasMore: false, status: 'ready' },
        });

        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        // The state's primary opens the same picker as the pane header's "+" (which the host draws in its band).
        const linkControls = await fixture.getAllByRole('button', { name: 'Link a PR or issue' });
        await expect(fixture.queryByRole('textbox', { name: 'Search PRs & Issues' })).resolves.toBeUndefined();
        await act(async () => { await fixture.press(linkControls[linkControls.length - 1]!); });
        await expect(fixture.findByRole('textbox', { name: 'Search PRs & Issues' })).resolves.toBeDefined();
        // PRs & Issues has read nothing on this mount: the picker says there is nothing to pick yet, never that
        // this Session's links could not be read.
        await expect(fixture.getByText('Nothing matches in PRs & Issues yet')).resolves.toBeDefined();
        await expect(fixture.queryByText('Linked entries could not be read')).resolves.toBeUndefined();
        await expect(fixture.getByRole('button', { name: 'Browse PRs & Issues' })).resolves.toBeDefined();
    });

    it('reads PRs & Issues when the picker opens on a mount that has read nothing, and lists what it finds', async () => {
        // Opening the picker is the reader asking for entries; on a cold app (the Session opened first) an empty
        // picker would leave them nothing to link. The open picker is a view of the one list window, so it sends
        // that window's paced view demand rather than reading on its own.
        const scope = createTriageEphemeralSharedScopeFixture();
        const link = linkRow();
        const observation = testkitObservation({ entryRef: link.entryRef, outcome: {
            kind: 'present',
            locator: { v: 1, displayPath: link.displayPathAtLink, routingToken: 'exact-route' },
            snapshot: testkitSnapshot({ title: 'Key settings modals by route' }),
            viewer: { involvement: [] },
        } });
        const listResult = {
            v: 1, configuredSourcesStatus: 'complete',
            configuredSources: [{ sourceInstanceId: observation.sourceInstanceId, configurationRowId: observation.sourceInstanceId, source: link.entryRef.source, available: true }],
            window: { v: 1, assembledAtMs: observation.observedAtMs, coverage: 'complete',
                lanes: [{ sourceInstanceId: observation.sourceInstanceId, source: link.entryRef.source, health: { kind: 'walkFinished' }, exhausted: true }],
                rows: toTriageListWireRows(foldTriageListWindow({
                    observations: [observation], lanes: [], activeSourceInstanceIds: [observation.sourceInstanceId],
                    configuredSourcesStatus: 'complete', lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: observation.observedAtMs,
                })),
            },
        };
        const harness = createDataHarness({ snapshot: { rows: [], hasMore: false, status: 'ready' } });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID }, null, true, null,
            { scope, readStatus: async () => { throw new Error('No status read is expected here.'); } }, true,
            async () => listResult);
        expect(actionCalls.filter((call) => call.action === 'entries/list-v1')).toEqual([]);

        const linkControls = await fixture.getAllByRole('button', { name: 'Link a PR or issue' });
        await act(async () => { await fixture.press(linkControls[linkControls.length - 1]!); });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
        await expect(fixture.getByText('Key settings modals by route')).resolves.toBeDefined();
        expect(actionCalls.some((call) => call.action === 'entries/list-v1')).toBe(true);
    });

    it('opens no query at all when the mounted target is not a Session', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [], hasMore: false, status: 'ready' },
        });

        const fixture = await mountCockpit(harness, { kind: 'app' });

        expect(harness.opened).toEqual([]);
        expect(harness.gets).toEqual([]);
        await expect(fixture.getByText('No session for this panel')).resolves
            .toEqual({ content: 'No session for this panel' });
    });
});

describe('undoing a link from the mounted cockpit', () => {
    it('removes a source-qualified PR through the mounted row without choosing another source', async () => {
        const relation = { entryRef: linkRow().entryRef, sessionId: SESSION_ID,
            sourceInstanceId: '11111111-1111-4111-8111-111111111111', linkedAtMs: 1_000, displayPath: 'Source-owned PR' };
        let linked = true;
        const harness = createDataHarness({ snapshot: { rows: [], hasMore: false, status: 'ready' } });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID }, null, true, null,
            undefined, true, undefined, async () => ({ kind: 'complete', links: linked ? [relation] : [] }),
            undefined, false, false, renderSessionLinkedEntriesSurface, async input => {
                // The host Action boundary requires the exact source-qualified published address.
                const value = input as { sourceInstanceId?: string };
                if (value.sourceInstanceId !== relation.sourceInstanceId) throw new PluginError({ code: 'sessionLinksSourceInstanceRequired', message: 'A source is required.', retryable: false });
                linked = false;
                return { v: 1, status: 'unlinked' };
            });
        await unlinkThroughSharedPolicy(fixture, relation.displayPath);
        expect(linked).toBe(false);
        await expect(fixture.queryByRole('button', { name: relation.displayPath })).resolves.toBeUndefined();
        expect(harness.deletes).toHaveLength(0);
    });
    /**
     * The reader who started a Session from the wrong entry had no way back: a
     * link is durable Account state, the cockpit was read-only, and nothing
     * else removes one. This is that path, end to end through the real mount.
     */
    it('removes exactly the link the pressed row was rendered from', async () => {
        const rows = [queryRow('link-a', 2_000), queryRow('link-b', 1_000)];
        const wrongEntry = linkRow({
            displayPathAtLink: 'example/repository#42',
            entryRef: {
                source: { pluginId: 'happier.example.source', localId: 'example-forge' },
                kindId: 'pull-request',
                collisionScope: 'example/repository',
                entryId: '42',
            },
        });
        const harness = createDataHarness({
            snapshot: { rows, hasMore: false, status: 'ready' },
            rowsById: new Map([
                ['link-a', wrongEntry],
                ['link-b', linkRow({ displayPathAtLink: 'example/other#7',
                    entryRef: { ...wrongEntry.entryRef, collisionScope: 'example/other', entryId: '7' },
                    identityEntryRef: { ...wrongEntry.entryRef, collisionScope: 'example/other', entryId: '7' },
                })],
            ]),
        });

        const fixture = await mountCockpit(
            harness,
            { kind: 'session', sessionId: SESSION_ID },
            { v: 1, status: 'unlinked' },
        );

        // Unlink is addressed by the open row and admitted by the shared Action policy.
        await unlinkThroughSharedPolicy(fixture, 'example/repository#42');
        await expect(fixture.getByText('example/other#7')).resolves.toBeDefined();

        expect(actionCalls.filter(call => call.action === 'sessions/unlink-entry-v1')).toEqual([{
            action: 'sessions/unlink-entry-v1',
            input: { v: 1, sessionId: SESSION_ID, entryRef: wrongEntry.entryRef },
        }]);
        expect(harness.identityRequests).toHaveLength(0);
        expect(harness.deletes).toHaveLength(0);

    });

    it('says a refused removal failed instead of showing the link as gone', async () => {
        const rows = [queryRow('link-a', 2_000)];
        const harness = createDataHarness({
            snapshot: { rows, hasMore: false, status: 'ready' },
            rowsById: new Map([['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })]]),
            deleteFails: true,
        });

        const fixture = await mountCockpit(
            harness,
            { kind: 'session', sessionId: SESSION_ID },
            { v: 1, status: 'failed' },
        );

        await unlinkThroughSharedPolicy(fixture, 'example/repository#42');

        // The row is still the link it was. Presenting a refused delete as a
        // removal would tell the reader their mistake is undone while the
        // Session still claims the entry.
        await expect(fixture.findByRole('button', { name: 'example/repository#42' })).resolves.toBeDefined();
        await expect(fixture.getByText('This link could not be removed.')).resolves
            .toEqual({ content: 'This link could not be removed.' });
    });
});
