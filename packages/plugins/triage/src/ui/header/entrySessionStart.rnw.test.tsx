// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import type { TriageSourceInstanceIdV1, TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';
import { Stack, Status, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1 } from '../../actions/entrySessionProtocol.js';
import { testkitEntryRef, testkitLocator } from '../../corpus/testkit/observations.test-support.js';
import type { TriageNewSessionPreferenceV1 } from './newSessionDestination.js';
import type { TriageActionTargetV1 } from '../state/actionTarget.js';
import { TriageSessionIntentControls } from './sessionIntentControls.js';
import { useTriageEntrySessionStart } from './useEntrySessionStart.js';

/**
 * The press, end to end, through the two host boundaries it actually crosses.
 *
 * Ask and Fix name no Agent. The reader is taken to the host's own New Session
 * surface through the one no-invoke settlement a plugin may ask for, picks the
 * Agent and directory there exactly as they do for any other Session, and only
 * then does this plugin's start Action reach the orchestrator that creates,
 * links and opens. Both hops are driven here through the real mounted Host API
 * rather than a stub of it, because the whole defect these cases exist to
 * prevent is a control whose press has nowhere to go.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INSTANCE = '11111111-1111-4111-8111-111111111111';
const ENTRY_REF = testkitEntryRef();

const TARGET: TriageActionTargetV1 = {
    kind: 'entry',
    sectionId: 'open',
    entryRef: ENTRY_REF,
    sourceInstanceId: INSTANCE as TriageSourceInstanceIdV1,
};

const DISPLAY = Object.freeze({ locator: testkitLocator(), scopeLabel: 'example/repository' });

/** Exactly what the host settles back from its own New Session surface. */
const SETTLED_DRAFT = Object.freeze({
    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
    agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.claude', localId: 'claude' } },
    directory: '/workspaces/example',
    // The host's whole New Session projection travels; none of this may reach
    // the creation call.
    permissionMode: 'default',
    title: 'A title the reader never typed',
});

const NEW_SESSION_REQUEST = Object.freeze({
    hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
});

const CREATION_KEY = 'creation-key-under-test';

const mounted: PluginUiTestkit[] = [];
type ActionCall = Readonly<{ action: string; input: unknown }>;

type Script = Readonly<{
    calls: ActionCall[];
    selections: unknown[];
    /** Absent installs no `selectActionInput` on the mount at all. */
    select?: (request: unknown) => Promise<unknown>;
    result?: unknown;
    dispatchFails?: boolean;
    workflowSubject?: TriageSourceWorkflowSubjectV1;
    preference?: TriageNewSessionPreferenceV1;
    /** Absent leaves the module's own creation-key mint in place. */
    ownCreationKey?: boolean;
}>;

function HeaderUnderTest(props: Readonly<{ script: Script }>): React.ReactElement {
    const workflowSubject = props.script.workflowSubject ?? 'issue';
    // One controller, read where it is pressed: the rendered phase is the same
    // mount's, so an assertion about it is an assertion about the press.
    const controller = useTriageEntrySessionStart(
        props.script.ownCreationKey === true ? undefined : { mintCreationKey: () => CREATION_KEY },
    );
    return (
        <Stack gap="small">
            <TriageSessionIntentControls
                target={TARGET}
                workflowSubject={workflowSubject}
                preparesReviewWorkspace
                onIntent={(request) => {
                    controller.start({
                        intent: request.intent,
                        entryRef: request.entryRef,
                        workflowSubject,
                        display: DISPLAY,
                        ...(props.script.preference ? { preference: props.script.preference } : {}),
                    });
                }}
            />
            <Status tone="muted" label={`phase:${controller.phase.kind}`} />
            <Status
                tone="muted"
                label={`outcome:${controller.phase.kind === 'settled' ? controller.phase.result.type : 'none'}`}
            />
            <Status
                tone="muted"
                label={`reason:${controller.phase.kind === 'unavailable' ? controller.phase.reason : 'none'}`}
            />
        </Stack>
    );
}

async function mountHeader(script: Script): Promise<PluginUiTestkit> {
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: 'happier.triage',
                pluginVersion: '0.0.0',
                viewId: 'triage-list',
                generation: 'triage-session-start',
            },
            surface: defineUiSurface((_context: RenderContext) => <HeaderUnderTest script={script} />),
            surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: {
                executeAction: async ({ action, input }) => {
                    script.calls.push({ action: String(action), input });
                    if (script.dispatchFails === true) throw new Error('this mount cannot dispatch an Action');
                    return script.result as never;
                },
                ...(script.select
                    ? {
                        selectActionInput: async ({ request }) => {
                            script.selections.push(request);
                            return await script.select!(request) as never;
                        },
                    }
                    : {}),
            },
        });
    });
    mounted.push(fixture);
    return fixture;
}

function settleWith(draft: unknown): (request: unknown) => Promise<unknown> {
    return async () => ({ kind: 'serverStartDraft', draft });
}

const OPENED = Object.freeze({ v: 1, type: 'opened', sessionId: 'session-a', disposition: 'created' });

async function pressAsk(fixture: PluginUiTestkit): Promise<void> {
    await act(async () => {
        await fixture.press(await fixture.getByRole('button', { name: 'Ask' }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('pressing the common header', () => {
    it('takes the reader to the host New Session surface, then starts on what they settled', async () => {
        const script: Script = {
            calls: [], selections: [], select: settleWith(SETTLED_DRAFT), result: OPENED,
        };
        const fixture = await mountHeader(script);

        await pressAsk(fixture);

        // Triage names no Agent: it asks for the host's own surface and adds no
        // seed, because nothing in Triage settings had anything to say.
        expect(script.selections).toEqual([NEW_SESSION_REQUEST]);
        // The whole point of the lane: a press now reaches the orchestrator,
        // carrying the exact Agent, machine and directory the reader chose —
        // and nothing else the draft happened to hold.
        expect(script.calls).toEqual([{
            action: TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
            input: {
                v: 1,
                intent: 'ask',
                workflowSubject: 'issue',
                entryRef: ENTRY_REF,
                display: DISPLAY,
                destination: {
                    kind: 'new',
                    creationKey: CREATION_KEY,
                    spawn: {
                        executionTarget: SETTLED_DRAFT.executionTarget,
                        agentTarget: SETTLED_DRAFT.agentTarget,
                    },
                    materialization: { kind: 'referenceOnly', directory: '/workspaces/example' },
                },
            },
        }]);
        await expect(fixture.getByText('outcome:opened')).resolves
            .toEqual({ content: 'outcome:opened' });
    });

    it('pre-selects the Agent Triage settings pins, and still lets the reader decide', async () => {
        const script: Script = {
            calls: [],
            selections: [],
            select: settleWith(SETTLED_DRAFT),
            result: OPENED,
            preference: { agentId: 'codex' },
        };
        const fixture = await mountHeader(script);

        await pressAsk(fixture);

        // A seed, not a bypass: the surface still opens and the settled Agent
        // is the one it returned, not the one Triage asked for.
        expect(script.selections).toEqual([{ ...NEW_SESSION_REQUEST, draft: { agentId: 'codex' } }]);
        expect(script.calls).toHaveLength(1);
    });

    it('starts nothing when the reader closes the New Session surface', async () => {
        const script: Script = {
            calls: [], selections: [], select: async () => ({ kind: 'cancelled' }), result: OPENED,
        };
        const fixture = await mountHeader(script);

        await pressAsk(fixture);

        // The untouched case. A cancelled choice must leave no Session, no
        // link and no creation key spent — and must not report a failure the
        // reader did not cause.
        expect(script.calls).toEqual([]);
        await expect(fixture.getByText('phase:idle')).resolves.toEqual({ content: 'phase:idle' });
    });

    it('never opens a Session surface for a pull-request Fix this wire cannot request', async () => {
        const script: Script = {
            calls: [],
            selections: [],
            select: settleWith(SETTLED_DRAFT),
            result: OPENED,
            workflowSubject: 'pullRequest',
        };
        const fixture = await mountHeader(script);

        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'Fix / review' }));
        });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        // Spending the reader's Agent and directory choice on a start the gate
        // rejects afterwards is worse than saying so before they make it.
        expect(script.selections).toEqual([]);
        expect(script.calls).toEqual([]);
        await expect(fixture.getByText('reason:pullRequestFixUnsupported')).resolves
            .toEqual({ content: 'reason:pullRequestFixUnsupported' });
    });

    it('starts nothing on a mount that cannot open the host New Session surface', async () => {
        const script: Script = { calls: [], selections: [], result: OPENED };
        const fixture = await mountHeader(script);

        await pressAsk(fixture);

        expect(script.calls).toEqual([]);
        await expect(fixture.getByText('reason:newSessionUnsupported')).resolves
            .toEqual({ content: 'reason:newSessionUnsupported' });
    });

    it('starts nothing when the settlement is not a draft this start can be built from', async () => {
        const script: Script = {
            calls: [],
            selections: [],
            select: settleWith({ ...SETTLED_DRAFT, agentTarget: { kind: 'agent', identity: {} } }),
            result: OPENED,
        };
        const fixture = await mountHeader(script);

        await pressAsk(fixture);

        expect(script.calls).toEqual([]);
        await expect(fixture.getByText('reason:newSessionUnavailable')).resolves
            .toEqual({ content: 'reason:newSessionUnavailable' });
    });

    it('ignores a second press while the reader is still choosing', async () => {
        // Two presses of Ask are one intent. Admitting the second would open a
        // second New Session surface and mint a second creation key for the
        // Session the first is already creating.
        let release = (): void => {};
        const held = new Promise<void>((resolve) => { release = resolve; });
        const script: Script = {
            calls: [],
            selections: [],
            select: async () => {
                await held;
                return { kind: 'serverStartDraft', draft: SETTLED_DRAFT };
            },
            result: OPENED,
        };
        const fixture = await mountHeader(script);

        const ask = await fixture.getByRole('button', { name: 'Ask' });
        await act(async () => { await fixture.press(ask); });
        await expect(fixture.getByText('phase:choosing')).resolves
            .toEqual({ content: 'phase:choosing' });
        await act(async () => { await fixture.press(ask); });

        expect(script.selections).toHaveLength(1);

        await act(async () => {
            release();
            await held;
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(script.calls).toHaveLength(1);
        await expect(fixture.getByText('phase:settled')).resolves
            .toEqual({ content: 'phase:settled' });
    });

    it('says nothing was started when the mount cannot dispatch the Action', async () => {
        const script: Script = {
            calls: [], selections: [], select: settleWith(SETTLED_DRAFT), dispatchFails: true,
        };
        const fixture = await mountHeader(script);

        await pressAsk(fixture);

        // Distinct from every settled arm on purpose: "nothing was started" and
        // "the start failed at a named phase" are different things to tell a
        // reader, and only one of them leaves a Session behind.
        await expect(fixture.getByText('phase:unavailable')).resolves
            .toEqual({ content: 'phase:unavailable' });
        await expect(fixture.getByText('reason:dispatch')).resolves
            .toEqual({ content: 'reason:dispatch' });
        await expect(fixture.getByText('outcome:none')).resolves
            .toEqual({ content: 'outcome:none' });
    });

    it('mints a distinct creation key per start, so two Asks are never one Session', async () => {
        // The default mint is the one the product uses, and a repeated key would
        // not fail loudly: the canonical creator would treat the second Ask as a
        // rejoin of the first and quietly hand the reader back the Session they
        // already had. React Native has no WebCrypto, so this is exactly the
        // path that must not silently collapse to a constant.
        const keys: unknown[] = [];
        for (const _attempt of [0, 1]) {
            const script: Script = {
                calls: [],
                selections: [],
                select: settleWith(SETTLED_DRAFT),
                result: OPENED,
                ownCreationKey: true,
            };
            const fixture = await mountHeader(script);
            await pressAsk(fixture);
            const input = script.calls[0]?.input as Readonly<{
                destination?: Readonly<{ creationKey?: unknown }>;
            }> | undefined;
            keys.push(input?.destination?.creationKey);
        }
        expect(keys).toHaveLength(2);
        expect(keys.every((key) => typeof key === 'string' && key.length > 0)).toBe(true);
        expect(keys[0]).not.toEqual(keys[1]);
    });

    it('refuses a result the published schema does not admit rather than reporting a start', async () => {
        const script: Script = {
            calls: [],
            selections: [],
            select: settleWith(SETTLED_DRAFT),
            result: { v: 1, type: 'reticulated' },
        };
        const fixture = await mountHeader(script);

        await pressAsk(fixture);

        await expect(fixture.getByText('phase:unavailable')).resolves
            .toEqual({ content: 'phase:unavailable' });
    });
});
