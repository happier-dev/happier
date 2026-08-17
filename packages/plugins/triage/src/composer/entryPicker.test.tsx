// @vitest-environment jsdom
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageScanInputV1,
    type TriageScanResultV1,
    type TriageSourceScanObservationV1,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import { TriageListEntriesInputV1Schema } from '../actions/listEntriesProtocol.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import { refreshTriageListWindow } from '../ui/window/mountedWindow.js';
import { renderSurface as renderPickerSurface } from './entryPicker.js';

/**
 * The mounted Composer entry picker (`core/COMPOSER.md` §2, §3).
 *
 * Two rules decide this surface and both are tested through the real mount:
 * every mutation goes to the exact composer the host stamped on THIS mount, and
 * Attach and View details are two independent actions — one commits an
 * attachment and never navigates, the other navigates and never touches the
 * draft.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const COMPOSER_A = Object.freeze({ kind: 'session', sessionId: 'session-a' });
const COMPOSER_B = Object.freeze({ kind: 'newSession', instanceId: 'draft-b' });

function configuredInstance(): TriageConfiguredSourceInstanceV1 {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
        binding: {
            purpose: 'triage-source',
            account: { service: { pluginId: SOURCE.pluginId, localId: 'accounts' }, accountId: 'account-1' },
        },
        localInstanceKey: 'example/repository',
        configuration: { v: 1, token: 'routing-token' },
        locator: { v: 1, displayLabel: 'example/repository' },
    });
}

function instanceRow(): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: `a${'0'.repeat(42)}`,
        sourceQualifiedId: `${SOURCE.pluginId}/${SOURCE.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1,
        configured: configuredInstance(),
    };
}

function observation(entryId: string, title: string): TriageSourceScanObservationV1 {
    return {
        kind: 'present',
        localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId },
        locator: testkitLocator(),
        snapshot: testkitSnapshot({ title, scopeLabel: 'example/repository' }),
        viewer: testkitViewer(),
        sourceUpdatedAtMs: 3_000,
    };
}

type ApplyCall = Readonly<{ ref: unknown; transaction: unknown }>;
type OpenCall = Readonly<{ view: unknown; input: unknown }>;

function createHarness() {
    const { collections, control } = createTestkitCorpusCollections();
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow()));

    const scanCalls = { count: 0 };
    const listActionCalls: unknown[] = [];

    const scan = async (input: TriageScanInputV1): Promise<TriageScanResultV1> => {
        void input;
        scanCalls.count += 1;
        return {
            kind: 'complete',
            observations: [
                observation('42', 'Replace the duplicated normalizer'),
                observation('43', 'Older change'),
            ],
            evidence: { kind: 'walkFinished' },
        };
    };
    const scanHandle = { role: 'scan' };
    const admitted = [{
        contributor: {
            pluginId: SOURCE.pluginId,
            contributionId: SOURCE.localId,
            immutableGenerationId: 'generation-1',
        },
        protocol: {
            id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
            version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
        },
        descriptor: {
            v: 1,
            purpose: 'triage-source',
            displayName: 'Example forge',
            kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }],
        },
        operations: { listInstances: {}, scan: scanHandle, get: {} },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1];

    const executeScan: TriageAdmittedOperationExecutorV1 = async (operation, input) => {
        if ((operation as unknown) !== scanHandle) throw new Error('Unknown scan handle.');
        return await scan(input);
    };

    const applyCalls: ApplyCall[] = [];
    const openCalls: OpenCall[] = [];
    const readCalls: unknown[] = [];
    const attachments: unknown[] = [];
    let revision = 4;

    return {
        applyCalls,
        openCalls,
        readCalls,
        attachments,
        scanCalls,
        listActionCalls,
        handlers: {
            executeAction: async ({ action, input }: Readonly<{ action: unknown; input: unknown }>) => {
                listActionCalls.push(action);
                return await listTriageEntries(TriageListEntriesInputV1Schema.parse(input), {
                    sourceInstances: collections.sourceInstances,
                    readAdmittedSources: async () => admitted,
                    executeScan,
                    nowMs: () => Date.now(),
                }) as never;
            },
            readComposer: ({ ref }: Readonly<{ ref: unknown }>) => {
                readCalls.push(ref);
                return {
                    status: 'ready',
                    snapshot: {
                        revision,
                        ref,
                        text: 'please look at this',
                        references: [],
                        attachments,
                        layout: 'wrap',
                        capabilities: { text: true, references: true, attachments: true, submit: true },
                        state: {
                            focused: false,
                            editable: true,
                            submittable: true,
                            submitting: false,
                            running: false,
                        },
                    },
                } as never;
            },
            watchComposer: () => undefined,
            applyComposer: ({ ref, transaction }: Readonly<{ ref: unknown; transaction: unknown }>) => {
                applyCalls.push({ ref, transaction });
                revision += 1;
                return { status: 'applied', revision } as never;
            },
            openSurface: ({ view, input }: Readonly<{ view: unknown; input?: unknown }>) => {
                openCalls.push({ view, input });
            },
        },
    };
}

const mounted: PluginUiTestkit[] = [];

/**
 * Mount the picker and nothing else — no explicit demand, exactly as opening
 * the control does it. What the surface reaches on its own is the point of
 * `REQ-14`, so the helper that proves it must not reach anything for it.
 */
async function openPicker(
    harness: ReturnType<typeof createHarness>,
    composer: unknown,
    viewId: string,
): Promise<PluginUiTestkit> {
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: 'happier.triage',
                pluginVersion: '0.0.0',
                viewId,
                generation: `${viewId}-mount`,
            },
            surface: renderPickerSurface,
            surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            launchInput: {
                v: 1,
                role: 'attachmentPicker',
                composer,
                attachmentLocalId: 'entry',
                instances: [],
            } as never,
            handlers: harness.handlers as never,
        }) as PluginUiTestkit;
    });
    mounted.push(fixture);
    await act(async () => { await Promise.resolve(); });
    return fixture;
}

/** Opened, then explicitly refreshed — the only path from this surface to a provider. */
async function mountPicker(
    harness: ReturnType<typeof createHarness>,
    composer: unknown,
    viewId: string,
): Promise<PluginUiTestkit> {
    const fixture = await openPicker(harness, composer, viewId);
    await act(async () => { await refreshTriageListWindow('view'); });
    await act(async () => { await Promise.resolve(); });
    return fixture;
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted Composer entry picker', () => {
    it('reaches no provider merely by opening', async () => {
        const harness = createHarness();
        await openPicker(harness, COMPOSER_A, 'triage-picker-cold');

        // `REQ-14`. The shell page is a named materialization producer; opening
        // a Composer control is not. The picker runs in its own UI artifact and
        // therefore its own module realm, so "the window is already warm" is
        // never true here — a mount-time demand would make every open a full
        // walk of every configured source, behind a popover the reader may
        // close again immediately.
        expect(harness.scanCalls.count).toBe(0);
        expect(harness.listActionCalls).toEqual([]);
    });

    it('says it is not synchronized rather than claiming there are no sources', async () => {
        const harness = createHarness();
        const picker = await openPicker(harness, COMPOSER_A, 'triage-picker-cold-state');

        // A projection that has never run here knows nothing about configured
        // sources — including whether there are any. Reporting the cold count
        // as "no sources are configured" is the false-empty `REQ-14` exists to
        // forbid, and it also hides the one control that would fix it.
        expect(await picker.queryByText('No sources are configured')).toBeUndefined();
        await expect(picker.getByText('Refresh to read your connected sources.'))
            .resolves.toEqual({ content: 'Refresh to read your connected sources.' });
        const refresh = await picker.getByRole('button', { name: 'Refresh' });
        expect(refresh.state?.disabled ?? false).toBe(false);
    });

    it('attaches to the exact composer this mount was opened from, with no text operation', async () => {
        const harness = createHarness();
        const picker = await mountPicker(harness, COMPOSER_A, 'triage-picker-a');

        await picker.press(await picker.getByRole('button', {
            name: 'Attach Replace the duplicated normalizer',
        }));
        await act(async () => { await Promise.resolve(); });

        expect(harness.applyCalls).toHaveLength(1);
        const call = harness.applyCalls[0];
        // The exact stamped scope — not `active()`, not `current()`, not the
        // composer that happens to be focused.
        expect(call?.ref).toEqual(COMPOSER_A);
        const transaction = call?.transaction as Readonly<{
            expectedRevision: number;
            operations: readonly Readonly<{ kind: string; attachmentLocalId?: string }>[];
        }>;
        expect(transaction.expectedRevision).toBe(4);
        // Attachment only. A `text.insert` here is the mention-style
        // implementation this program deliberately does not have: it would put
        // the same entry into the message through two persisted paths.
        expect(transaction.operations.map((operation) => operation.kind)).toEqual(['attachment.add']);
        expect(transaction.operations[0]?.attachmentLocalId).toBe('entry');
    });

    it('never writes to another live composer', async () => {
        const harness = createHarness();
        const pickerB = await mountPicker(harness, COMPOSER_B, 'triage-picker-b');

        await pickerB.press(await pickerB.getByRole('button', { name: 'Attach Older change' }));
        await act(async () => { await Promise.resolve(); });

        // Two drafts are live in the product at once. A picker that resolves
        // "the" composer instead of ITS composer silently writes to the wrong
        // one, and the user finds out after sending.
        expect(harness.applyCalls.map((call) => call.ref)).toEqual([COMPOSER_B]);
        expect(harness.readCalls.every((ref) => JSON.stringify(ref) === JSON.stringify(COMPOSER_B))).toBe(true);
    });

    it('opens the entry detail from its own row action without touching the draft', async () => {
        const harness = createHarness();
        const picker = await mountPicker(harness, COMPOSER_A, 'triage-picker-details');

        await picker.press(await picker.getByRole('button', {
            name: 'View details Replace the duplicated normalizer',
        }));
        await act(async () => { await Promise.resolve(); });

        expect(harness.openCalls).toEqual([{
            view: { pluginId: 'happier.triage', localId: 'triage' },
            input: {
                v: 1,
                kind: 'entryDetail',
                entryRef: {
                    source: SOURCE,
                    kindId: 'pull-request',
                    collisionScope: 'example/repository',
                    entryId: '42',
                },
                sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
            },
        }]);
        // Independent actions: View details is not a second way to attach, and
        // an attach is not a navigation.
        expect(harness.applyCalls).toEqual([]);
    });

    it('offers both row actions for every row, in order, without a row-wide press target', async () => {
        const harness = createHarness();
        const picker = await mountPicker(harness, COMPOSER_A, 'triage-picker-actions');

        const buttons = await picker.getAllByRole('button');
        const names = buttons.map((button) => button.name);
        // Each control names its own entry: a list of identical "Attach"
        // buttons is unusable by name alone.
        expect(names).toContain('Attach Replace the duplicated normalizer');
        expect(names).toContain('View details Replace the duplicated normalizer');
        expect(names).toContain('Attach Older change');
        expect(names).toContain('View details Older change');
        // Attach/Remove always precedes View details, in render, keyboard and
        // screen-reader order alike.
        expect(names.indexOf('Attach Replace the duplicated normalizer'))
            .toBeLessThan(names.indexOf('View details Replace the duplicated normalizer'));
    });
});
