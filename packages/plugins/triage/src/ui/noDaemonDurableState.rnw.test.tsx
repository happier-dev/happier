// @vitest-environment jsdom
import * as React from 'react';
import { act, cloneElement, type ReactElement } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiSemanticSurfaceAdapter, PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { Button, defineUiSurface, Text, usePluginHostApi } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiAccountSettings, PluginUiDataClient } from '@happier-dev/plugin-ui/data';
import { TriageConfiguredSourceInstanceV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { createUnavailablePluginUiAccountKv } from '../../../../plugin-ui/src/data/accountKv.js';
import {
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
    CORPUS_USER_MARKS_FIELD,
} from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { deriveUserMarkTag } from '../corpus/identity/tags.js';
import {
    createTestkitCorpusCollections,
    type TestkitCorpusCollections,
} from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';
import {
    createTestkitAccountSettings,
    type TestkitAccountSettings,
} from '../settings/testkit/accountSettings.test-support.js';
import { TRIAGE_ACTIONS_SETTING_ID_V1 } from '../settings/actions.js';
import { TRIAGE_SAVED_VIEWS_SETTING_ID_V1 } from '../settings/savedViews.js';
import { linkEntryToSession } from '../sessions/entrySessionLinks.js';
import {
    createActionTriageUnlinkTransport,
    createDirectTriageUnlinkTransport,
} from '../sessions/cockpit/unlinkLinkedEntry.js';
import type { TriageListDisplayRowV1 } from './marks/pinnedRows.js';
import { useTriageActions } from './actions/useTriageActions.js';
import { useTriageConfiguredSources } from './configuration/useTriageConfiguredSources.js';
import { useTriageDurableAccount } from './durable/accountDurableState.js';
import { useTriagePinnedEntries } from './marks/useTriagePinnedEntries.js';
import { useTriageSavedViews } from './views/useTriageSavedViews.js';

/**
 * Durable user state with no daemon reachable.
 *
 * Pins, saved views, configured actions and Session links are **Account** state.
 * The Account server can be reachable while no daemon is, and when that happens
 * the reader's own saved state must keep working — only the provider half of
 * the product goes stale. This file drives every one of those four through a
 * real mounted surface while EVERY host Action dispatch fails, which is exactly
 * what a mount with no reachable daemon sees.
 *
 * Nothing between the hook and the durable owner is stood in for. The Account
 * Collection store and the Account Settings record are replaced — those are the
 * two genuine system boundaries — and the identity derivation, the codec, the
 * CAS decision, the bounds and the conflict verdicts underneath are all real.
 *
 * The failure this exists to catch is the one the product shipped with: a Pin
 * that silently does nothing, and a saved view that reads as "you saved none",
 * because the only transport was a daemon Action.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLUGIN_ID = 'happier.triage';
const SESSION_ID = 'session-no-daemon-1';

type DurableHarness = Readonly<{
    corpus: TestkitCorpusCollections;
    accountSettings: TestkitAccountSettings;
    client: PluginUiDataClient;
    actionCalls: readonly string[];
}>;

/**
 * A mount that can reach the Account and cannot reach any daemon.
 *
 * `collection` hands back this plugin's own testkit-backed handles by the
 * declared collection id, which is what the real client does through the
 * Account availability projection. `openCollectionQuery` is never opened by the
 * surfaces under test and says so rather than answering with an empty page.
 */
function createDurableHarness(options: Readonly<{
    /** Set false to prove these hooks genuinely depend on the direct seam. */
    accountReachable?: boolean;
    /** Genuine Collection CAS boundary refusal for the configured-source writer. */
    sourceRemoveConflict?: boolean;
}> = {}): DurableHarness {
    const corpus = createTestkitCorpusCollections();
    const accountSettings = createTestkitAccountSettings();
    const actionCalls: string[] = [];
    const sourceInstances = options.sourceRemoveConflict !== true
        ? corpus.collections.sourceInstances
        : {
            ...corpus.collections.sourceInstances,
            batch: async () => ({ status: 'conflict' as const, conflicts: [] }),
        };
    const byId = new Map<string, unknown>([
        ['source-instances', sourceInstances],
        ['session-links', corpus.collections.sessionLinks],
        ['user-marks', corpus.collections.userMarks],
    ]);

    const settings: PluginUiAccountSettings = {
        snapshot: (o) => accountSettings.settings.snapshot(o),
        get: (id, o) => accountSettings.settings.get(id, o),
        set: (id, value, o) => accountSettings.settings.set(id, value, o),
        reset: (id, o) => accountSettings.settings.reset(id, o),
    };

    const client = {
        collection(definition: Readonly<{ id: string }>) {
            const bound = byId.get(definition.id);
            if (!bound) throw new Error(`Undeclared Collection: ${definition.id}`);
            return bound as ReturnType<PluginUiDataClient['collection']>;
        },
        async openCollectionQuery() {
            throw new Error('These surfaces open no declared UI query.');
        },
        accountKv: createUnavailablePluginUiAccountKv(),
        accountSettings: settings,
    } as unknown as PluginUiDataClient;

    return {
        corpus,
        accountSettings,
        client: options.accountReachable === false ? (null as unknown as PluginUiDataClient) : client,
        actionCalls,
    };
}

/**
 * The whole durable surface of this program in one mounted probe.
 *
 * It renders what each hook says rather than what it was handed, so a hook that
 * silently reported "unavailable" cannot pass by having been called.
 */
const durableProbeSurface = defineUiSurface(() => {
    const host = usePluginHostApi();
    const durable = useTriageDurableAccount();
    const pins = useTriagePinnedEntries();
    const views = useTriageSavedViews();
    const actions = useTriageActions();
    const sources = useTriageConfiguredSources();
    const [unlinked, setUnlinked] = React.useState<string>('unlink:idle');

    const firstPin = pins.pins[0];
    // The exact selection the cockpit row makes, over the exact factories it
    // uses: a probe that called the writer itself would prove the writer and
    // nothing about how a mount reaches it.
    const unlinkTransport = React.useMemo(
        () => durable.collections
            ? createDirectTriageUnlinkTransport(durable.collections)
            : createActionTriageUnlinkTransport(host),
        [durable.collections, host],
    );

    return (
        <>
            <Text value={durable.collections === null ? 'reach:none' : 'reach:account'} />
            <Text
                value={pins.unavailableReason === null
                    ? `pins:[${pins.pins.map((pin) => pin.displayAtMark.title).join(',')}]`
                    : 'pins:unavailable'}
            />
            <Text
                value={views.unavailableReason !== null
                    ? 'views:unavailable'
                    : views.saved === null
                        ? 'views:reading'
                        : `views:${views.saved.kind}:[${views.saved.value.views.map((view) => view.label).join(',')}]`}
            />
            <Text
                value={actions.unavailableReason !== null
                    ? 'actions:unavailable'
                    : `actions:${actions.loaded ? 'loaded' : 'reading'}:[${actions.actions.map((action) => action.label).join(',')}]`}
            />
            <Text
                value={sources.unavailableReason !== null
                    ? 'sources:unavailable'
                    : `sources:[${sources.sources.map((source) => source.displayLabel).join(',')}]`}
            />
            <Text value={`sources-completeness:${sources.completeness}`} />
            <Text value={`sources-count:${sources.sources.length}`} />
            <Text value={`sources-notice:${sources.notice?.kind ?? 'none'}`} />
            <Button
                title="probe-remove-source"
                onPress={() => {
                    const source = sources.sources[0];
                    if (source !== undefined) void sources.remove(source.sourceInstanceId);
                }}
            />
            <Button
                title="probe-unpin"
                onPress={() => {
                    if (firstPin === undefined) return;
                    pins.setPinned({
                        key: 'probe-row',
                        pinned: true,
                        entryRef: firstPin.entryRef,
                        title: firstPin.displayAtMark.title,
                        scopeLabel: firstPin.displayAtMark.scopeLabel,
                    } as TriageListDisplayRowV1);
                }}
            />
            <Text value={unlinked} />
            <Button
                title="probe-unlink"
                onPress={() => {
                    void (async () => {
                        try {
                            const result = await unlinkTransport.unlink({
                                sessionId: SESSION_ID,
                                entryRef: testkitEntryRef(),
                            });
                            setUnlinked(`unlink:${result.status}`);
                        } catch {
                            setUnlinked('unlink:unavailable');
                        }
                    })();
                }}
            />
        </>
    );
});

function createDurableAdapter(
    dataClient: PluginUiDataClient | null,
): PluginUiSemanticSurfaceAdapter<typeof durableProbeSurface> {
    const rnwAdapter = createPluginUiRnwSemanticSurfaceAdapter();
    return {
        async mount(mountInput) {
            return await rnwAdapter.mount({
                ...mountInput,
                surface: (context: RenderContext): ReactElement => (
                    dataClient === null
                        ? mountInput.surface(context) as ReactElement
                        : cloneElement(
                            mountInput.surface(context) as ReactElement<{ dataClient?: PluginUiDataClient }>,
                            { dataClient },
                        )
                ),
            });
        },
    };
}

const mounted: PluginUiTestkit[] = [];

async function mountProbe(harness: DurableHarness): Promise<PluginUiTestkit> {
    let fixture!: PluginUiTestkit;
    const calls = harness.actionCalls as string[];
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: PLUGIN_ID,
                pluginVersion: '0.0.0',
                viewId: 'no-daemon-durable-state',
                generation: 'no-daemon-durable-state-mount',
            },
            surface: durableProbeSurface,
            surfaceContext: createSurfaceContextFixture({}),
            adapter: createDurableAdapter(harness.client),
            handlers: {
                // No daemon is reachable. Every Action dispatch fails exactly as
                // it does when the mount cannot reach a machine at all.
                executeAction: async ({ action }) => {
                    calls.push(String(action));
                    throw new Error('No daemon is reachable from this mount.');
                },
            },
        });
    });
    mounted.push(fixture);
    for (let settle = 0; settle < 4; settle += 1) {
        await act(async () => { await Promise.resolve(); });
    }
    return fixture;
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function seedPin(harness: DurableHarness, title: string): Promise<void> {
    const entryRef = testkitEntryRef();
    const markTag = await deriveUserMarkTag(harness.corpus.collections.userMarks, entryRef);
    harness.corpus.control.userMarks.seed({
        [CORPUS_USER_MARKS_FIELD.markTag]: markTag,
        pinned: true,
        markedAtMs: 5_000,
        entryRef,
        displayAtMark: { title, scopeLabel: 'example/repository' },
    });
}

function seedConfiguredSource(harness: DurableHarness, seed = 2): void {
    const suffix = String(seed).padStart(12, '0');
    harness.corpus.control.sourceInstances.seed(toCorpusStoredValue({
        instanceTag: `a${String(seed).padStart(42, '0')}`,
        sourceQualifiedId: 'happier.example.source/example-forge',
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: seed,
        configured: TriageConfiguredSourceInstanceV1Schema.parse({
            v: 1,
            instance: {
                source: { pluginId: 'happier.example.source', localId: 'example-forge' },
                sourceInstanceId: `00000000-0000-4000-8000-${suffix}`,
            },
            binding: {
                purpose: 'triage-source',
                account: {
                    service: { pluginId: 'happier.example.source', localId: 'accounts' },
                    accountId: `account-${seed}`,
                },
            },
            localInstanceKey: `example/repository-${seed}`,
            configuration: { v: 1, token: `routing-token-${seed}` },
            locator: {
                v: 1,
                displayLabel: seed === 2 ? 'Example repository' : `Example repository ${seed}`,
                displayPath: `example/repository-${seed}`,
            },
        }),
    }));
}

describe('durable Account state with no daemon reachable', () => {
    it('reads pins, saved views and configured actions from the Account while every daemon Action fails', async () => {
        const harness = createDurableHarness();
        await seedPin(harness, 'Replace the duplicated normalizer');
        harness.accountSettings.seed(TRIAGE_SAVED_VIEWS_SETTING_ID_V1, {
            v: 1,
            views: [{
                viewId: '11111111-2222-4333-8444-555555555555',
                label: 'Needs me',
                filters: { sources: [], types: [], scopes: [], states: ['open'], attention: ['required'] },
                order: 'smart',
                smartPolicy: { v: 1, precedence: ['attention', 'activity'] },
            }],
            selectedViewId: '11111111-2222-4333-8444-555555555555',
        });
        harness.accountSettings.seed(TRIAGE_ACTIONS_SETTING_ID_V1, {
            v: 1,
            actions: [{
                actionId: 'action-1',
                label: 'Discuss',
                enabled: true,
                appliesTo: ['pullRequest'],
                profileId: null,
                workspaceMode: 'reference_only',
                target: { kind: 'agent', promptInvocationId: 'prompt-1', delivery: 'compose' },
            }],
        });

        const fixture = await mountProbe(harness);

        await expect(fixture.getByText('reach:account')).resolves.toEqual({ content: 'reach:account' });
        await expect(fixture.getByText('pins:[Replace the duplicated normalizer]'))
            .resolves.toEqual({ content: 'pins:[Replace the duplicated normalizer]' });
        await expect(fixture.getByText('views:parsed:[Needs me]'))
            .resolves.toEqual({ content: 'views:parsed:[Needs me]' });
        await expect(fixture.getByText('actions:loaded:[Discuss]'))
            .resolves.toEqual({ content: 'actions:loaded:[Discuss]' });
        // The whole point: not one of those reads went near a daemon.
        expect(harness.actionCalls).toEqual([]);
    });

    it('unpins and unlinks against the Account while every daemon Action fails', async () => {
        const harness = createDurableHarness();
        await seedPin(harness, 'Replace the duplicated normalizer');
        seedConfiguredSource(harness);
        const entryRef = testkitEntryRef();
        await linkEntryToSession({
            collections: harness.corpus.collections,
            entryRef,
            identityEntryRef: entryRef,
            sessionId: SESSION_ID,
            displayPathAtLink: 'example/repository#1',
            nowMs: 1_000,
        });

        const fixture = await mountProbe(harness);
        const markTag = await deriveUserMarkTag(harness.corpus.collections.userMarks, entryRef);
        expect(harness.corpus.control.userMarks.inspect(markTag)?.deleted).toBe(false);

        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'probe-unpin' }));
        });
        for (let settle = 0; settle < 4; settle += 1) {
            await act(async () => { await Promise.resolve(); });
        }
        // The durable row is gone, not a local flag: an unpin that only moved
        // presentation state would leave this row live.
        expect(harness.corpus.control.userMarks.inspect(markTag)?.deleted).toBe(true);
        await expect(fixture.getByText('pins:[]')).resolves.toEqual({ content: 'pins:[]' });

        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'probe-unlink' }));
        });
        for (let settle = 0; settle < 4; settle += 1) {
            await act(async () => { await Promise.resolve(); });
        }
        await expect(fixture.getByText('unlink:unlinked')).resolves.toEqual({ content: 'unlink:unlinked' });
        await expect(fixture.getByText('sources:[Example repository]'))
            .resolves.toEqual({ content: 'sources:[Example repository]' });
        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'probe-remove-source' }));
        });
        for (let settle = 0; settle < 4; settle += 1) {
            await act(async () => { await Promise.resolve(); });
        }
        await expect(fixture.getByText('sources:[]')).resolves.toEqual({ content: 'sources:[]' });
        expect(harness.actionCalls).toEqual([]);
    });

    it('keeps every overshoot row administratively reachable and reports truncated completeness', async () => {
        const harness = createDurableHarness();
        for (let seed = 1; seed <= 34; seed += 1) seedConfiguredSource(harness, seed);

        const fixture = await mountProbe(harness);

        await expect(fixture.getByText('sources-completeness:truncated')).resolves
            .toEqual({ content: 'sources-completeness:truncated' });
        await expect(fixture.getByText('sources-count:34')).resolves
            .toEqual({ content: 'sources-count:34' });
    });

    it('re-reads and publishes a typed notice when configured-source removal conflicts', async () => {
        const harness = createDurableHarness({ sourceRemoveConflict: true });
        seedConfiguredSource(harness);
        const fixture = await mountProbe(harness);

        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'probe-remove-source' }));
        });
        for (let settle = 0; settle < 4; settle += 1) {
            await act(async () => { await Promise.resolve(); });
        }

        await expect(fixture.getByText('sources-notice:conflict')).resolves
            .toEqual({ content: 'sources-notice:conflict' });
        await expect(fixture.getByText('sources:[Example repository]')).resolves
            .toEqual({ content: 'sources:[Example repository]' });
    });

    it('says the Account is unavailable, and queues nothing, when neither the Account nor a daemon can be reached', async () => {
        const harness = createDurableHarness({ accountReachable: false });
        const fixture = await mountProbe(harness);

        await expect(fixture.getByText('reach:none')).resolves.toEqual({ content: 'reach:none' });
        await expect(fixture.getByText('pins:unavailable')).resolves.toEqual({ content: 'pins:unavailable' });
        await expect(fixture.getByText('views:unavailable')).resolves.toEqual({ content: 'views:unavailable' });
        await expect(fixture.getByText('actions:unavailable')).resolves.toEqual({ content: 'actions:unavailable' });
        await expect(fixture.getByText('sources:unavailable')).resolves.toEqual({ content: 'sources:unavailable' });
        // The daemon transport was the only thing left, it was tried, and it
        // failed. Nothing was written speculatively and nothing was queued.
        expect(harness.actionCalls.length).toBeGreaterThan(0);
        expect(harness.corpus.control.userMarks.inspect('any')).toBeNull();
    });
});
