// @vitest-environment jsdom
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@happier-dev/plugin-sdk';

import {
    TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
    TriageListEntriesResultV1Schema,
    type TriageListEntriesResultV1,
} from '../../actions/listEntriesProtocol.js';
import { TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1 } from '../../actions/savedViewsProtocol.js';
import { TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1 } from '../../actions/userMarksProtocol.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import { renderSurface as renderShellSurface } from '../surface.js';
import {
    readTriageListWindowSnapshot,
    refreshTriageListWindow,
} from '../window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';

/**
 * The one **Refresh** control, and the moment its refusal stops being true.
 *
 * `core/CORPUS.md` §4.2 requires the coordinator's waiting health to be
 * surfaced rather than bypassed, and the shell does surface it: while a source
 * has stated a retry deadline the control is disabled and the page says when
 * the next read is due. What it did not do is notice that the moment it printed
 * had arrived. Eligibility was computed from a render-time clock, the window
 * store only drops an expired refusal when something reads its snapshot, and
 * nothing reads it while a page sits idle — so a reader who waited out the
 * stated deadline was still looking at a dead control, and only unrelated state
 * activity could revive it.
 *
 * This is the recovery half of the same rule, not a request to scan: no
 * provider is read here, no cadence is introduced, and the wake is one
 * observation of one already-published deadline.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';

const ASSEMBLED_AT_MS = 1_760_000_100_000;

/**
 * The stated wait, in real milliseconds.
 *
 * The Date boundary is controlled so a short deadline cannot expire during
 * asynchronous host mounting. Timers remain real: the mounted control still
 * has to notice the published deadline without another pass or page render.
 */
const SHORT_WAIT_MS = 150;
const LONG_WAIT_MS = 10_000;
const SETTLE_MS = 150;

/**
 * The deadline each connection states, fixed at the first pass so a second pass
 * cannot quietly move the moment the test is waiting for.
 */
let deadlineMs: number | null = null;
let secondDeadlineMs: number | null = null;
let fixtureNowMs = 0;
/** The shared window scope this mount joined, so the test can read what it published. */
let mountedScope: ReturnType<typeof createTriageEphemeralSharedScopeFixture> | null = null;

function statedDeadline(waitMs: number): number {
    deadlineMs ??= Date.now() + waitMs;
    return deadlineMs;
}

function statedSecondDeadline(): number {
    secondDeadlineMs ??= Date.now() + LONG_WAIT_MS;
    return secondDeadlineMs;
}

/**
 * Wait out the refusal THIS PAGE published, not the one the fixture stated.
 *
 * A source's stated deadline is only part of the coordinator's answer — a
 * rate-limit failure also earns a jittered aggregate backoff — and the promise
 * a reader is holding the surface to is the moment it printed. Ordering the
 * wait against that published moment is what makes this a test of the control
 * waking on time rather than of a sleep that happens to be long enough.
 */
async function waitPastPublishedDeadline(shell: PluginUiTestkit): Promise<void> {
    const published = readTriageListWindowSnapshot(shell.context.hostApi, mountedScope);
    const deadline = published.refreshBlocked?.nextEligibleAtMs;
    if (deadline === undefined) throw new Error('The page published no refusal to wait out.');
    const remainingMs = Math.max(0, deadline - Date.now());
    await act(async () => {
        fixtureNowMs = deadline + 1;
        await new Promise((resolve) => {
            setTimeout(resolve, remainingMs + SETTLE_MS);
        });
    });
}

/**
 * A settled pass in which every configured connection stated its own retry
 * deadline. The refusal lifts as soon as the FIRST of them expires, because one
 * eligible connection is enough for a press to read something.
 */
function rateLimitedListResult(
    sources: 'one' | 'two',
    waitMs: number,
    rows: 'one' | 'none' = 'one',
): TriageListEntriesResultV1 {
    const lane = (sourceInstanceId: string, retryNotBeforeMs: number) => ({
        sourceInstanceId,
        source: SOURCE,
        health: {
            kind: 'failed',
            failure: { class: 'rateLimit', code: 'secondary-limit', retryNotBeforeMs },
        },
        exhausted: false,
    });
    const configured = (sourceInstanceId: string, displayLabel: string) => ({
        sourceInstanceId,
        source: SOURCE,
        displayLabel,
        available: true,
    });
    return TriageListEntriesResultV1Schema.parse({
        v: 1,
        configuredSources: sources === 'one'
            ? [configured(INSTANCE_A, 'Example account')]
            : [configured(INSTANCE_A, 'Example account'), configured(INSTANCE_B, 'Second account')],
        configuredSourcesStatus: 'complete',
        window: {
            v: 1,
            // A retained row, so the page is the ordinary "rows on screen, one
            // connection waiting" state rather than the empty screen — whose
            // own retry control would be a second Refresh in the query.
            rows: rows === 'none' ? [] : [{
                entryRef: {
                    source: SOURCE,
                    kindId: 'pull-request',
                    collisionScope: 'example/repository',
                    entryId: '17',
                },
                lane: '1-open',
                sortAtMs: ASSEMBLED_AT_MS,
                presence: { kind: 'present', observedAtMs: ASSEMBLED_AT_MS },
                selected: { kind: 'selected', sourceInstanceId: INSTANCE_A, reason: 'onlyPresent' },
                observation: {
                    sourceInstanceId: INSTANCE_A,
                    observedAtMs: ASSEMBLED_AT_MS,
                    outcome: {
                        kind: 'present',
                        locator: testkitLocator(),
                        snapshot: testkitSnapshot({ title: 'Replace the duplicated normalizer' }),
                        viewer: testkitViewer(),
                    },
                },
                otherObservations: [],
                observedByCount: 1,
            }],
            lanes: sources === 'one'
                ? [lane(INSTANCE_A, statedDeadline(waitMs))]
                : [lane(INSTANCE_A, statedDeadline(waitMs)), lane(INSTANCE_B, statedSecondDeadline())],
            coverage: 'partial',
            assembledAtMs: ASSEMBLED_AT_MS,
        },
    });
}

async function executeAction(
    action: string,
    sources: 'one' | 'two',
    waitMs: number,
    rows: 'one' | 'none',
): Promise<JsonValue> {
    if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) {
        return rateLimitedListResult(sources, waitMs, rows) as unknown as JsonValue;
    }
    if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) return { v: 1, pins: [] };
    if (action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) {
        return { v: 1, availability: 'absent', views: [], selectedViewId: null, revision: 'revision-1' };
    }
    throw new Error(`unexpected action ${action}`);
}

const mounted: PluginUiTestkit[] = [];

async function mountShell(options: Readonly<{
    sources?: 'one' | 'two';
    waitMs?: number;
    /** Answer with no rows at all: the state that renders its own retry control. */
    rows?: 'none';
}> = {}): Promise<PluginUiTestkit> {
    deadlineMs = null;
    secondDeadlineMs = null;
    fixtureNowMs = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => fixtureNowMs);
    const sources = options.sources ?? 'one';
    const waitMs = options.waitMs ?? LONG_WAIT_MS;
    const rows = options.rows ?? 'one';
    const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
    mountedScope = ephemeralSharedScope;
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-184', mountNonce: 'fixture-mount-184' },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            surface: renderShellSurface,
            surfaceContext: createSurfaceContextFixture({
                mount: {
                    kind: 'destination',
                    destination: { pluginId: 'happier.triage', localId: 'triage' },
                    container: 'appPage',
                },
            }),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope }),
            handlers: {
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action }) => await executeAction(action, sources, waitMs, rows),
                replacePageLocation: ({ subPath }) => subPath,
            },
        });
    });
    mounted.push(fixture);
    await act(async () => {
        await refreshTriageListWindow('view', fixture.context.hostApi, ephemeralSharedScope);
    });
    return fixture;
}

/** Whether the one **Refresh** control currently refuses a press. */
async function refreshDisabled(shell: PluginUiTestkit): Promise<boolean> {
    const control = await shell.getByRole('button', { name: 'Refresh' });
    return control.state?.disabled === true;
}

afterEach(async () => {
    try {
        for (const fixture of mounted.splice(0)) await fixture.dispose();
    } finally {
        vi.restoreAllMocks();
    }
});

describe('the Refresh control while a source has asked us to wait', () => {
    it('says when the next read is due and refuses the press until then', async () => {
        const shell = await mountShell();

        expect(await refreshDisabled(shell)).toBe(true);
        await expect(shell.getByText('Waiting before the next read')).resolves.toBeDefined();
        // The rows a failed connection could not refresh are still on screen.
        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
    });

    it('becomes pressable when the stated deadline passes on an idle page', async () => {
        const shell = await mountShell({ waitMs: SHORT_WAIT_MS });
        expect(await refreshDisabled(shell)).toBe(true);

        // Nothing else happens: no pass settles, no row arrives, no reader
        // touches the page. The only thing that changes is the clock reaching
        // the moment this page itself printed.
        await waitPastPublishedDeadline(shell);

        expect(await refreshDisabled(shell)).toBe(false);
        await expect(shell.queryByText('Waiting before the next read')).resolves.toBeUndefined();
    });

    it('wakes when the first of several connections becomes eligible', async () => {
        const shell = await mountShell({ sources: 'two', waitMs: SHORT_WAIT_MS });
        expect(await refreshDisabled(shell)).toBe(true);

        // The second connection is still waiting, and that is fine: one
        // eligible connection is enough for a press to read something.
        await waitPastPublishedDeadline(shell);

        expect(await refreshDisabled(shell)).toBe(false);
    });

    it('refuses the empty screen\u2019s own retry control on the same answer', async () => {
        // With no rows, the page offers a second Refresh beside its empty
        // state. One page, one decision about whether a read may happen: a
        // control that stayed pressable here would spend a press the
        // coordinator silently refuses.
        const shell = await mountShell({ rows: 'none' });

        const controls = await shell.getAllByRole('button', { name: 'Refresh' });
        expect(controls.length).toBeGreaterThan(1);
        expect(controls.every((control) => control.state?.disabled === true)).toBe(true);
    });

    it('does not wake while the refusal is still running', async () => {
        const shell = await mountShell();

        await act(async () => {
            fixtureNowMs += SHORT_WAIT_MS + SETTLE_MS;
            await new Promise((resolve) => { setTimeout(resolve, SHORT_WAIT_MS + SETTLE_MS); });
        });

        expect(await refreshDisabled(shell)).toBe(true);
    });
});
