// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginClientTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginClientTestkit, PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { RenderSurface, PluginUiTargetedContributionsV1 } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface, WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../../actions/listEntries.js';
import { TriageListEntriesInputV1Schema } from '../../actions/listEntriesProtocol.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../../corpus/collections/rowCodec.js';
import { createTestkitCorpusCollections } from '../../corpus/testkit/corpusCollections.test-support.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import { createTriageEphemeralSharedScopeOriginFixture } from '../window/ephemeralSharedScope.test-support.js';
import { renderSurface as renderLatestWidget, TriageLatestWidget } from './latestWidget.js';
import { renderSurface as renderTasksWidget } from './tasksWidget.js';
import * as mountedUiActionArtifact from '../../actions/mountedUi.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../../internalTasks/contribution.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../../internalTasks/configuration.js';
import { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from '../../internalTasks/identity.js';
import { TriageMountedUiInputV1Schema, TriageMountedUiResultV1Schema } from '../../actions/mountedUiProtocol.js';
import { TRIAGE_ENTRY_DETAIL_DESTINATION_V1 } from '../../composer/openEntryDetails.js';

/**
 * **New for you** on Home.
 *
 * Home builds the widget only while it is focused and on screen, so the widget unmounts every
 * time the reader opens a page. The contract pinned here is what makes that cheap and calm: the
 * host keeps the one shared window while nothing shows it, coming back draws the last rows at
 * once — before the revalidation it starts has answered — and nothing runs in between.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const TITLE = 'Replace the duplicated normalizer';

function createListHarness(withTasks = false, mineFacts: Readonly<Record<string, unknown>> = {}, withPersonal = false,
    failing: Readonly<{ now: boolean }> = { now: false }, morePullRequests = 0) {
    const { collections, control } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    control.sourceInstances.seed(toCorpusStoredValue({
        instanceTag: `a${'0'.repeat(42)}`,
        sourceQualifiedId: `${SOURCE.pluginId}/${SOURCE.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1,
        configured: TriageConfiguredSourceInstanceV1Schema.parse({
            v: 1,
            instance: { source: SOURCE, sourceInstanceId: INSTANCE },
            binding: {
                purpose: 'triage-source',
                account: { service: { pluginId: SOURCE.pluginId, localId: 'accounts' }, accountId: 'account-1' },
            },
            localInstanceKey: 'example/repository',
            configuration: { v: 1, token: 'routing-token' },
            locator: { v: 1, displayLabel: 'example/repository' },
        }),
    }));
    const admitted = [{
        contributor: { pluginId: SOURCE.pluginId, contributionId: SOURCE.localId, occurrenceId: 'generation-1', sourceCustody: { kind: 'development', registeredRootId: 'source-root' } },
        protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 },
        descriptor: {
            v: 1,
            purpose: 'triage-source',
            displayName: 'Example forge',
            kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' },
                ...(withTasks ? [{ id: 'issue', workflowSubject: 'issue', displayName: 'Issue', task: true }] : [])],
        },
        operations: { listInstances: {}, scan: { role: 'scan' }, get: {} },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1];
    const personalScan: object = { role: 'personal-scan' };
    if (withPersonal) admitted.push({ ...admitted[0]!,
        contributor: { ...admitted[0]!.contributor, pluginId: INTERNAL_TASK_SOURCE_V1.pluginId,
            contributionId: INTERNAL_TASK_SOURCE_V1.localId },
        descriptor: INTERNAL_TASK_DESCRIPTOR_V1,
        operations: { ...admitted[0]!.operations, scan: personalScan },
    } as unknown as TriageAdmittedSourceV1);
    const executeScan: TriageAdmittedOperationExecutorV1 = async operation => failing.now && operation !== personalScan ? {
        kind: 'failed', failure: { class: 'transient', code: 'provider-busy' },
    } satisfies TriageScanResultV1 : operation === personalScan ? {
        kind: 'complete', evidence: { kind: 'walkFinished' },
        observations: Array.from({ length: 6 }, (_, index) => ({ kind: 'present',
            localRef: internalTaskLocalRefV1(`personal-${index}`), locator: testkitLocator(),
            snapshot: testkitSnapshot({ title: `Personal task ${index}` }),
            viewer: testkitViewer({ involvement: ['assignee'] }), sourceUpdatedAtMs: 4_000 + index,
        })),
    } : ({
        kind: 'complete',
        observations: [{
            kind: 'present',
            localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
            locator: testkitLocator(),
            snapshot: testkitSnapshot({ title: TITLE }),
            viewer: testkitViewer(),
            sourceUpdatedAtMs: 3_000,
        }, ...Array.from({ length: morePullRequests }, (_, index) => ({
            kind: 'present' as const,
            localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: `${20 + index}` },
            locator: testkitLocator(), snapshot: testkitSnapshot({ title: `Pull request ${index}` }),
            viewer: testkitViewer(), sourceUpdatedAtMs: 2_000 + index,
        })), ...(withTasks ? [true, false].map((mine, index) => ({
            kind: 'present' as const,
            localRef: { kindId: 'issue', collisionScope: 'example/repository', entryId: `issue-${index}` },
            locator: testkitLocator(), snapshot: { ...testkitSnapshot({ title: mine ? 'My assigned task' : 'Someone else’s task' }), ...(mine ? mineFacts : {}) },
            viewer: testkitViewer({ involvement: mine ? ['assignee'] : [] }), sourceUpdatedAtMs: 3_000,
        })) : [])],
        evidence: { kind: 'walkFinished' },
    } satisfies TriageScanResultV1);
    return {
        targetedContributions: {
            target: { pluginId: 'happier.triage', occurrenceId: 'triage-generation',
                sourceCustody: { kind: 'development', registeredRootId: 'triage-root' } },
            points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{
                protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 },
                contributions: admitted.map((entry) => ({ contributor: entry.contributor, protocol: entry.protocol,
                    descriptor: entry.descriptor, operations: [], surfaces: [] })),
            }] }],
        } satisfies PluginUiTargetedContributionsV1,
        reads: 0,
        executeAction(input: unknown) {
            this.reads += 1;
            const parsed = TriageListEntriesInputV1Schema.parse(input);
            // Enumerate exactly the source contributions this harness admits.
            return listTriageEntries({ ...parsed, sources: parsed.sources.kind === 'allConfigured'
                ? { kind: 'selected', sourceInstanceIds: [INSTANCE,
                    ...(withPersonal ? [INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId] : [])] } : parsed.sources }, {
                sourceInstances: collections.sourceInstances,
                readAdmittedSources: async () => admitted,
                executeScan,
                nowMs: () => Date.now(),
            });
        },
    };
}

const mounted: PluginUiTestkit[] = [];
const opened: unknown[] = [];
const clients: PluginClientTestkit[] = [];

async function mountWidget(
    scope: ReturnType<typeof createTriageEphemeralSharedScopeOriginFixture>,
    executeAction: (input: unknown) => Promise<unknown>,
    publishCurrentUiContext?: (enrichment: unknown) => void,
    options: Readonly<{ surface?: RenderSurface; targetedContributions?: PluginUiTargetedContributionsV1; frameHeader?: boolean }> = {},
): Promise<PluginUiTestkit> {
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-latest-widget', mountNonce: `mount-${mounted.length}` },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            surface: options.surface ?? renderLatestWidget,
            surfaceContext: createSurfaceContextFixture(options.targetedContributions === undefined ? {} : {
                targetedContributions: options.targetedContributions,
            }),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope.forExecutionOrigin('fixture'),
                ...(options.frameHeader === true ? { paneHeader: true } : {}) }),
            handlers: {
                publishCurrentUiContext: ({ enrichment }) => { publishCurrentUiContext?.(enrichment); },
                executeAction: async ({ input }) => await executeAction(input),
                openSurface: ({ view }) => { opened.push(view); },
            },
        });
    });
    mounted.push(fixture);
    return fixture;
}

afterEach(async () => {
    vi.useRealTimers();
    opened.splice(0);
    for (const fixture of mounted.splice(0)) await fixture.dispose();
    for (const client of clients.splice(0)) await client.dispose();
});

describe('the New for you widget', () => {
    it('uses the shared window for My tasks without showing PRs or uninvolved tasks', async () => {
        const harness = createListHarness(true);
        const widget = await mountWidget(createTriageEphemeralSharedScopeOriginFixture(), (input) => harness.executeAction(input),
            undefined, { surface: renderTasksWidget, targetedContributions: harness.targetedContributions });
        await vi.waitFor(() => widget.getByText('My assigned task'));
        await expect(widget.getByText(TITLE)).rejects.toBeDefined();
        await expect(widget.getByText('Someone else’s task')).rejects.toBeDefined();
    });
    it('shows only the whole rows its frame has room for, never a row cut at the card foot', async () => {
        const harness = createListHarness(false, {}, false, { now: false }, 5);
        // A medium card declares four body rows (two per grid row); the page holds the rest.
        const medium = { size: 'medium' as const, footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular' as const, width: 'half' as const } };
        const surface = defineUiSurface(() => <WidgetPresentationProvider value={medium}><TriageLatestWidget /></WidgetPresentationProvider>);
        const widget = await mountWidget(createTriageEphemeralSharedScopeOriginFixture(), (input) => harness.executeAction(input), undefined, { surface });
        const titles = [TITLE, ...[0, 1, 2, 3, 4].map((index) => `Pull request ${index}`)];
        const shownRows = async () => (await Promise.all(titles.map((title) => widget.queryByText(title)))).filter(Boolean).length;
        await vi.waitFor(async () => expect(await shownRows()).toBeGreaterThan(0));
        expect(await shownRows()).toBe(4);
    });
    it('gives up a row for its one degraded line, so the line that names the failed source is never cut off', async () => {
        const scope = createTriageEphemeralSharedScopeOriginFixture();
        const failing = { now: false };
        const harness = createListHarness(false, {}, false, failing, 5);
        const medium = { size: 'medium' as const, footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular' as const, width: 'half' as const } };
        const surface = defineUiSurface(() => <WidgetPresentationProvider value={medium}><TriageLatestWidget /></WidgetPresentationProvider>);
        const titles = [TITLE, ...[0, 1, 2, 3, 4].map((index) => `Pull request ${index}`)];
        const first = await mountWidget(scope, (input) => harness.executeAction(input), undefined, { surface });
        await vi.waitFor(() => first.getByText(TITLE));
        await first.dispose();
        mounted.splice(mounted.indexOf(first), 1);
        failing.now = true;
        const second = await mountWidget(scope, (input) => harness.executeAction(input), undefined, { surface });
        await vi.waitFor(() => second.getByText('example/repository could not be read'));
        const shownRows = async () => (await Promise.all(titles.map((title) => second.queryByText(title)))).filter(Boolean).length;
        expect(await shownRows()).toBe(3);
    });
    it('names the part of the plugin each widget comes from in its frame, not the whole plugin', async () => {
        const harness = createListHarness(true);
        const tasks = await mountWidget(createTriageEphemeralSharedScopeOriginFixture(), (input) => harness.executeAction(input),
            undefined, { surface: renderTasksWidget, targetedContributions: harness.targetedContributions, frameHeader: true });
        await vi.waitFor(() => tasks.getByText('My assigned task'));
        // The frame header (a sibling of the body): "My tasks · Tasks", with its plus (lab `tasks-widget`).
        await expect(tasks.getByRole('group', { name: 'Pane header' })).resolves.toBeDefined();
        await expect(tasks.getByText('Tasks')).resolves.toBeDefined();
        await expect(tasks.getByRole('button', { name: 'New task' })).resolves.toBeDefined();
        const latest = await mountWidget(createTriageEphemeralSharedScopeOriginFixture(), (input) => harness.executeAction(input),
            undefined, { targetedContributions: harness.targetedContributions, frameHeader: true });
        await vi.waitFor(() => latest.getByText(TITLE));
        await vi.waitFor(() => latest.getByText('PRs & Issues'));
    });
    it('says an overdue task as its one loud fact, ahead of a blocker', async () => {
        const blocker = { source: SOURCE, kindId: 'issue', collisionScope: 'example/repository', entryId: 'issue-9' };
        const harness = createListHarness(true, { dueDate: '2000-01-03', relations: { blockedBy: [blocker] } });
        const widget = await mountWidget(createTriageEphemeralSharedScopeOriginFixture(), (input) => harness.executeAction(input),
            undefined, { surface: renderTasksWidget, targetedContributions: harness.targetedContributions });
        await vi.waitFor(() => widget.getByText('My assigned task'));
        // The date is the reader's locale's ("3 Jan", "Jan 3"); the blocker is not said beside it.
        expect(document.body.textContent).toMatch(/Overdue · /);
        expect(document.body.textContent).not.toContain('Blocked');
    });
    it('retries a failed first demand through the addressed mounted refresh owner', async () => {
        const scope = createTriageEphemeralSharedScopeOriginFixture();
        const harness = createListHarness();
        let unavailable = true;
        let published: unknown;
        const widget = await mountWidget(scope, async input => {
            if (unavailable) throw new PluginError({ code: 'unavailable', retryable: true });
            return harness.executeAction(input);
        }, enrichment => { published = enrichment; });
        await vi.waitFor(() => widget.getByRole('button', { name: 'Try again' }));
        expect(published).toMatchObject({ detail: { view: 'latest-widget', mountedAction: {
            action: { pluginId: 'happier.triage', localId: 'ui/mounted-v1' },
        } } });
        const address = published as { detail: { mountedAction: { mountId: string } } };
        const declaration = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === 'ui/mounted-v1');
        if (declaration?.execution.target !== 'client') throw new Error('Missing mounted client Action');
        const target = { ...declaration.execution.client, platform: 'web' as const };
        const client = await createPluginClientTestkit({ manifest: PLUGIN_MANIFEST, target, activate: mountedUiActionArtifact.activate });
        clients.push(client);
        const handler = client.registration('actions', declaration.id);
        if (!handler) throw new Error('Missing registered mounted Action');
        const invoke = async (mountId: string) => {
            const input = TriageMountedUiInputV1Schema.parse({ mountId, operation: { kind: 'refresh' } });
            let result;
            await act(async () => { result = await handler(input, {
                plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                contribution: { id: declaration.id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${declaration.id}` },
                invocationSurface: 'agent', signal: new AbortController().signal,
                ui: widget.context.hostApi, ephemeralSharedScope: scope.forExecutionOrigin('fixture'),
            }); });
            return TriageMountedUiResultV1Schema.parse(result);
        };
        unavailable = false;
        expect(await invoke(`${address.detail.mountedAction.mountId}-wrong`)).toEqual({ status: 'unavailable' });
        expect(await invoke(address.detail.mountedAction.mountId)).toEqual({ status: 'applied' });
        await vi.waitFor(() => widget.getByText(TITLE));
        await widget.dispose();
        expect(await invoke(address.detail.mountedAction.mountId)).toEqual({ status: 'unavailable' });
    });

    it('shows the newest entries its own mount asked for', async () => {
        const harness = createListHarness();
        const widget = await mountWidget(createTriageEphemeralSharedScopeOriginFixture(), (input) => harness.executeAction(input));

        await vi.waitFor(() => widget.getByText(TITLE));
        expect(harness.reads).toBeGreaterThan(0);
    });

    it('comes back warm after Home was left, and holds no timer while nothing shows it', async () => {
        const scope = createTriageEphemeralSharedScopeOriginFixture();
        const harness = createListHarness();
        const first = await mountWidget(scope, (input) => harness.executeAction(input));
        await vi.waitFor(() => first.getByText(TITLE));

        // The reader opens a page: Home unmounts the widget.
        vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
        await first.dispose();
        mounted.splice(mounted.indexOf(first), 1);
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();

        // Back on Home. The revalidation it starts never answers here, so only the retained
        // window can draw the row — at once, not after a loading state.
        const unanswered = new Promise<never>(() => {});
        const second = await mountWidget(scope, () => unanswered);
        expect(await second.queryByText(TITLE)).toBeDefined();
        await expect(second.queryByText('Loading the latest entries')).resolves.toBeUndefined();

        // The host retiring the scope (Account change, plugin occurrence) is what ends retention.
        await second.dispose();
        mounted.splice(mounted.indexOf(second), 1);
        scope.retire();
        const cold = await mountWidget(scope, () => unanswered);
        await expect(cold.queryByText(TITLE)).resolves.toBeUndefined();
    });
});
