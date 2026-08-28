// @vitest-environment jsdom
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type {
    ComposerAttachmentViewV1,
    ComposerSnapshotV1,
    ComposerTransactionV1,
} from '@happier-dev/plugin-ui';
import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageScanInputV1,
    type TriageScanResultV1,
    type TriageSourceFailureV1,
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
import { createTriageEphemeralSharedScopeFixture } from '../ui/window/ephemeralSharedScope.test-support.js';
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

function createHarness(options: Readonly<{
    scanFailure?: TriageSourceFailureV1;
    cancelFirstComposerApply?: boolean;
}> = {}) {
    const { collections, control } = createTestkitCorpusCollections();
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow()));

    const scanCalls = { count: 0 };
    const listActionCalls: unknown[] = [];

    const scan = async (input: TriageScanInputV1): Promise<TriageScanResultV1> => {
        void input;
        scanCalls.count += 1;
        if (options.scanFailure !== undefined) {
            return { kind: 'failed', failure: options.scanFailure };
        }
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
    let attachments: ComposerAttachmentViewV1[] = [];
    let revision = 4;
    let nextAttachmentInstanceId = 1;
    let composerApplyCancelled = false;

    const snapshot = (ref: unknown): ComposerSnapshotV1 => ({
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
    }) as ComposerSnapshotV1;

    const applyCanonicalTransaction = (
        transaction: ComposerTransactionV1,
    ): Readonly<{ status: 'applied'; attachmentInstanceIds: readonly string[] }>
        | Readonly<{ status: 'conflict' }> => {
        if (transaction.expectedRevision !== revision) return { status: 'conflict' };
        const attachmentInstanceIds: string[] = [];
        for (const operation of transaction.operations) {
            if (operation.kind === 'attachment.add') {
                const existing = attachments.find((attachment) => (
                    attachment.attachment.pluginId === 'happier.triage'
                    && attachment.attachment.localId === operation.attachmentLocalId
                    && attachment.key === operation.value.key
                ));
                const instanceId = existing?.instanceId ?? `triage-entry-${nextAttachmentInstanceId++}`;
                const next: ComposerAttachmentViewV1 = {
                    v: 1,
                    instanceId,
                    attachment: {
                        pluginId: 'happier.triage',
                        localId: operation.attachmentLocalId,
                    },
                    key: operation.value.key,
                    value: operation.value.value,
                    // The real Composer host stamps the attachment declaration's
                    // title onto every admitted author presentation. Keep this
                    // mounted-host fixture faithful to that boundary so emitted
                    // canonical snapshots satisfy the public view contract.
                    presentation: {
                        ...operation.value.presentation,
                        typeLabel: 'PRs & Issues',
                    },
                    availability: { status: 'ready' },
                } as ComposerAttachmentViewV1;
                attachments = existing === undefined
                    ? [...attachments, next]
                    : attachments.map((attachment) => attachment === existing ? next : attachment);
                attachmentInstanceIds.push(instanceId);
            } else if (operation.kind === 'attachment.remove') {
                attachments = attachments.filter((attachment) => attachment.instanceId !== operation.instanceId);
            }
        }
        revision += 1;
        return { status: 'applied', attachmentInstanceIds };
    };

    const watchSignals: AbortSignal[] = [];
    const watchDisposals: number[] = [];
    const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();

    return {
        applyCalls,
        openCalls,
        readCalls,
        snapshot,
        replaceCanonicalAttachments(next: readonly ComposerAttachmentViewV1[]) {
            attachments = [...next];
            revision += 1;
        },
        get attachments() {
            return attachments as readonly ComposerAttachmentViewV1[];
        },
        watchSignals,
        watchDisposals,
        ephemeralSharedScope,
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
                    snapshot: snapshot(ref),
                } as never;
            },
            watchComposer: ({ signal }: Readonly<{ signal: AbortSignal }>) => {
                watchSignals.push(signal);
                const watchNumber = watchSignals.length;
                return {
                    dispose: () => { watchDisposals.push(watchNumber); },
                };
            },
            applyComposer: ({ ref, transaction }: Readonly<{ ref: unknown; transaction: unknown }>) => {
                applyCalls.push({ ref, transaction });
                if (options.cancelFirstComposerApply === true && !composerApplyCancelled) {
                    composerApplyCancelled = true;
                    throw new DOMException('The host stopped the request.', 'AbortError');
                }
                const outcome = applyCanonicalTransaction(transaction as ComposerTransactionV1);
                return outcome.status === 'conflict'
                    ? { status: 'conflict', currentRevision: revision } as never
                    : { status: 'applied', revision, attachmentInstanceIds: outcome.attachmentInstanceIds } as never;
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
    /** The reader's own environment, when the case is about that environment. */
    environment: Readonly<{ direction?: 'ltr' | 'rtl'; textScale?: number }> = {},
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
            surfaceContext: createSurfaceContextFixture(environment),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({
                ephemeralSharedScope: harness.ephemeralSharedScope,
            }),
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
    environment: Readonly<{ direction?: 'ltr' | 'rtl'; textScale?: number }> = {},
): Promise<PluginUiTestkit> {
    const fixture = await openPicker(harness, composer, viewId, environment);
    await act(async () => {
        await refreshTriageListWindow(
            'view',
            fixture.context.hostApi,
            harness.ephemeralSharedScope,
        );
    });
    await act(async () => { await Promise.resolve(); });
    return fixture;
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted Composer entry picker', () => {
    it('derives multi-selection and later row state only from the canonical Composer snapshot', async () => {
        const harness = createHarness();
        const picker = await mountPicker(harness, COMPOSER_A, 'triage-picker-canonical-selection');

        await picker.press(await picker.getByRole('button', {
            name: 'Attach Replace the duplicated normalizer',
        }));
        await act(async () => { await Promise.resolve(); });
        await act(async () => {
            picker.emitComposerSnapshot(COMPOSER_A, harness.snapshot(COMPOSER_A));
            await Promise.resolve();
        });
        await expect(picker.findByRole('button', {
            name: 'Remove Replace the duplicated normalizer',
        })).resolves.toBeDefined();
        await picker.press(await picker.getByRole('button', { name: 'Attach Older change' }));
        await act(async () => { await Promise.resolve(); });
        await act(async () => {
            picker.emitComposerSnapshot(COMPOSER_A, harness.snapshot(COMPOSER_A));
            await Promise.resolve();
        });

        expect(harness.attachments).toHaveLength(2);
        expect(harness.attachments.map((attachment) => (
            (attachment.value as Readonly<{ entryRef: Readonly<{ entryId: string }> }>).entryRef.entryId
        ))).toEqual(['42', '43']);
        await expect(picker.findByRole('button', {
            name: 'Remove Replace the duplicated normalizer',
        })).resolves.toBeDefined();
        await expect(picker.findByRole('button', { name: 'Remove Older change' }))
            .resolves.toBeDefined();

        // A host badge removal or undo bypasses this picker completely. The
        // next canonical observation is therefore the discriminating proof
        // that there is no remembered picker selection to survive it.
        const attachment42 = harness.attachments[0]!;
        const attachment43 = harness.attachments[1]!;
        harness.replaceCanonicalAttachments([attachment43]);
        await act(async () => {
            picker.emitComposerSnapshot(COMPOSER_A, harness.snapshot(COMPOSER_A));
            await Promise.resolve();
        });
        await expect(picker.findByRole('button', {
            name: 'Attach Replace the duplicated normalizer',
        })).resolves.toBeDefined();
        await expect(picker.findByRole('button', { name: 'Remove Older change' }))
            .resolves.toBeDefined();

        // A canonical keyed update is equally authoritative: moving the one
        // surviving attachment to the other entry changes both rows without a
        // picker-side write or remount.
        harness.replaceCanonicalAttachments([{
            ...attachment42,
            instanceId: attachment43.instanceId,
        }]);
        await act(async () => {
            picker.emitComposerSnapshot(COMPOSER_A, harness.snapshot(COMPOSER_A));
            await Promise.resolve();
        });
        await expect(picker.findByRole('button', {
            name: 'Remove Replace the duplicated normalizer',
        })).resolves.toBeDefined();
        await expect(picker.findByRole('button', { name: 'Attach Older change' }))
            .resolves.toBeDefined();

        expect(harness.watchSignals.length).toBeGreaterThan(0);
        expect(harness.watchSignals.at(-1)?.aborted).toBe(false);
        mounted.splice(mounted.indexOf(picker), 1);
        await picker.dispose();
        expect(harness.watchSignals.every((signal) => signal.aborted)).toBe(true);
        expect(harness.watchDisposals).toEqual(harness.watchSignals.map((_, index) => index + 1));
    });

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

    it('settles a cancelled attachment mutation and keeps the control retryable', async () => {
        const harness = createHarness({ cancelFirstComposerApply: true });
        const picker = await mountPicker(harness, COMPOSER_A, 'triage-picker-cancelled-attach');

        const attach = await picker.getByRole('button', {
            name: 'Attach Replace the duplicated normalizer',
        });
        await expect(picker.press(attach)).resolves.toBeUndefined();

        const retry = await picker.getByRole('button', {
            name: 'Attach Replace the duplicated normalizer',
        });
        // Omitted semantic state is the public adapter's default enabled/idle
        // state; an explicit `false` and an omitted default are equivalent.
        expect(retry.state?.busy ?? false).toBe(false);
        expect(retry.state?.disabled ?? false).toBe(false);
        expect(harness.attachments).toEqual([]);

        await expect(picker.press(retry)).resolves.toBeUndefined();
        expect(harness.attachments).toHaveLength(1);
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
                // The address of the draft this reader was writing in — THIS
                // picker's stamped mount, not "the" composer. With two live
                // drafts the other one is one wrong resolution away, so the
                // exact ref is what travels, inside the closed launch input.
                originComposer: COMPOSER_A,
            },
        }]);
        // Independent actions: View details is not a second way to attach, and
        // an attach is not a navigation. Carrying an address is not a write:
        // no draft operation followed.
        expect(harness.applyCalls).toEqual([]);
    });

    it('carries its own mount address, never the other live composer', async () => {
        const harness = createHarness();
        const pickerB = await mountPicker(harness, COMPOSER_B, 'triage-picker-details-b');

        await pickerB.press(await pickerB.getByRole('button', {
            name: 'View details Older change',
        }));
        await act(async () => { await Promise.resolve(); });

        expect(harness.openCalls.map((call) => (call.input as { originComposer?: unknown }).originComposer))
            .toEqual([COMPOSER_B]);
    });

    it('paces Refresh when every configured connection failed with a stated deadline', async () => {
        const harness = createHarness({
            scanFailure: {
                class: 'rateLimit',
                code: 'rate_limited',
                retryNotBeforeMs: Date.now() + 600_000,
            },
        });
        const picker = await mountPicker(harness, COMPOSER_A, 'triage-picker-unreadable');

        // The failure is named beside the picker's own chrome rather than
        // replacing it. `resolveState` puts freshness ahead of source health for
        // exactly this reason, and the ordering is why the `sourcesUnavailable`
        // arm below cannot fire: a lane that failed also makes the window stale.
        await expect(picker.getByText('example/repository'))
            .resolves.toEqual({ content: 'example/repository' });
        expect(await picker.queryByText('No source could be read')).toBeUndefined();
        // The only connection stated its own retry deadline, so the press this
        // control offers is already refused by the one pacing owner. An enabled
        // Refresh here is a press that does nothing and says nothing — exactly
        // what the pacing model exists to end.
        const refresh = await picker.getByRole('button', { name: 'Refresh' });
        expect(refresh.state?.disabled ?? false).toBe(true);
        // And the wait is stated, in the source's own reason.
        await expect(picker.getByText('A source asked us to wait before reading it again.'))
            .resolves.toEqual({ content: 'A source asked us to wait before reading it again.' });
    });

    it('keeps both controls, in one order, at the largest text and under RTL', async () => {
        const harness = createHarness();
        // The two environments the row layout is actually asked to survive: the
        // reader's largest supported type size, which grows every control, and a
        // right-to-left locale, which mirrors where things sit.
        const picker = await mountPicker(harness, COMPOSER_A, 'triage-picker-rtl', {
            direction: 'rtl',
            textScale: 2,
        });

        const names = (await picker.getAllByRole('button')).map((button) => button.name);
        // Nothing is dropped, hidden behind an overflow, or collapsed into a
        // single combined control when the row runs out of width.
        expect(names).toContain('Attach Replace the duplicated normalizer');
        expect(names).toContain('View details Replace the duplicated normalizer');
        // `core/COMPOSER.md` §6: RTL mirrors PLACEMENT only. Render, keyboard
        // and screen-reader order stay Attach/Remove then View details, because
        // a mirrored order makes the same row announce its actions backwards.
        expect(names.indexOf('Attach Replace the duplicated normalizer'))
            .toBeLessThan(names.indexOf('View details Replace the duplicated normalizer'));
        // And the row is still a named group rather than a run-together label.
        await expect(picker.getByRole('listitem', { name: 'Replace the duplicated normalizer' }))
            .resolves.toBeDefined();
    });

    it('names each row as a group instead of running its own text together', async () => {
        const harness = createHarness();
        const picker = await mountPicker(harness, COMPOSER_A, 'triage-picker-group');

        // `core/COMPOSER.md` §2: the row is a labelled GROUP. A row with no name
        // of its own leaves the platform to compose one from its text
        // descendants, and the reader hears the title, the scope and the status
        // run together with no separator — the same announcement the shell list
        // already had to fix once.
        await expect(picker.getByRole('listitem', { name: 'Replace the duplicated normalizer' }))
            .resolves.toBeDefined();
        await expect(picker.queryByRole('listitem', {
            name: 'Replace the duplicated normalizerexample/repository',
        })).resolves.toBeUndefined();
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
