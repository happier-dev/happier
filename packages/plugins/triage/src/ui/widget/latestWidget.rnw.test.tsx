// @vitest-environment jsdom
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
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
import { renderSurface as renderLatestWidget } from './latestWidget.js';

/**
 * **New in PRs & Issues** on Home.
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

function createListHarness() {
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
            kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }],
        },
        operations: { listInstances: {}, scan: { role: 'scan' }, get: {} },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1];
    const executeScan: TriageAdmittedOperationExecutorV1 = async () => ({
        kind: 'complete',
        observations: [{
            kind: 'present',
            localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
            locator: testkitLocator(),
            snapshot: testkitSnapshot({ title: TITLE }),
            viewer: testkitViewer(),
            sourceUpdatedAtMs: 3_000,
        }],
        evidence: { kind: 'walkFinished' },
    } satisfies TriageScanResultV1);
    return {
        reads: 0,
        executeAction(input: unknown) {
            this.reads += 1;
            return listTriageEntries(TriageListEntriesInputV1Schema.parse(input), {
                sourceInstances: collections.sourceInstances,
                readAdmittedSources: async () => admitted,
                executeScan,
                nowMs: () => Date.now(),
            });
        },
    };
}

const mounted: PluginUiTestkit[] = [];

async function mountWidget(
    scope: ReturnType<typeof createTriageEphemeralSharedScopeOriginFixture>,
    executeAction: (input: unknown) => Promise<unknown>,
): Promise<PluginUiTestkit> {
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-latest-widget', mountNonce: `mount-${mounted.length}` },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            surface: renderLatestWidget,
            surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope.forExecutionOrigin('fixture') }),
            handlers: {
                executeAction: async ({ input }) => await executeAction(input),
                openSurface: () => undefined,
            },
        });
    });
    mounted.push(fixture);
    return fixture;
}

afterEach(async () => {
    vi.useRealTimers();
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the New in PRs & Issues widget', () => {
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
