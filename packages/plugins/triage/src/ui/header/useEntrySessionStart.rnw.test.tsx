// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { Button, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginTargetedContributionSelectionV1, PluginUiTargetedContributionOperationV1 } from '@happier-dev/protocol';

import {
    TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
    type TriageStartEntrySessionInputV1,
    type TriageStartEntrySessionResultV1,
} from '../../actions/entrySessionProtocol.js';
import { buildTriageEntryAttachmentPresentation } from '../../composer/mutationPlan.js';
import {
    TESTKIT_OBSERVED_REVISION,
    testkitConfiguredInstance,
} from '../../sessions/testkit/entrySessionTestkit.test-support.js';
import { testkitLocator } from '../../corpus/testkit/observations.test-support.js';
import { describeTriageEntrySessionPhaseV1 } from './sessionStartOutcome.js';
import { useTriageEntrySessionStart, type TriageEntrySessionStartRequestV1 } from './useEntrySessionStart.js';

/**
 * The controller is exercised through its actual mounted Host API boundary:
 * profile and project reads enter through Actions, then the resulting compose
 * seed leaves through the incumbent New Session selection request. No Triage
 * session/link writer is reachable on this path.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRY_REF = Object.freeze({
    source: { pluginId: 'happier.example.source', localId: 'example-forge' },
    kindId: 'pull-request',
    collisionScope: 'example/repository',
    entryId: '17',
});

const START_REQUEST = Object.freeze({
    action: {
        actionId: 'compose-worktree',
        label: 'Compose in worktree',
        enabled: true,
        appliesTo: ['pullRequest'],
        profileId: 'profile-worktree',
        workspaceMode: 'repository',
        target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
    },
    entryRef: ENTRY_REF,
    display: { locator: { webUrl: 'https://example.test/acme/repository/pull/17' }, scopeLabel: 'acme/repository' },
    sourceInstance: {
        source: ENTRY_REF.source,
        sourceInstanceId: '11111111-1111-4111-8111-111111111111',
    },
    presentation: buildTriageEntryAttachmentPresentation({
        title: 'Repair the worktree handoff',
        scopeLabel: 'acme/repository',
    }),
    repository: {
        kind: 'github',
        deployment: 'https://example.test',
        repository: 'acme/repository',
    },
});

const PREPARED_OPERATION = Object.freeze({
    point: {
        pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
        protocol: {
            id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
            version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
        },
    },
    contributor: {
        pluginId: ENTRY_REF.source.pluginId,
        contributionId: ENTRY_REF.source.localId,
        occurrenceId: 'example-forge-occurrence-1',
        sourceCustody: { kind: 'development' as const, registeredRootId: 'example-forge-root' },
    },
    role: 'prepareReviewWorkspace',
    action: { pluginId: ENTRY_REF.source.pluginId, localId: 'prepare-review-workspace' },
} satisfies PluginUiTargetedContributionOperationV1);

const PREPARED_REVIEW_START_REQUEST = Object.freeze({
    ...START_REQUEST,
    action: {
        ...START_REQUEST.action,
        actionId: 'compose-prepared-review',
        label: 'Compose in prepared review workspace',
        workspaceMode: 'pull_request',
    },
    reviewWorkspace: {
        operation: PREPARED_OPERATION,
        preparation: {
            instance: testkitConfiguredInstance(),
            entryRef: ENTRY_REF,
            lastKnownLocator: testkitLocator(),
            observed: TESTKIT_OBSERVED_REVISION,
        },
    },
});

const SEND_START_REQUEST = Object.freeze({
    ...START_REQUEST,
    action: {
        ...START_REQUEST.action,
        actionId: 'send-in-checkout',
        label: 'Send in checkout',
        target: {
            kind: 'agent',
            promptInvocationId: null,
            delivery: 'send',
            seededFallbackInstruction: 'Repair the failing parser test.',
        },
    },
});

const PREPARED_REVIEW_SEND_REQUEST = Object.freeze({
    ...PREPARED_REVIEW_START_REQUEST,
    action: {
        ...PREPARED_REVIEW_START_REQUEST.action,
        actionId: 'send-prepared-review',
        target: {
            kind: 'agent',
            promptInvocationId: null,
            delivery: 'send',
            seededFallbackInstruction: 'Review the selected pull request.',
        },
    },
});

/**
 * What the canonical creator answers a REPEATED creation key: the same Session,
 * rejoined, with its one already-admitted Message
 * (`apps/cli/src/session/services/createSpawnedSession.ts` authenticates the
 * creation tag and the immutable recipe before rejoining).
 */
const REJOINED_RESULT = {
    v: 1,
    type: 'opened',
    sessionId: 'session-a',
    disposition: 'rejoined',
    delivery: 'alreadyAccepted',
} as const satisfies TriageStartEntrySessionResultV1;

let activeStartRequest: TriageEntrySessionStartRequestV1 = START_REQUEST;
let mintedKeys: string[] = [];
let notice: string | null = null;
let effectSetups = 0;
const mintCreationKey = () => {
    const key = `minted-key-${mintedKeys.length + 1}`;
    mintedKeys.push(key);
    return key;
};

function StartProbe(_context: RenderContext): React.ReactElement {
    React.useEffect(() => { effectSetups += 1; }, []);
    const controller = useTriageEntrySessionStart({
        mintCreationKey,
    });
    notice = describeTriageEntrySessionPhaseV1(controller.phase)?.labelKey ?? null;
    return (
        <Button
            title="Compose in worktree"
            onPress={() => { controller.start(activeStartRequest); }}
        />
    );
}
const startProbeSurface = defineUiSurface(StartProbe);

const mounted: PluginUiTestkit[] = [];
let seeds: unknown[] = [];
let preparedSelections: unknown[] = [];
let openedPreparations: unknown[] = [];
let startInputs: TriageStartEntrySessionInputV1[] = [];
/** The transient settlement each start Action actually travelled with. */
let startCarriers: unknown[] = [];
/** Every New Session settlement question this mount asked the host. */
let draftRequests: unknown[] = [];
let comparisonOpens: unknown[] = [];

describe('terminal structured-input presentation', () => {
    it.each(['failed', 'cancelled'] as const)(
        'does not present a %s action as a successful start',
        (status) => {
            expect(describeTriageEntrySessionPhaseV1({
                kind: 'settled',
                result: {
                    v: 1,
                    type: 'opened',
                    sessionId: 'session-a',
                    disposition: 'created',
                    delivery: status,
                },
                delivery: { kind: 'send', status },
            })?.labelKey).toBe('plugins.triage.surface.session.deliveryFailed');
        },
    );
});

/** How the host settles the source's own selection question, press by press. */
type ScriptedSelection = 'submitted' | 'cancelled' | 'refused';

async function mountProbe(input: Readonly<{
    strictMode?: boolean;
    request?: TriageEntrySessionStartRequestV1;
    seedResult?: unknown;
    /** What this plugin's own start Action answers, press by press. */
    startResults?: readonly ('lost' | TriageStartEntrySessionResultV1)[];
    /** How the host answers the source selection, in order. Default: submitted. */
    selectionResults?: readonly ScriptedSelection[];
    linkedSession?: Readonly<{ sessionId: string; serverId?: string; machineId: string; path: string }>;
    projects?: readonly unknown[];
}> = {}): Promise<Readonly<{
    fixture: PluginUiTestkit;
    actionCalls: readonly string[];
}>> {
    activeStartRequest = input.request ?? START_REQUEST;
    const startResults = [...(input.startResults ?? [])];
    const selectionResults = [...(input.selectionResults ?? [])];
    const actionCalls: string[] = [];
    const fixture = await createPluginUiTestkit({
        identity: { instanceId: 'fixture-instance-190', mountNonce: 'fixture-mount-190' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: startProbeSurface,
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ strictMode: input.strictMode }),
        handlers: {
            executeAction: async ({ action, input: actionInput, selectedActionInput }) => {
                const actionId = String(action);
                actionCalls.push(actionId);
                if (actionId === TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1) {
                    startInputs.push(actionInput as unknown as TriageStartEntrySessionInputV1);
                    // The fixture host already refused a settlement that is not
                    // the active one; recording it is what proves WHICH one
                    // travelled.
                    startCarriers.push(selectedActionInput ?? null);
                    const next = startResults.shift();
                    if (next === undefined) throw new Error('No scripted start result remains');
                    // The host emitted the exact daemon Action and never learned
                    // what it settled on (`plugin_ui_action_outcome_unknown`).
                    if (next === 'lost') throw new Error('plugin_ui_action_outcome_unknown');
                    return next as unknown as never;
                }
                if (actionId === 'sessions.spawn.profiles.list') {
                    return {
                        items: [{
                            id: 'profile-worktree',
                            name: 'Worktree repair',
                            placement: 'automatic',
                            checkout: 'create_worktree',
                        }],
                    };
                }
                if (actionId === 'projects.list') return { items: input.projects ?? [], truncated: false };
                if (actionId === 'session.open') {
                    comparisonOpens.push(actionInput);
                    return null;
                }
                throw new Error(`Unexpected action: ${actionId}`);
            },
            readSession: async ({ sessionId }) => input.linkedSession?.sessionId === sessionId ? {
                sessionId, ...(input.linkedSession.serverId === undefined ? {} : { serverId: input.linkedSession.serverId }),
                lifecycle: 'active', runtime: 'idle', operational: 'ready',
                workStatus: { bucket: 'finished', tone: 'neutral', word: 'Ready' },
                workspace: { machineId: input.linkedSession.machineId, path: input.linkedSession.path },
                pendingPermissions: [],
            } : null,
            openNewSession: async ({ request, preparedReviewWorkspace }) => {
                seeds.push(request);
                if (preparedReviewWorkspace !== undefined) openedPreparations.push(preparedReviewWorkspace);
                if (input.seedResult !== undefined) throw new Error('New Session unavailable');
            },
            selectActionInput: async ({ request }) => {
                if (!('operation' in request)) {
                    draftRequests.push(request);
                    return {
                        kind: 'serverStartDraft' as const,
                        draft: {
                            executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                            agentTarget: {
                                kind: 'agent' as const,
                                identity: { pluginId: 'happier.test.agent', localId: 'agent' },
                            },
                            directory: { kind: 'path' as const, path: '/workspaces/example' },
                        },
                    };
                }
                const scripted = selectionResults.shift() ?? 'submitted';
                if (scripted === 'cancelled') return { kind: 'cancelled' as const };
                const selected = {
                    kind: 'submitted' as const,
                    action: request.operation.action,
                    input: request.draft ?? {},
                    selection: {
                        target: { pluginId: 'happier.triage',
                            sourceCustody: { kind: 'development' as const, registeredRootId: 'triage-root' } },
                        point: request.operation.point,
                        contributor: { pluginId: request.operation.contributor.pluginId,
                            contributionId: request.operation.contributor.contributionId,
                            sourceCustody: request.operation.contributor.sourceCustody },
                    } satisfies PluginTargetedContributionSelectionV1,
                    connectedAccount: scripted === 'refused'
                        ? { kind: 'none' as const }
                        : {
                            kind: 'selected' as const,
                            fieldPath: 'instance.binding.account',
                            ref: testkitConfiguredInstance().binding.account,
                        },
                    // The host stamps what the reader actually saw beside their
                    // choice; the canonical result schema requires it. The label
                    // is stamped per question here so two settlements of the same
                    // operation are distinguishable — the fixture host retains
                    // exactly one and refuses any other.
                    presentation: {
                        connectedAccountLabel: `Account selection ${preparedSelections.length + 1}`,
                        machineDisplayName: 'Development Mac',
                    },
                };
                preparedSelections.push(selected);
                return selected;
            },
        },
    });
    mounted.push(fixture);
    return { fixture, actionCalls };
}

async function settle(): Promise<void> {
    for (let turn = 0; turn < 8; turn += 1) {
        await act(async () => { await Promise.resolve(); });
    }
}

afterEach(async () => {
    seeds = [];
    preparedSelections = [];
    openedPreparations = [];
    startInputs = [];
    startCarriers = [];
    draftRequests = [];
    comparisonOpens = [];
    mintedKeys = [];
    notice = null;
    effectSetups = 0;
    activeStartRequest = START_REQUEST;
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

const PR_COMPARISON = { kind: 'pullRequest', locator: {
    providerId: 'forge', repository: 'acme/repository', number: 17,
    baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
} } as const;

describe('read-only PR Walk placement', () => {
    it('opens a linked reachable Session comparison without starting or preparing a checkout', async () => {
        const { fixture, actionCalls } = await mountProbe({
            request: { ...START_REQUEST, comparisonDestination: {
                kind: 'scmReview', comparison: PR_COMPARISON, view: 'walkthrough',
            }, linkedSessionIds: ['linked-session'] },
            linkedSession: { sessionId: 'linked-session', serverId: 'server-a', machineId: 'machine-a', path: '/workspaces/example' },
            projects: [{ projectKey: { id: 'workspace-a' },
                serverId: 'server-a', machineId: 'machine-a', rootPath: '/workspaces/example',
                worktrees: [], reachable: true }],
        });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await settle();
        expect(comparisonOpens).toEqual([{ sessionId: 'linked-session', serverId: 'server-a',
            destination: { kind: 'scmReview', comparison: PR_COMPARISON, view: 'walkthrough' } }]);
        expect(startInputs).toEqual([]);
        expect(preparedSelections).toEqual([]);
        expect(actionCalls).not.toContain('sessions.spawn.profiles.list');
    });

    it('uses incumbent New Session placement without preparation or prompt delivery when no link is reachable', async () => {
        const { fixture } = await mountProbe({
            request: { ...START_REQUEST, comparisonDestination: {
                kind: 'scmReview', comparison: PR_COMPARISON, view: 'walkthrough',
            }, linkedSessionIds: ['sleeping-session'] },
            startResults: [{ v: 1, type: 'linked', sessionId: 'session-a', disposition: 'created',
                delivery: 'none', finalOpen: 'deferred' }],
        });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await settle();
        expect(draftRequests).toHaveLength(1);
        expect(startInputs).toHaveLength(1);
        expect(startInputs[0]).toMatchObject({ workspaceMode: 'reference_only', finalOpen: 'deferred',
            destination: { kind: 'new', materialization: { kind: 'referenceOnly', directory: '/workspaces/example' } } });
        expect(startInputs[0]?.delivery).toBeUndefined();
        expect(preparedSelections).toEqual([]);
        expect(seeds).toEqual([]);
        expect(comparisonOpens).toEqual([{ sessionId: 'session-a', serverId: 'server-a',
            destination: { kind: 'scmReview', comparison: PR_COMPARISON, view: 'walkthrough' } }]);
    });

    it('does not use an equal machine id belonging to another Home', async () => {
        const { fixture } = await mountProbe({
            request: { ...START_REQUEST, comparisonDestination: {
                kind: 'scmReview', comparison: PR_COMPARISON, view: 'walkthrough',
            }, linkedSessionIds: ['linked-session'] },
            linkedSession: { sessionId: 'linked-session', serverId: 'server-b', machineId: 'machine-a', path: '/workspaces/example' },
            projects: [{ projectKey: { id: 'workspace-a' }, serverId: 'server-a',
                machineId: 'machine-a', rootPath: '/workspaces/example', worktrees: [], reachable: true }],
            startResults: [{ v: 1, type: 'linked', sessionId: 'session-a', disposition: 'created',
                delivery: 'none', finalOpen: 'deferred' }],
        });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await settle();
        expect(draftRequests).toHaveLength(1);
        expect(comparisonOpens).toEqual([{ sessionId: 'session-a', serverId: 'server-a',
            destination: { kind: 'scmReview', comparison: PR_COMPARISON, view: 'walkthrough' } }]);
    });

    it('asks for placement when an older Session projection omits its Home', async () => {
        const { fixture } = await mountProbe({
            request: { ...START_REQUEST, comparisonDestination: {
                kind: 'scmReview', comparison: PR_COMPARISON, view: 'walkthrough',
            }, linkedSessionIds: ['linked-session'] },
            linkedSession: { sessionId: 'linked-session', machineId: 'machine-a', path: '/workspaces/example' },
            projects: [{ projectKey: { id: 'workspace-a' }, serverId: 'server-a',
                machineId: 'machine-a', rootPath: '/workspaces/example', worktrees: [], reachable: true }],
            startResults: [{ v: 1, type: 'linked', sessionId: 'session-a', disposition: 'created',
                delivery: 'none', finalOpen: 'deferred' }],
        });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await settle();
        expect(draftRequests).toHaveLength(1);
        expect(comparisonOpens).toEqual([{ sessionId: 'session-a', serverId: 'server-a',
            destination: { kind: 'scmReview', comparison: PR_COMPARISON, view: 'walkthrough' } }]);
    });
});

describe('single-entry compose checkout handoff', () => {
    it('carries the resolved profile worktree answer and exact entry attachment into the host seed', async () => {
        const { fixture } = await mountProbe();

        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' }));
        });
        await settle();

        expect(seeds).toHaveLength(1);
        expect(seeds[0]).toMatchObject({
            profileId: 'profile-worktree',
            checkoutIntent: 'createWorktree',
            attachments: [{
                attachmentLocalId: 'entry',
                value: {
                    value: {
                        v: 1,
                        entryRef: ENTRY_REF,
                        sourceInstance: START_REQUEST.sourceInstance,
                    },
                },
            }],
        });
    });

    it('carries the exact selected preparation into the prepared-review compose request', async () => {
        const { fixture, actionCalls } = await mountProbe({
            request: PREPARED_REVIEW_START_REQUEST,
        });

        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' }));
        });
        await settle();

        expect(seeds).toEqual([expect.objectContaining({
            checkoutIntent: 'preparedReviewWorkspace',
        })]);
        expect((seeds[0] as { placement?: { directory?: string } }).placement?.directory).toBeUndefined();
        expect(preparedSelections).toHaveLength(1);
        expect(openedPreparations).toEqual([{
            operation: PREPARED_OPERATION,
            result: preparedSelections[0],
        }]);
        expect(actionCalls).toEqual(['sessions.spawn.profiles.list', 'projects.list']);
    });
});

/**
 * The first press's OUTER response can be lost while the daemon Action it
 * carried already ran (`pluginSurfaceActionDispatch.ts` returns
 * `plugin_ui_action_outcome_unknown` for exactly that). Custody used to be
 * assigned only from the settled result, so the press that lost its reply left
 * nothing behind and the next press minted a second creation key and a second
 * delivery key — a second Session and a second Message for one intent.
 */
describe('a start whose own response never arrived', () => {
    it('retries the identical creation and delivery identity rather than starting a second session', async () => {
        const { fixture } = await mountProbe({
            request: SEND_START_REQUEST,
            startResults: ['lost', {
                v: 1,
                type: 'opened',
                sessionId: 'session-a',
                disposition: 'rejoined',
                delivery: 'alreadyAccepted',
            }],
        });
        const press = await fixture.getByRole('button', { name: 'Compose in worktree' });

        await act(async () => { await fixture.press(press); });
        await settle();

        expect(startInputs).toHaveLength(1);
        // "Nothing was started" would be a claim this screen cannot make.
        expect(notice).toBe('plugins.triage.surface.session.creationUnknown');

        await act(async () => { await fixture.press(press); });
        await settle();

        expect(startInputs).toHaveLength(2);
        const [first, second] = startInputs;
        expect(second?.destination).toEqual(first?.destination);
        expect(second?.delivery?.idempotencyKey).toBe(first?.delivery?.idempotencyKey);
        // One creation key and one delivery key for one logical start, both
        // presses together.
        expect(mintedKeys).toHaveLength(2);
    });

    /**
     * A prepared-review start is the one shape whose recovery needs something
     * back from the host: its preparation runs inside the start Action, under an
     * authorization carrier the host releases before the Action leaves
     * (`hostedWebAdapter.ts`, `reactNative/hostApi.ts`, CLI `actions.ts`). So the
     * spent carrier can never be replayed — but asking the SAME question again
     * for the SAME retained materialization request can, and it is the only way
     * the retained creation key ever reaches the canonical creator's rejoin.
     */
    it.each([false, true])('authorizes the retained prepared request again rather than replaying the spent carrier (StrictMode: %s)', async (strictMode) => {
        const { fixture } = await mountProbe({
            strictMode,
            request: PREPARED_REVIEW_SEND_REQUEST,
            startResults: ['lost', REJOINED_RESULT],
        });
        const press = await fixture.getByRole('button', { name: 'Compose in worktree' });
        if (strictMode) expect(effectSetups).toBeGreaterThan(1);

        await act(async () => { await fixture.press(press); });
        await settle();
        expect(notice).toBe('plugins.triage.surface.session.creationUnknown');

        await act(async () => { await fixture.press(press); });
        await settle();

        expect(startInputs).toHaveLength(2);
        // One logical request, both presses: the same destination and creation
        // key, the same delivery key, no second mint and no second New Session
        // question.
        expect(startInputs[1]?.destination).toEqual(startInputs[0]?.destination);
        expect(startInputs[1]?.delivery?.idempotencyKey).toBe(startInputs[0]?.delivery?.idempotencyKey);
        expect(mintedKeys).toHaveLength(2);
        expect(draftRequests).toHaveLength(1);
        // A fresh settlement of the same question, and the dispatch travelled
        // with THAT one. The fixture host retains exactly one active settlement
        // per operation, so a replayed carrier would have been refused outright.
        expect(preparedSelections).toHaveLength(2);
        expect(startCarriers[1]).toEqual({
            operation: PREPARED_OPERATION,
            result: preparedSelections[1],
        });
        expect(startCarriers[1]).not.toEqual(startCarriers[0]);
        expect(startInputs[1]).toHaveProperty('prepareReviewWorkspaceSelection');
        // The Session the first press may already have made is the one this
        // rejoined, and its one Message was already admitted.
        expect(notice).toBeNull();
    });

    it('keeps the unresolved identity when a recovery attempt is refused, and rejoins on the next press', async () => {
        const { fixture } = await mountProbe({
            request: PREPARED_REVIEW_SEND_REQUEST,
            startResults: [
                'lost',
                // A later preparation refusal describes THAT attempt. It cannot
                // establish that the first dispatch — whose own response never
                // arrived — created nothing.
                { v: 1, type: 'workspacePreparationFailed', reason: 'refused', retryable: false },
                REJOINED_RESULT,
            ],
        });
        const press = await fixture.getByRole('button', { name: 'Compose in worktree' });

        await act(async () => { await fixture.press(press); });
        await settle();
        await act(async () => { await fixture.press(press); });
        await settle();

        // The refusal answered to the RECOVERY is not this screen's verdict on
        // the logical request. "Nothing was created" is exactly the claim that
        // cannot be made while the first dispatch's outcome is unknown, so the
        // reader is told what is actually true — and that pressing again
        // resumes the same Session rather than starting a second.
        expect(notice).toBe('plugins.triage.surface.session.creationUnknown');

        await act(async () => { await fixture.press(press); });
        await settle();

        expect(startInputs).toHaveLength(3);
        const destinations = startInputs.map((sent) => sent.destination);
        expect(destinations[1]).toEqual(destinations[0]);
        expect(destinations[2]).toEqual(destinations[0]);
        expect(new Set(startInputs.map((sent) => sent.delivery?.idempotencyKey)).size).toBe(1);
        // Three presses, one creation key and one delivery key: the third press
        // is still the first logical request rather than a second Session.
        expect(mintedKeys).toHaveLength(2);
        expect(draftRequests).toHaveLength(1);
        expect(preparedSelections).toHaveLength(3);
        expect(startCarriers[2]).toEqual({
            operation: PREPARED_OPERATION,
            result: preparedSelections[2],
        });
        expect(notice).toBeNull();
    });

    /**
     * The other half of the same rule, and the strongest false claim of the
     * two: `creationFailed` is opaque by the orchestrator's own rule — a
     * creation conflict discloses no Session id — so "This session could not be
     * created" would deny a Session the first dispatch may have created.
     * `rejected` reaches the identical branch and is not exercised separately.
     */
    it('never reports a recovery creation failure as the logical request failing', async () => {
        const { fixture } = await mountProbe({
            request: PREPARED_REVIEW_SEND_REQUEST,
            startResults: ['lost', { v: 1, type: 'creationFailed' }, REJOINED_RESULT],
        });
        const press = await fixture.getByRole('button', { name: 'Compose in worktree' });

        await act(async () => { await fixture.press(press); });
        await settle();
        await act(async () => { await fixture.press(press); });
        await settle();

        expect(startInputs).toHaveLength(2);
        expect(notice).toBe('plugins.triage.surface.session.creationUnknown');

        await act(async () => { await fixture.press(press); });
        await settle();

        expect(startInputs[2]?.destination).toEqual(startInputs[0]?.destination);
        expect(mintedKeys).toHaveLength(2);
        expect(notice).toBeNull();
    });

    /**
     * The presentation rule is scoped to an unresolved EARLIER dispatch. A first
     * dispatch's own refusal answers for itself: nothing was created, the reader
     * is told so, and the next press is a new logical request.
     */
    it('still reports a first dispatch’s own refusal as the terminal verdict it is', async () => {
        const { fixture } = await mountProbe({
            request: PREPARED_REVIEW_SEND_REQUEST,
            startResults: [
                { v: 1, type: 'workspacePreparationFailed', reason: 'refused', retryable: false },
                REJOINED_RESULT,
            ],
        });
        const press = await fixture.getByRole('button', { name: 'Compose in worktree' });

        await act(async () => { await fixture.press(press); });
        await settle();
        expect(notice).toBe('plugins.triage.surface.session.workspaceRefused');

        await act(async () => { await fixture.press(press); });
        await settle();

        // No identity was retained, so the second press resolves and mints its
        // own — one refused start is not custody of a Session that never existed.
        expect(startInputs).toHaveLength(2);
        expect(startInputs[1]?.destination).not.toEqual(startInputs[0]?.destination);
        expect(draftRequests).toHaveLength(2);
        expect(mintedKeys).toHaveLength(4);
    });

    it('reports a cancelled or refused recovery authorization as still unknown', async () => {
        const { fixture } = await mountProbe({
            request: PREPARED_REVIEW_SEND_REQUEST,
            selectionResults: ['submitted', 'cancelled', 'refused', 'submitted'],
            startResults: ['lost', REJOINED_RESULT],
        });
        const press = await fixture.getByRole('button', { name: 'Compose in worktree' });

        await act(async () => { await fixture.press(press); });
        await settle();

        await act(async () => { await fixture.press(press); });
        await settle();
        // Cancelling the recovery cancels the recovery. Returning to idle here
        // would say nothing was started, and releasing the retained keys would
        // let the next press mint a second identity for the Session the first
        // press may already have created.
        expect(startInputs).toHaveLength(1);
        expect(notice).toBe('plugins.triage.surface.session.creationUnknown');

        await act(async () => { await fixture.press(press); });
        await settle();
        expect(startInputs).toHaveLength(1);
        expect(notice).toBe('plugins.triage.surface.session.creationUnknown');

        await act(async () => { await fixture.press(press); });
        await settle();

        expect(startInputs).toHaveLength(2);
        expect(startInputs[1]?.destination).toEqual(startInputs[0]?.destination);
        expect(startInputs[1]?.delivery?.idempotencyKey).toBe(startInputs[0]?.delivery?.idempotencyKey);
        expect(mintedKeys).toHaveLength(2);
        expect(draftRequests).toHaveLength(1);
        expect(notice).toBeNull();
    });

    it('spends nothing when the reader cancels the first prepared authorization', async () => {
        const { fixture } = await mountProbe({
            request: PREPARED_REVIEW_SEND_REQUEST,
            selectionResults: ['cancelled', 'submitted'],
            startResults: [{ ...REJOINED_RESULT, disposition: 'created', delivery: 'accepted' }],
        });
        const press = await fixture.getByRole('button', { name: 'Compose in worktree' });

        await act(async () => { await fixture.press(press); });
        await settle();

        // Nothing left this surface, so there is no identity to retain: this is
        // the one cancellation that genuinely started nothing.
        expect(startInputs).toHaveLength(0);
        expect(notice).toBeNull();

        await act(async () => { await fixture.press(press); });
        await settle();

        expect(startInputs).toHaveLength(1);
        expect(draftRequests).toHaveLength(2);
        const destination = startInputs[0]?.destination;
        if (destination?.kind !== 'new') throw new Error('expected a new-Session destination');
        expect(destination.creationKey).not.toBe(mintedKeys[0]);
    });
});
