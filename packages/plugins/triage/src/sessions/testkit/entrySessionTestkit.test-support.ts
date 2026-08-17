import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import {
    TriageConfiguredSourceInstanceV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriagePrepareReviewWorkspaceInputV1,
    type TriagePrepareReviewWorkspaceResultV1,
    type TriageReviewWorkspaceObservedRevisionV1,
    type TriageSelectedWorkspaceScopeV1,
} from '@happier-dev/triage-protocol/v1';

import {
    TESTKIT_SOURCE_INSTANCE_ID,
    TRIAGE_TESTKIT_SOURCE,
    testkitLocator,
} from '../../corpus/testkit/observations.test-support.js';
import type { TriageEntrySessionLinkDisplayV1 } from '../entrySessionLinks.js';
import type { TriageSessionActionIdV1, TriageSessionActionInvokerV1 } from '../entrySessionOpen.js';
import type {
    TriagePrepareReviewWorkspaceOperationV1,
    TriageReviewWorkspacePreparationDepsV1,
} from '../entrySessionWorkspace.js';

/**
 * Fixtures for the Session start vertical.
 *
 * The two boundaries a Session start actually crosses are replaced here and
 * nowhere else: the Account Collection store (through the corpus testkit) and
 * the host Action RPC. Every Triage decision — intent and subject gating,
 * directory authority, creation-result consumption, link identity and phase
 * retry — runs for real against those boundaries.
 */

/** The projected facts a start carries into the link, as one pass rendered them. */
export const TESTKIT_LINK_DISPLAY: TriageEntrySessionLinkDisplayV1 = Object.freeze({
    locator: testkitLocator(),
    scopeLabel: 'example/repository',
});

export type RecordedActionCall = Readonly<{
    actionId: TriageSessionActionIdV1;
    input: PluginActionInputById[TriageSessionActionIdV1];
}>;

export type TestkitActionInvoker = Readonly<{
    execute: TriageSessionActionInvokerV1;
    calls: readonly RecordedActionCall[];
    callsFor: (actionId: TriageSessionActionIdV1) => readonly RecordedActionCall[];
}>;

/**
 * Records every host Action invocation and answers from a scripted queue, so a
 * test can assert both what was invoked and — just as importantly — what was
 * never invoked.
 */
export function createTestkitActionInvoker(script: Readonly<{
    spawn?: readonly PluginActionResultById['session.spawn_new'][];
    openFails?: boolean;
}> = {}): TestkitActionInvoker {
    const calls: RecordedActionCall[] = [];
    const spawnResults = [...(script.spawn ?? [])];

    const execute = (async (actionId, input) => {
        calls.push({ actionId, input });
        if (actionId === 'session.open') {
            if (script.openFails === true) throw new Error('session_open_failed');
            return null as PluginActionResultById[typeof actionId];
        }
        const next = spawnResults.shift();
        if (!next) throw new Error('No scripted session.spawn_new result remains');
        return next as PluginActionResultById[typeof actionId];
    }) as TriageSessionActionInvokerV1;

    return {
        execute,
        get calls() {
            return calls;
        },
        callsFor: (actionId) => calls.filter((call) => call.actionId === actionId),
    };
}

export function spawnSuccess(
    overrides: Readonly<{ sessionId?: string; disposition?: 'created' | 'rejoined' }> = {},
): PluginActionResultById['session.spawn_new'] {
    return {
        type: 'success',
        disposition: overrides.disposition ?? 'created',
        sessionId: overrides.sessionId ?? 'session-a',
        executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' },
    };
}

/** The exact configured instance a pull-request preparation is invoked for. */
export function testkitConfiguredInstance(
    overrides: Readonly<{ accountId?: string }> = {},
): TriageConfiguredSourceInstanceV1 {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source: TRIAGE_TESTKIT_SOURCE, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID },
        binding: {
            purpose: 'triage-source',
            account: {
                service: { pluginId: TRIAGE_TESTKIT_SOURCE.pluginId, localId: 'accounts' },
                accountId: overrides.accountId ?? 'account-1',
            },
        },
        localInstanceKey: 'example/repository',
        configuration: { v: 1, token: 'routing-token' },
    });
}

/** The provider revision the pass observed, target-stamped for this one start. */
export const TESTKIT_OBSERVED_REVISION: TriageReviewWorkspaceObservedRevisionV1 = Object.freeze({
    baseSha: '1111111111111111111111111111111111111111',
    headSha: '2222222222222222222222222222222222222222',
    nativeRevision: 'pr-17@2',
    observedAtMs: 1_760_000_800_000,
});

/** The one saved workspace the user picked, projected from the incumbent selector. */
export const TESTKIT_SELECTED_WORKSPACE: TriageSelectedWorkspaceScopeV1 = Object.freeze({
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/workspaces/example-review',
});

export type RecordedPrepareCall = Readonly<{
    input: TriagePrepareReviewWorkspaceInputV1;
    options: Readonly<{ expectedSelectedConnectedAccountRef?: unknown; signal?: AbortSignal }>;
}>;

export type TestkitPrepareReviewWorkspace = Readonly<{
    deps: TriageReviewWorkspacePreparationDepsV1;
    calls: readonly RecordedPrepareCall[];
}>;

/**
 * Replaces exactly one boundary: the host execution of an admitted source
 * operation. The handle is opaque by construction — only the original
 * host-created value can execute — so a fixture stands in for it and the test
 * asserts what Triage handed the host, including what it never invoked.
 */
export function createTestkitPrepareReviewWorkspace(script: Readonly<{
    results: readonly TriagePrepareReviewWorkspaceResultV1[];
    operation?: 'present' | 'absent';
    throws?: Error;
}>): TestkitPrepareReviewWorkspace {
    const calls: RecordedPrepareCall[] = [];
    const results = [...script.results];
    const handle = { identity: { role: 'prepareReviewWorkspace' } } as unknown as
        TriagePrepareReviewWorkspaceOperationV1;

    return {
        deps: {
            ...(script.operation === 'absent' ? {} : { operation: handle }),
            execute: async (operation, input, options) => {
                if (operation !== handle) throw new Error('a copied handle has no execution authority');
                calls.push({ input, options });
                if (script.throws) throw script.throws;
                const next = results.shift();
                if (!next) throw new Error('No scripted prepareReviewWorkspace result remains');
                return next;
            },
        },
        get calls() {
            return calls;
        },
    };
}

export const TESTKIT_SPAWN_REQUEST = Object.freeze({
    executionTarget: Object.freeze({ serverId: 'server-a', machineId: 'machine-a' }),
    agentTarget: Object.freeze({
        kind: 'agent' as const,
        identity: Object.freeze({ pluginId: 'happier.claude', localId: 'claude' }),
    }),
});
