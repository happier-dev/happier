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

import { buildTriageEntryAttachmentPresentation } from '../../composer/mutationPlan.js';
import {
    TESTKIT_OBSERVED_REVISION,
    testkitConfiguredInstance,
} from '../../sessions/testkit/entrySessionTestkit.test-support.js';
import { testkitLocator } from '../../corpus/testkit/observations.test-support.js';
import { useTriageEntrySessionStart } from './useEntrySessionStart.js';

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
        immutableGenerationId: 'example-forge-generation-1',
    },
    role: 'prepareReviewWorkspace',
    action: { pluginId: ENTRY_REF.source.pluginId, localId: 'prepare-review-workspace' },
});

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

let activeStartRequest = START_REQUEST;

const startProbeSurface = defineUiSurface(function StartProbe(_context: RenderContext): React.ReactElement {
    const controller = useTriageEntrySessionStart({ mintCreationKey: () => 'unused-for-compose' });
    return (
        <Button
            title="Compose in worktree"
            onPress={() => { controller.start(activeStartRequest); }}
        />
    );
});

const mounted: PluginUiTestkit[] = [];
let seeds: unknown[] = [];
let preparedSelections: unknown[] = [];
let openedPreparations: unknown[] = [];

async function mountProbe(input: Readonly<{
    request?: typeof START_REQUEST;
    seedResult?: unknown;
}> = {}): Promise<Readonly<{
    fixture: PluginUiTestkit;
    actionCalls: readonly string[];
}>> {
    activeStartRequest = input.request ?? START_REQUEST;
    const actionCalls: string[] = [];
    const fixture = await createPluginUiTestkit({
        identity: {
            pluginId: 'happier.triage',
            pluginVersion: '0.0.0',
            viewId: 'entry-session-start-checkout',
            generation: 'entry-session-start-checkout-test',
        },
        surface: startProbeSurface,
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: {
            executeAction: async ({ action }) => {
                const actionId = String(action);
                actionCalls.push(actionId);
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
                if (actionId === 'projects.list') return { items: [], truncated: false };
                throw new Error(`Unexpected action: ${actionId}`);
            },
            openNewSession: async ({ request, preparedReviewWorkspace }) => {
                seeds.push(request);
                if (preparedReviewWorkspace !== undefined) openedPreparations.push(preparedReviewWorkspace);
                if (input.seedResult !== undefined) throw new Error('New Session unavailable');
            },
            selectActionInput: async ({ request }) => {
                if (!('operation' in request)) throw new Error('Unexpected Session draft selection');
                const selected = {
                    kind: 'submitted' as const,
                    action: request.operation.action,
                    input: request.draft ?? {},
                    selection: {
                        target: { pluginId: 'happier.triage', immutableGenerationId: 'entry-session-start-checkout-test' },
                        point: request.operation.point,
                        contributor: request.operation.contributor,
                    },
                    connectedAccount: { kind: 'none' as const },
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
    activeStartRequest = START_REQUEST;
    for (const fixture of mounted.splice(0)) await fixture.dispose();
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
