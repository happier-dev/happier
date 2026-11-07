// @vitest-environment jsdom
import * as React from 'react';
import { PluginError } from '@happier-dev/plugin-sdk';
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
    testkitTriageActionId,
} from '../../sessions/testkit/entrySessionTestkit.test-support.js';
import { testkitLocator, testkitSnapshot, testkitViewer } from '../../corpus/testkit/observations.test-support.js';
import { describeTriageEntrySessionPhaseV1 } from './sessionStartOutcome.js';
import { useTriageEntrySessionStart, type TriageEntrySessionStartRequestV1 } from './useEntrySessionStart.js';
import type { TriageActionProfilePreferencesV1 } from '../../sessions/actionLaunch.js';

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

/** What a caller that already settled the New Session facts passes; it starts directly. */
const SETTLED_DESTINATION = Object.freeze({
    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
    agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.test.agent', localId: 'agent' } },
    directory: { kind: 'path' as const, path: '/workspaces/example' },
});
const SETTLED_SEND_START_REQUEST = Object.freeze({ ...SEND_START_REQUEST, settlement: SETTLED_DESTINATION });
const SETTLED_PREPARED_REVIEW_SEND_REQUEST = Object.freeze({ ...PREPARED_REVIEW_SEND_REQUEST, settlement: SETTLED_DESTINATION });

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
let phase: ReturnType<typeof useTriageEntrySessionStart>['phase'];
let effectSetups = 0;
let probeKey = 0;
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
    phase = controller.phase;
    return (
        <Button
            title="Compose in worktree"
            onPress={() => { controller.start(activeStartRequest); }}
        />
    );
}
function StartProbeScope(context: RenderContext): React.ReactElement {
    return <StartProbe key={probeKey} {...context} />;
}
const startProbeSurface = defineUiSurface(StartProbeScope);

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
    seedError?: Error;
    /** What this plugin's own start Action answers, press by press. */
    startResults?: readonly ('lost' | TriageStartEntrySessionResultV1)[];
    /** How the host answers the source selection, in order. Default: submitted. */
    selectionResults?: readonly ScriptedSelection[];
    beforePreparedSelection?: (signal: AbortSignal) => Promise<void>;
    linkedSession?: Readonly<{ sessionId: string; serverId?: string; machineId: string; path: string }>;
    projects?: readonly unknown[];
    cancelPlacement?: boolean;
    missingRevisionRead?: 'ready' | 'refused';
    profilePlacement?: TriageActionProfilePreferencesV1['placement'];
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
                const actionId = testkitTriageActionId(action);
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
                            placement: input.profilePlacement ?? 'automatic',
                            checkout: 'create_worktree',
                        }],
                    };
                }
                if (actionId === 'entries/reobserve-v1' && input.missingRevisionRead) {
                    if (input.missingRevisionRead === 'refused') throw new PluginError({ code: 'unavailable',
                        diagnostics: [{ code: 'source_not_ready', severity: 'error' }],
                        details: { requestId: 'read-revision-19' },
                    });
                    return { kind: 'observed', entryRef: ENTRY_REF, observation: {
                        sourceInstanceId: testkitConfiguredInstance().instance.sourceInstanceId, observedAtMs: 4_000,
                        outcome: { kind: 'present', locator: testkitLocator(), snapshot: testkitSnapshot({
                            reviewRevision: { baseSha: 'base', headSha: 'head', nativeRevision: 'rev' },
                        }), viewer: testkitViewer() },
                    } };
                }
                if (actionId === 'entries/read-detail-v1' && input.missingRevisionRead) {
                    return { kind: 'read', instance: testkitConfiguredInstance(), linkedSessions: [] };
                }
                if (actionId === 'projects.list') return { items: input.projects ?? (activeStartRequest.reviewWorkspace === undefined ? [] : [{
                    projectKey: { id: 'workspace-a' }, serverId: 'server-a', machineId: 'machine-a',
                    rootPath: '/workspaces/example', forge: START_REQUEST.repository, worktrees: [], reachable: true,
                }]), truncated: false };
                if (actionId === 'session.open') {
                    comparisonOpens.push(actionInput);
                    return null;
                }
                throw new Error(`Unexpected action: ${actionId}`);
            },
            readSession: async ({ sessionId }) => input.linkedSession?.sessionId === sessionId ? {
                sessionId, ...(input.linkedSession.serverId === undefined ? {} : { serverId: input.linkedSession.serverId }),
                lifecycle: 'active', runtime: 'idle', operational: 'ready',
                workStatus: { state: 'ready', bucket: 'finished', tone: 'neutral', attentionType: null, word: 'Ready' },
                workspace: { machineId: input.linkedSession.machineId, path: input.linkedSession.path },
                pendingPermissions: [],
            } : null,
            openNewSession: async ({ request, preparedReviewWorkspace }) => {
                seeds.push(request);
                if (preparedReviewWorkspace !== undefined) openedPreparations.push(preparedReviewWorkspace);
                if (input.seedError) throw input.seedError;
                if (input.seedResult !== undefined) throw new Error('New Session unavailable');
            },
            selectActionInput: async ({ request, signal }) => {
                if (!('operation' in request)) {
                    draftRequests.push(request);
                    if (request.hostAction.projection === 'sessionPlacement' && input.cancelPlacement) return { kind: 'cancelled' as const };
                    if (request.hostAction.projection === 'sessionPlacement') return {
                        kind: 'sessionPlacement' as const,
                        candidate: { projectKey: { id: 'workspace-a' }, serverId: 'server-a', machineId: 'machine-a',
                            rootPath: '/workspaces/example', worktrees: [], reachable: true },
                    };
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
                await input.beforePreparedSelection?.(signal);
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
    probeKey = 0;
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

    it('starts a settled placement without preparation or prompt delivery when no link is reachable', async () => {
        const { fixture } = await mountProbe({
            request: { ...START_REQUEST, comparisonDestination: {
                kind: 'scmReview', comparison: PR_COMPARISON, view: 'walkthrough',
            }, linkedSessionIds: ['sleeping-session'], settlement: SETTLED_DESTINATION },
            startResults: [{ v: 1, type: 'linked', sessionId: 'session-a', disposition: 'created',
                delivery: 'none', finalOpen: 'deferred' }],
        });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await settle();
        expect(draftRequests).toEqual([]);
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
            }, linkedSessionIds: ['linked-session'], settlement: SETTLED_DESTINATION },
            linkedSession: { sessionId: 'linked-session', serverId: 'server-b', machineId: 'machine-a', path: '/workspaces/example' },
            projects: [{ projectKey: { id: 'workspace-a' }, serverId: 'server-a',
                machineId: 'machine-a', rootPath: '/workspaces/example', worktrees: [], reachable: true }],
            startResults: [{ v: 1, type: 'linked', sessionId: 'session-a', disposition: 'created',
                delivery: 'none', finalOpen: 'deferred' }],
        });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await settle();
        expect(draftRequests).toEqual([]);
        expect(comparisonOpens).toEqual([{ sessionId: 'session-a', serverId: 'server-a',
            destination: { kind: 'scmReview', comparison: PR_COMPARISON, view: 'walkthrough' } }]);
    });

    it('asks for placement when an older Session projection omits its Home', async () => {
        const { fixture } = await mountProbe({
            request: { ...START_REQUEST, comparisonDestination: {
                kind: 'scmReview', comparison: PR_COMPARISON, view: 'walkthrough',
            }, linkedSessionIds: ['linked-session'], settlement: SETTLED_DESTINATION },
            linkedSession: { sessionId: 'linked-session', machineId: 'machine-a', path: '/workspaces/example' },
            projects: [{ projectKey: { id: 'workspace-a' }, serverId: 'server-a',
                machineId: 'machine-a', rootPath: '/workspaces/example', worktrees: [], reachable: true }],
            startResults: [{ v: 1, type: 'linked', sessionId: 'session-a', disposition: 'created',
                delivery: 'none', finalOpen: 'deferred' }],
        });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await settle();
        expect(draftRequests).toEqual([]);
        expect(comparisonOpens).toEqual([{ sessionId: 'session-a', serverId: 'server-a',
            destination: { kind: 'scmReview', comparison: PR_COMPARISON, view: 'walkthrough' } }]);
    });
});

describe('single-entry compose checkout handoff', () => {
    it.each([PREPARED_REVIEW_START_REQUEST, PREPARED_REVIEW_SEND_REQUEST])(
        'withdraws its prepared-workspace selector on entry retirement ($action.actionId)', async (request) => {
            let pendingSignal!: AbortSignal;
            let finishSelection!: () => void;
            const { fixture } = await mountProbe({ request, beforePreparedSelection: (signal) => {
                pendingSignal = signal;
                return new Promise((resolve) => { finishSelection = resolve; });
            } });
            await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
            await settle();
            expect(pendingSignal.aborted).toBe(false);
            // Retire just the entry owner; the mounted Host API and its chooser remain live.
            probeKey += 1;
            await act(async () => { await fixture.updateSurface(fixture.context.surface); });
            await settle();
            expect(pendingSignal.aborted).toBe(true);
            await act(async () => { finishSelection(); });
            await settle();
            expect(startInputs).toEqual([]);
            expect(seeds).toEqual([]);
        },
    );
    it.each([
        new PluginError({ code: 'plugin_action_current_intent_rejected' }),
        new PluginError({ code: 'denied', diagnostics: [{ code: 'plugin_action_current_intent_rejected', severity: 'error' }] }),
    ])(
        'leaves preparation idle after the host returns $code ($diagnostics)', async (seedError) => {
            const { fixture, actionCalls } = await mountProbe({
                request: PREPARED_REVIEW_START_REQUEST,
                seedError,
            });
            await act(async () => {
                await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' }));
            });
            await settle();
            expect(openedPreparations).toHaveLength(1);
            expect(notice).toBeNull();
            expect(startInputs).toEqual([]);
            expect(actionCalls).toEqual(['sessions.spawn.profiles.list', 'projects.list']);
        },
    );

    it('keeps a real seed failure visible instead of treating generic unavailability as Decline', async () => {
        const { fixture } = await mountProbe({
            request: PREPARED_REVIEW_START_REQUEST,
            seedError: new PluginError({ code: 'unavailable', diagnostics: [{ code: 'prepared_review_workspace_unavailable', severity: 'error' }] }),
        });
        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' }));
        });
        await settle();
        expect(notice).toBe('plugins.triage.surface.session.newSessionUnavailable');
    });

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
            projects: [{ projectKey: { id: 'workspace-a' }, serverId: 'server-a', machineId: 'machine-a',
                rootPath: '/workspaces/example', forge: START_REQUEST.repository, worktrees: [], reachable: true }],
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
        expect(draftRequests).toEqual([]);
        expect(preparedSelections[0]).toMatchObject({ input: { workspace: {
            serverId: 'server-a', machineId: 'machine-a', rootPath: '/workspaces/example',
        } } });
        expect(openedPreparations).toEqual([{
            operation: PREPARED_OPERATION,
            result: preparedSelections[0],
        }]);
        expect(actionCalls).toEqual(['sessions.spawn.profiles.list', 'projects.list']);
    });

    it.each([0, 2])('asks the incumbent chooser for %i matching projects and admits a saved-project override', async (matches) => {
        const project = { projectKey: { id: 'workspace-a' }, serverId: 'server-a', machineId: 'machine-a',
            rootPath: '/workspaces/example', worktrees: [], reachable: true,
            forge: matches === 0 ? { ...START_REQUEST.repository, repository: 'acme/other' } : START_REQUEST.repository };
        const projects = matches === 2 ? [project, { ...project, projectKey: { id: 'workspace-b' }, rootPath: '/workspaces/second' }] : [project];
        const { fixture, actionCalls } = await mountProbe({ request: PREPARED_REVIEW_START_REQUEST, projects });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await settle();
        expect(draftRequests, JSON.stringify(phase)).toHaveLength(1);
        expect(draftRequests[0]).toMatchObject({
            hostAction: { action: 'session.spawn_new', projection: 'sessionPlacement' },
            candidates: projects.map(({ forge: _forge, ...candidate }) => candidate),
        });
        expect(preparedSelections).toHaveLength(1);
        expect(preparedSelections[0]).toMatchObject({ input: { workspace: {
            serverId: 'server-a', machineId: 'machine-a', rootPath: '/workspaces/example',
        } } });
        expect(startInputs).toEqual([]);
        expect(actionCalls).toEqual(['sessions.spawn.profiles.list', 'projects.list']);
    });

    it('does not prepare or seed after cancelling unresolved project placement', async () => {
        const { fixture } = await mountProbe({ request: PREPARED_REVIEW_START_REQUEST, projects: [], cancelPlacement: true });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await settle();
        expect(draftRequests).toHaveLength(1);
        expect(preparedSelections).toEqual([]);
        expect(seeds).toEqual([]);
        expect(startInputs).toEqual([]);
        expect(phase).toEqual({ kind: 'idle' });
    });

    it('keeps preparation diagnostic identifiers in the mounted unavailable phase', async () => {
        const { fixture } = await mountProbe({ request: PREPARED_REVIEW_START_REQUEST,
            seedError: new PluginError({ code: 'unavailable', diagnostics: [{ code: 'workspaceMismatch', severity: 'error' }],
                details: { requestId: 'prepare-18' } }),
        });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await settle();
        expect(phase).toEqual({ kind: 'unavailable', reason: 'newSessionUnavailable',
            failure: { codes: ['unavailable', 'workspaceMismatch'], requestId: 'prepare-18' } });
        expect(notice).toBe('plugins.triage.surface.session.workspaceMismatch');
    });
});

/**
 * Owner ruling "Agent actions: one shared flow" (2026-11-07): an unresolved
 * placement always opens the prefilled New Session composer — the same opener
 * compose uses — never a separate folder settlement.
 */
describe('an unresolved Start now', () => {
    it.each([
        ['repository', SEND_START_REQUEST, 'Repair the failing parser test.', 'createWorktree'],
        ['prepared review', PREPARED_REVIEW_SEND_REQUEST, 'Review the selected pull request.', 'preparedReviewWorkspace'],
    ] as const)('opens the prefilled composer for a %s send instead of a folder settlement', async (_kind, request, prompt, checkoutIntent) => {
        const { fixture } = await mountProbe({ request });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await settle();
        expect(draftRequests.filter((asked) => (asked as { hostAction?: { projection?: string } })
            .hostAction?.projection === 'serverStartDraft')).toEqual([]);
        expect(startInputs).toEqual([]);
        expect(seeds).toEqual([expect.objectContaining({
            prompt, profileId: 'profile-worktree', checkoutIntent,
            attachments: [expect.objectContaining({ attachmentLocalId: 'entry' })],
        })]);
        expect(openedPreparations).toHaveLength(checkoutIntent === 'preparedReviewWorkspace' ? 1 : 0);
        expect(phase).toEqual({ kind: 'idle' });
    });

    /** Owner ruling 16:50Z: no draft modal for any agent action; only bulk keeps its per-unit settlement. */
    it.each([
        ['Walk through', { ...START_REQUEST, comparisonDestination: { kind: 'scmReview', comparison: PR_COMPARISON, view: 'walkthrough' },
            linkedSessionIds: ['sleeping-session'] }, 'none'],
        ['formal review', { ...PREPARED_REVIEW_START_REQUEST, action: { ...PREPARED_REVIEW_START_REQUEST.action, actionId: 'formal-review',
            target: { kind: 'reviewStart', promptInvocationId: null, seededFallbackInstruction: 'Review the selected pull request.' } } },
        'preparedReviewWorkspace'],
        ['issue orchestration', { ...SEND_START_REQUEST, orchestrationPrompt: 'Plan only the migration.' }, 'createWorktree'],
    ] as const)('opens the prefilled composer for an unresolved %s', async (_kind, request, checkoutIntent) => {
        const { fixture } = await mountProbe({ request: request as TriageEntrySessionStartRequestV1 });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await settle();
        expect(draftRequests.filter((asked) => (asked as { hostAction?: { projection?: string } })
            .hostAction?.projection === 'serverStartDraft')).toEqual([]);
        expect(startInputs).toEqual([]);
        expect(comparisonOpens).toEqual([]);
        expect(seeds).toEqual([expect.objectContaining({ checkoutIntent })]);
        expect(phase).toEqual({ kind: 'idle' });
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
    it.each(['automatic', 'ask', { fixed: { serverId: 'server-a', machineId: 'machine-a' }, directory: '/workspaces/example' }] as const)(
        'retains saved workspace evidence for prepared start with placement %j', async (profilePlacement) => {
            const { fixture } = await mountProbe({ request: SETTLED_PREPARED_REVIEW_SEND_REQUEST, profilePlacement,
                projects: [{ projectKey: { id: 'workspace-a' }, serverId: 'server-a', machineId: 'machine-a',
                    rootPath: '/workspaces/example', forge: START_REQUEST.repository, worktrees: [], reachable: true }],
                startResults: [REJOINED_RESULT] });
            await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
            await settle();
            expect(startInputs).toHaveLength(1);
            expect(startInputs[0]?.destination).toMatchObject({ materialization: { kind: 'reviewWorkspace', request: {
                workspace: { serverId: 'server-a', machineId: 'machine-a', rootPath: '/workspaces/example' },
            } } });
        },
    );
    it('carries a native-service selection with no Connected Account through prepared Session start', async () => {
        const instance = testkitConfiguredInstance();
        if (!('account' in instance.binding)) throw new Error('Expected account fixture');
        const { fixture } = await mountProbe({
            request: { ...SETTLED_PREPARED_REVIEW_SEND_REQUEST, reviewWorkspace: {
                ...PREPARED_REVIEW_SEND_REQUEST.reviewWorkspace,
                preparation: { ...PREPARED_REVIEW_SEND_REQUEST.reviewWorkspace.preparation,
                    instance: { ...instance, binding: { purpose: instance.binding.purpose,
                        source: 'native', service: instance.binding.account.service } } },
            } },
            selectionResults: ['refused'], // Host's admitted connectedAccount:none arm.
            startResults: [REJOINED_RESULT],
        });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await settle();
        expect(startInputs).toHaveLength(1);
        expect(startInputs[0]?.prepareReviewWorkspaceSelection).toMatchObject({ input: {
            instance: { binding: { source: 'native', service: instance.binding.account.service } },
        } });
        expect(startInputs[0]?.prepareReviewWorkspaceSelection?.credentialRef).toBeUndefined();
        expect(startCarriers[0]).toEqual({ operation: PREPARED_OPERATION, result: preparedSelections[0] });
    });
    it('retries the identical creation and delivery identity rather than starting a second session', async () => {
        const { fixture } = await mountProbe({
            request: SETTLED_SEND_START_REQUEST,
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
            request: SETTLED_PREPARED_REVIEW_SEND_REQUEST,
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
        expect(draftRequests).toEqual([]);
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
            request: SETTLED_PREPARED_REVIEW_SEND_REQUEST,
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
        expect(draftRequests).toEqual([]);
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
            request: SETTLED_PREPARED_REVIEW_SEND_REQUEST,
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
            request: SETTLED_PREPARED_REVIEW_SEND_REQUEST,
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
        expect(draftRequests).toEqual([]);
        expect(mintedKeys).toHaveLength(4);
    });

    it('reports a cancelled or refused recovery authorization as still unknown', async () => {
        const { fixture } = await mountProbe({
            request: SETTLED_PREPARED_REVIEW_SEND_REQUEST,
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
        expect(draftRequests).toEqual([]);
        expect(notice).toBeNull();
    });

    it('spends nothing when the reader cancels the first prepared authorization', async () => {
        const { fixture } = await mountProbe({
            request: SETTLED_PREPARED_REVIEW_SEND_REQUEST,
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
        expect(draftRequests).toEqual([]);
        const destination = startInputs[0]?.destination;
        if (destination?.kind !== 'new') throw new Error('expected a new-Session destination');
        expect(destination.creationKey).not.toBe(mintedKeys[0]);
    });
});


describe('sparse review observation readiness', () => {
    const contributions = {
        target: { pluginId: 'happier.triage', occurrenceId: 'triage-generation', sourceCustody: { kind: 'development' as const, registeredRootId: 'triage-root' } },
        points: [{ pointId: PREPARED_OPERATION.point.pointId, protocols: [{ protocol: PREPARED_OPERATION.point.protocol, contributions: [{
            contributor: PREPARED_OPERATION.contributor, protocol: PREPARED_OPERATION.point.protocol,
            descriptor: { v: 1, purpose: 'triage-source', displayName: 'External forge', kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }] },
            operations: [PREPARED_OPERATION], surfaces: [],
        }] }] }],
    };
    it.each(['ready', 'refused'] as const)('settles the missing revision source read as %s before preparation', async (read) => {
        const { reviewWorkspace: _missing, ...sparse } = PREPARED_REVIEW_START_REQUEST;
        const { fixture, actionCalls } = await mountProbe({
            request: { ...sparse, sourceContributions: contributions },
            missingRevisionRead: read,
            projects: [{ projectKey: { id: 'workspace-a' }, serverId: 'server-a', machineId: 'machine-a',
                rootPath: '/workspaces/example', forge: START_REQUEST.repository, worktrees: [], reachable: true }],
        });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Compose in worktree' })); });
        await act(async () => { await Promise.resolve(); });
        expect(actionCalls.filter(id => id === 'entries/reobserve-v1')).toHaveLength(1);
        if (read === 'ready') {
            expect(preparedSelections).toHaveLength(1);
            expect(seeds).toHaveLength(1);
        } else {
            expect(phase).toMatchObject({ kind: 'unavailable', failure: { codes: ['unavailable', 'source_not_ready'], requestId: 'read-revision-19' } });
            expect(preparedSelections).toEqual([]);
            expect(seeds).toEqual([]);
        }
        expect(startInputs).toEqual([]);
    });
});
