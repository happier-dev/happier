// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import {
    TriageEvidenceDisclosureProvider,
    type TriageEvidenceCandidateV1,
} from '@happier-dev/triage-sources/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { POSTHOG_ACTION_IDS, POSTHOG_PLUGIN_ID } from '../posthogContracts.js';
import { POSTHOG_ACTIVITY_WALK_STOPPED_SHORT_V1 } from '../source/detail/issueActivityContract.js';
import { POSTHOG_SAMPLE_WALK_STOPPED_SHORT_V1 } from '../source/detail/issueEventsContract.js';
import { encodePosthogConfiguration } from '../source/instance.js';

import { renderSurface } from './renderSurface.js';

/**
 * What the two paged detail panels say about their own coverage, mounted the way the
 * host mounts them.
 *
 * The reducer cases beside this file prove the state; they cannot prove the sentence.
 * Every defect here was invisible precisely because the panel rendered a settled,
 * confident screen: a walk that stopped short has the same shape as an exhausted one —
 * no continuation, so no Load more — and a page whose every row was unreadable has the
 * same shape as an issue with no recorded changes. In each case the reader was told
 * something the read never established.
 *
 * Both planes are here rather than in two files because the defect is one defect. The
 * Activity plane found it; the sampled plane had it too, spelled as a provider offset
 * that would not move rather than a `next` URL that would not verify.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COLLISION_SCOPE
    = 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1';
const ENTRY_ID = '00000000-0000-4000-8000-000000000001';

const DETAIL_INPUT = TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    instance: {
        v: 1,
        instance: {
            source: { pluginId: POSTHOG_PLUGIN_ID, localId: 'posthog-error-tracking' },
            sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
        },
        binding: {
            purpose: 'posthog-api',
            account: {
                service: { pluginId: POSTHOG_PLUGIN_ID, localId: 'posthog-api' },
                accountId: 'account-1',
            },
        },
        localInstanceKey:
            'posthog-org:https://eu.posthog.com:00000000-0000-4000-8000-0000000000a1',
        configuration: { v: 1, token: 'posthog-configuration-token-v1' },
        locator: { v: 1, displayLabel: 'Acme' },
    },
    observation: {
        entryRef: {
            source: { pluginId: POSTHOG_PLUGIN_ID, localId: 'posthog-error-tracking' },
            kindId: 'error-issue',
            collisionScope: COLLISION_SCOPE,
            entryId: ENTRY_ID,
        },
        observedAtMs: 1_760_000_700_000,
        locator: { v: 1, displayPath: 'Storefront production' },
        snapshot: {
            v: 1,
            title: 'TypeError in checkout summary',
            scopeLabel: 'Storefront production',
            state: { presentation: 'active', nativeLabel: 'Active' },
            facts: [],
        },
        viewer: { involvement: [] },
    },
    linkedSessions: [],
});

const SAMPLED_EVENTS: JsonValue = { kind: 'sampled', events: [], omittedRowCount: 0 };

const SAMPLED_STOPPED_SHORT: JsonValue = {
    kind: 'sampled',
    events: [{ uuid: 'aaaaaaaa-0000-4000-8000-000000000001', exceptions: [] }],
    omittedRowCount: 0,
    incomplete: POSTHOG_SAMPLE_WALK_STOPPED_SHORT_V1,
};

const SAMPLED_EVIDENCE: JsonValue = {
    kind: 'sampled',
    events: [{
        uuid: '00000000-0000-4000-8000-0000000000f1',
        exceptions: [],
    }],
    omittedRowCount: 0,
    frozenRequest: {
        v: 1,
        issueId: ENTRY_ID,
        from: '2026-07-16T00:00:00.000Z',
        to: '2026-08-15T00:00:00.000Z',
        filterTestAccounts: false,
        onlyAppFrames: false,
        include: ['exception', 'stacktrace', 'navigation', 'correlation'],
        limit: 3,
        offset: 0,
    },
};

function evidenceDetailInput() {
    const encoded = encodePosthogConfiguration({
        v: 1,
        organizationUuid: '00000000-0000-4000-8000-0000000000a1',
        environments: [{
            teamPathId: 4821,
            teamUuid: '00000000-0000-4000-8000-0000000000d1',
            displayName: 'Storefront production',
        }],
        scanWindowPolicy: {
            kind: 'exact',
            from: '2026-07-01T00:00:00.000Z',
            to: '2026-08-15T00:00:00.000Z',
        },
        detailWindowPolicy: {
            kind: 'exact',
            from: '2026-07-16T00:00:00.000Z',
            to: '2026-08-15T00:00:00.000Z',
        },
    });
    if (!encoded.ok) throw new Error('evidence fixture configuration must encode');
    return TriageDetailSurfaceInputV1Schema.parse({
        ...DETAIL_INPUT,
        instance: {
            ...DETAIL_INPUT.instance,
            configuration: { v: 1, token: encoded.token },
        },
    });
}

function activityResult(overrides: Readonly<Record<string, JsonValue>>): JsonValue {
    return {
        kind: 'activity',
        records: [],
        omittedRowCount: 0,
        ...overrides,
    };
}

function createHarness(
    activity: JsonValue,
    sampled: JsonValue = SAMPLED_EVENTS,
    options: Readonly<{
        onExecute?: (localId: string) => void;
        readCodeVariables?: (signal: AbortSignal) => Promise<JsonValue>;
    }> = {},
) {
    async function executeAction(
        { action, signal }: Readonly<{ action: unknown; input: unknown; signal: AbortSignal }>,
    ): Promise<JsonValue> {
        const { localId } = action as Readonly<{ localId: string }>;
        options.onExecute?.(localId);
        if (localId === POSTHOG_ACTION_IDS.issueActivity) return activity;
        if (localId === POSTHOG_ACTION_IDS.issueEvents) return sampled;
        if (localId === POSTHOG_ACTION_IDS.codeVariables) {
            if (options.readCodeVariables !== undefined) {
                return await options.readCodeVariables(signal);
            }
            return { kind: 'revealed', variablesText: '{\n  "token": "captured-secret"\n}' };
        }
        // The live entry read is not what these cases are about; the body falls back to
        // the observation it was mounted with when it does not settle.
        if (localId === POSTHOG_ACTION_IDS.get) return { kind: 'unreadable-by-design' };
        throw new Error(`unexpected action ${localId}`);
    }
    return { executeAction };
}

const mounted: PluginUiTestkit[] = [];

async function mountDetail(
    activity: JsonValue,
    sampled: JsonValue = SAMPLED_EVENTS,
    options: Parameters<typeof createHarness>[2] = {},
): Promise<PluginUiTestkit> {
    const harness = createHarness(activity, sampled, options);
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: POSTHOG_PLUGIN_ID,
                pluginVersion: '0.0.0',
                viewId: 'posthog-detail',
                generation: 'posthog-detail-mount',
            },
            surface: renderSurface,
            surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            launchInput: DETAIL_INPUT as unknown as JsonValue,
            handlers: {
                executeAction: async ({ action, input, signal }) =>
                    await harness.executeAction({ action, input, signal }),
            },
        });
    });
    mounted.push(fixture);
    return fixture;
}

async function mountDetailWithEvidenceDisclosure(): Promise<Readonly<{
    page: PluginUiTestkit;
    disclosed: () => TriageEvidenceCandidateV1 | null;
}>> {
    let candidate: TriageEvidenceCandidateV1 | null = null;
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: POSTHOG_PLUGIN_ID,
                pluginVersion: '0.0.0',
                viewId: 'posthog-detail',
                generation: 'posthog-detail-evidence-disclosure',
            },
            surface: (context) => (
                <TriageEvidenceDisclosureProvider disclosure={{
                    available: true,
                    disclose: async (resolve) => {
                        candidate = await resolve(new AbortController().signal);
                        return candidate === null ? { kind: 'cancelled' } : { kind: 'applied' };
                    },
                }}>
                    {renderSurface(context)}
                </TriageEvidenceDisclosureProvider>
            ),
            surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            launchInput: evidenceDetailInput() as unknown as JsonValue,
            handlers: {
                executeAction: async ({ action }) => {
                    const { localId } = action as Readonly<{ localId: string }>;
                    if (localId === POSTHOG_ACTION_IDS.issueEvents) return SAMPLED_EVIDENCE;
                    if (localId === POSTHOG_ACTION_IDS.get) return { kind: 'unreadable-by-design' };
                    if (localId === POSTHOG_ACTION_IDS.issueActivity) return activityResult({});
                    throw new Error(`unexpected action ${localId}`);
                },
            },
        });
    });
    mounted.push(fixture);
    return { page: fixture, disclosed: () => candidate };
}

async function selectTab(page: PluginUiTestkit, name: string): Promise<void> {
    await act(async () => {
        await page.press(await page.getByRole('tab', { name }));
    });
}

async function mountActivity(activity: JsonValue): Promise<PluginUiTestkit> {
    const page = await mountDetail(activity);
    await selectTab(page, 'Activity');
    return page;
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted PostHog Activity panel', () => {
    it('says the list stops short when PostHog named a page this build will not follow', async () => {
        const page = await mountActivity(activityResult({
            records: [{
                id: '01994b1e-0000-4000-8000-0000000000a1',
                activity: 'updated',
                isSystem: false,
                changedFields: ['status'],
            }],
            incomplete: POSTHOG_ACTIVITY_WALK_STOPPED_SHORT_V1,
        }));

        // The count on its own reads as the whole of what PostHog recorded, because
        // there is no Load more beside it to suggest otherwise.
        await expect(page.getByText('1 activity record(s) read.')).resolves.toBeDefined();
        await expect(page.getByText(
            'PostHog recorded more activity than this list could read, so it stops here.',
        )).resolves.toBeDefined();
    });

    it('claims PostHog recorded nothing only when the page was genuinely empty', async () => {
        const page = await mountActivity(activityResult({}));

        await expect(page.getByText('No recorded activity')).resolves.toBeDefined();
        await expect(page.getByText('PostHog has recorded no changes to this issue.'))
            .resolves.toBeDefined();
    });

    it('does not call a page of unreadable rows an issue with no recorded changes', async () => {
        const page = await mountActivity(activityResult({ omittedRowCount: 3 }));

        // Three rows existed. Saying PostHog recorded no changes is a claim about the
        // provider that this read is in no position to make.
        await expect(page.getByText('No readable activity')).resolves.toBeDefined();
        await expect(page.getByText('3 record(s) on the pages read could not be understood.'))
            .resolves.toBeDefined();
    });
});

describe('the mounted PostHog Occurrences panel', () => {
    it('says the sample stops short when PostHog offered an offset this build refused', async () => {
        const page = await mountDetail(activityResult({}), SAMPLED_STOPPED_SHORT);
        await selectTab(page, 'Occurrences');

        // The standing sample disclosure is about sampling and is always true; it is
        // not this fact, and a reader who has both still needs to be told the walk
        // itself ended early.
        await expect(page.getByText(
            'PostHog offered more of this sample than this build could page, so it stops here.',
        )).resolves.toBeDefined();
    });

    it('says nothing of the kind when the provider itself ended the sample', async () => {
        const page = await mountDetail(activityResult({}), {
            kind: 'sampled',
            events: [{ uuid: 'aaaaaaaa-0000-4000-8000-000000000001', exceptions: [] }],
            omittedRowCount: 0,
        });
        await selectTab(page, 'Occurrences');

        await expect(page.getByText(
            'PostHog offered more of this sample than this build could page, so it stops here.',
        )).rejects.toBeDefined();
    });
});

describe('the mounted PostHog Affected Sessions panel', () => {
    it('uses a localized row label without exposing the opaque provider session id', async () => {
        const opaqueSessionId = '01J6A9H4R2YQ4Y8B9F7P2Q6N3M';
        const page = await mountDetail(activityResult({}), {
            kind: 'sampled',
            events: [{
                uuid: 'aaaaaaaa-0000-4000-8000-000000000001',
                sessionId: opaqueSessionId,
                exceptions: [],
            }],
            omittedRowCount: 0,
        });
        await selectTab(page, 'Affected sessions');

        await expect(page.getByText('Sampled session')).resolves.toBeDefined();
        await expect(page.getByText('1 sampled occurrence(s)')).resolves.toBeDefined();
        await expect(page.getByText(opaqueSessionId)).rejects.toBeDefined();
    });
});

describe('the mounted PostHog selected-evidence control', () => {
    it('discloses the selected occurrence through Triage without receiving Composer authority', async () => {
        const mountedEvidence = await mountDetailWithEvidenceDisclosure();
        await selectTab(mountedEvidence.page, 'Stack trace');

        await act(async () => {
            await mountedEvidence.page.press(await mountedEvidence.page.findByRole('button', {
                name: 'Add selected occurrence to message',
            }));
        });

        expect(mountedEvidence.disclosed()).toMatchObject({
            reference: { pluginId: POSTHOG_PLUGIN_ID, localId: 'posthog-evidence' },
            candidate: {
                label: 'PostHog occurrence 00000000-0000-4000-8000-0000000000f1',
            },
        });
    });
});

describe('the mounted PostHog sensitive code-variable control', () => {
    it('requires confirmation and discards every revealed byte when the panel is left', async () => {
        let revealReads = 0;
        const page = await mountDetail(activityResult({}), SAMPLED_EVIDENCE, {
            onExecute: (localId) => {
                if (localId === POSTHOG_ACTION_IDS.codeVariables) revealReads += 1;
            },
        });
        await selectTab(page, 'Stack trace');

        await act(async () => {
            await page.press(await page.getByRole('button', { name: 'Reveal captured variables' }));
            await Promise.resolve();
            await Promise.resolve();
        });
        await expect(page.getByText('Reveal sensitive captured variables?')).resolves.toBeDefined();
        await expect(page.getByText('{ "token": "captured-secret" }')).rejects.toBeDefined();
        expect(revealReads).toBe(0);

        await act(async () => {
            await page.press(await page.getByRole('button', { name: 'Reveal captured variables' }));
            await Promise.resolve();
            await Promise.resolve();
        });
        await expect(page.getByText('Captured variables')).resolves.toBeDefined();
        await expect(page.getByText('{ "token": "captured-secret" }')).resolves.toBeDefined();
        expect(revealReads).toBe(1);

        await selectTab(page, 'Overview');
        await selectTab(page, 'Stack trace');
        await expect(page.getByText('{ "token": "captured-secret" }')).rejects.toBeDefined();
        await expect(page.getByRole('button', { name: 'Reveal captured variables' }))
            .resolves.toBeDefined();
    });

    it('aborts an in-flight reveal and ignores its late bytes after the panel is left', async () => {
        let observedSignal: AbortSignal | undefined;
        let settle!: (value: JsonValue) => void;
        const pending = new Promise<JsonValue>((resolve) => {
            settle = resolve;
        });
        const page = await mountDetail(activityResult({}), SAMPLED_EVIDENCE, {
            readCodeVariables: async (signal) => {
                observedSignal = signal;
                return await pending;
            },
        });
        await selectTab(page, 'Stack trace');
        await act(async () => {
            await page.press(await page.getByRole('button', { name: 'Reveal captured variables' }));
        });
        await act(async () => {
            await page.press(await page.getByRole('button', { name: 'Reveal captured variables' }));
        });
        await expect(page.getByRole('button', { name: 'Revealing captured variables' }))
            .resolves.toBeDefined();

        await selectTab(page, 'Overview');
        expect(observedSignal?.aborted).toBe(true);
        await act(async () => {
            settle({ kind: 'revealed', variablesText: 'late-sensitive-byte' });
            await pending;
            await Promise.resolve();
        });
        await selectTab(page, 'Stack trace');

        await expect(page.getByText('late-sensitive-byte')).rejects.toBeDefined();
        await expect(page.getByRole('button', { name: 'Reveal captured variables' }))
            .resolves.toBeDefined();
    });
});
