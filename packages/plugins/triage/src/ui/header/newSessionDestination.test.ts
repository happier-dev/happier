import { describe, expect, it } from 'vitest';

import { TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1 } from '../../sessions/entrySessionWorkspace.js';
import {
    projectTriageNewSessionDestinationV1,
    triageNewSessionDraftSeedV1,
    triageNewSessionWireMaterializationV1,
} from './newSessionDestination.js';
import type { TriageActionPlacementV1 } from '../../sessions/actionLaunch.js';
import {
    TESTKIT_OBSERVED_REVISION,
    testkitConfiguredInstance,
} from '../../sessions/testkit/entrySessionTestkit.test-support.js';
import { testkitEntryRef, testkitLocator } from '../../corpus/testkit/observations.test-support.js';

/**
 * The one projection from the host's own settled new-Session draft to the
 * destination this plugin's start Action can carry.
 *
 * Triage names no Agent on the default path: the reader picks one on the host's
 * new-Session surface exactly as they do for any other Session, and the
 * settlement carries that choice back. These cases pin what survives that
 * crossing — and, at least as importantly, what does not.
 *
 * The pressed action's declared `workspaceMode` IS the request (`PLAN.md`
 * §0a A3). The retired `intent`/`workflowSubject` pair made this module
 * re-derive the materialization from a label plus the entry's subject, in its
 * own words, with nothing binding it to the gate that validated the answer —
 * the unbound duplicate the Ask/Fix verifier filed as F1. The three approved
 * pairings are unchanged and are asserted literally below, so a change to the
 * one table they now live in cannot pass unnoticed.
 */

const SETTLED = Object.freeze({
    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.claude', localId: 'claude' } },
    directory: '/workspaces/example',
});

describe('projecting the settled new-Session draft', () => {
    it('carries a reference-only action onto the directory the reader chose', () => {
        expect(projectTriageNewSessionDestinationV1({
            workspaceMode: 'reference_only',
            creationKey: 'creation-key-1',
            settlement: SETTLED,
        })).toEqual({
            status: 'settled',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-1',
                spawn: {
                    executionTarget: SETTLED.executionTarget,
                    agentTarget: SETTLED.agentTarget,
                },
                materialization: { kind: 'referenceOnly', directory: '/workspaces/example' },
            },
        });
    });

    it('carries a repository action into the project the reader chose', () => {
        const projected = projectTriageNewSessionDestinationV1({
            workspaceMode: 'repository',
            creationKey: 'creation-key-2',
            settlement: SETTLED,
        });
        expect(projected.status).toBe('settled');
        expect(projected.status === 'settled' ? projected.destination.kind === 'new'
            && projected.destination.materialization : null)
            .toEqual({ kind: 'selectedProject', directory: '/workspaces/example' });
    });

    it('builds the materialization from the one pairing table the gate validates against', () => {
        // Binds this end of the start to the table rather than to a copy of the
        // pairings: a table edit that this module did not follow shows up here
        // instead of in front of a reader as a refusal after they had already
        // picked an Agent and a directory.
        for (const workspaceMode of ['reference_only', 'repository'] as const) {
            const projected = projectTriageNewSessionDestinationV1({
                workspaceMode,
                creationKey: 'creation-key-table',
                settlement: SETTLED,
            });
            expect(
                projected.status === 'settled' && projected.destination.kind === 'new'
                    ? projected.destination.materialization.kind
                    : null,
                workspaceMode,
            ).toBe(TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1[workspaceMode]);
        }
    });

    it('leaves every other member of the settled draft behind rather than spawning with it', () => {
        // The draft is the host's whole New Session projection. Only the two
        // members this plugin's wire declares may reach the creation call: a
        // title, a permission mode or a startup instruction smuggled through
        // here would make Triage a second Session-authoring surface.
        const projected = projectTriageNewSessionDestinationV1({
            workspaceMode: 'reference_only',
            creationKey: 'creation-key-3',
            settlement: {
                ...SETTLED,
                title: 'A title the reader never typed',
                permissionMode: 'bypassPermissions',
                transcriptStorage: 'direct',
                agentSessionStartupInstructionsV1: { v: 1 },
            },
        });
        expect(projected.status === 'settled' && projected.destination.kind === 'new'
            ? Object.keys(projected.destination.spawn).sort()
            : null).toEqual(['agentTarget', 'executionTarget']);
        expect(projected.status === 'settled' && projected.destination.kind === 'new'
            ? Object.keys(projected.destination.materialization).sort()
            : null).toEqual(['directory', 'kind']);
    });

    it('carries only the exact saved project/machine/root scope into selected-PR preparation', () => {
        expect(projectTriageNewSessionDestinationV1({
            workspaceMode: 'pull_request',
            creationKey: 'creation-key-4',
            settlement: SETTLED,
            reviewWorkspace: {
                instance: testkitConfiguredInstance(),
                entryRef: testkitEntryRef(),
                lastKnownLocator: testkitLocator(),
                observed: TESTKIT_OBSERVED_REVISION,
            },
            placementCandidates: [{
                projectKey: { id: 'project-example' },
                serverId: 'server-a',
                machineId: 'machine-a',
                rootPath: '/workspaces/example',
                reachable: true,
                worktrees: [],
            }],
        })).toEqual({
            status: 'settled',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-4',
                spawn: {
                    executionTarget: SETTLED.executionTarget,
                    agentTarget: SETTLED.agentTarget,
                },
                materialization: {
                    kind: 'reviewWorkspace',
                    request: {
                        instance: testkitConfiguredInstance(),
                        entryRef: testkitEntryRef(),
                        workflowSubject: 'pullRequest',
                        lastKnownLocator: testkitLocator(),
                        observed: TESTKIT_OBSERVED_REVISION,
                        workspace: {
                            serverId: 'server-a',
                            machineId: 'machine-a',
                            rootPath: '/workspaces/example',
                        },
                    },
                },
            },
        });
    });

    it('refuses a settlement whose Agent identity is not the one the creator requires', () => {
        expect(projectTriageNewSessionDestinationV1({
            workspaceMode: 'reference_only',
            creationKey: 'creation-key-5',
            settlement: {
                ...SETTLED,
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.claude' } },
            },
        })).toEqual({ status: 'refused', reason: 'draftUnusable' });
    });

    it('refuses a settlement with no directory rather than choosing one', () => {
        const { directory: _dropped, ...withoutDirectory } = SETTLED;
        expect(projectTriageNewSessionDestinationV1({
            workspaceMode: 'reference_only',
            creationKey: 'creation-key-6',
            settlement: withoutDirectory,
        })).toEqual({ status: 'refused', reason: 'draftUnusable' });
    });

    it('refuses a settlement the host did not settle at all', () => {
        expect(projectTriageNewSessionDestinationV1({
            workspaceMode: 'reference_only',
            creationKey: 'creation-key-7',
            settlement: null,
        })).toEqual({ status: 'refused', reason: 'draftUnusable' });
    });
});

describe('the wire materialization a mode resolves to', () => {
    /**
     * The same reader the press consults BEFORE opening the host's New Session
     * surface and the projection consults after it settles. One reader for both
     * is what keeps the up-front refusal and the built request from drifting.
     */
    it('answers every materialization the start wire owns', () => {
        expect(triageNewSessionWireMaterializationV1('reference_only')).toBe('referenceOnly');
        expect(triageNewSessionWireMaterializationV1('repository')).toBe('selectedProject');
        expect(triageNewSessionWireMaterializationV1('pull_request')).toBe('reviewWorkspace');
    });
});

describe('seeding the new-Session surface', () => {
    it('sends nothing when Triage has no preference, so the host uses its own defaults', () => {
        expect(triageNewSessionDraftSeedV1({})).toBeNull();
        expect(triageNewSessionDraftSeedV1({ agentId: '   ' })).toBeNull();
    });

    it('sends only the members the host seed admits', () => {
        expect(triageNewSessionDraftSeedV1({
            agentId: 'claude',
            directory: '/workspaces/example',
        })).toEqual({ agentId: 'claude', directory: '/workspaces/example' });
    });

    /**
     * A resolved placement travels WHOLE or not at all.
     *
     * A path is not a place. Seeding the checkout's directory while leaving the
     * host to stamp whichever machine the surface is mounted on is how a Session
     * gets a directory from one machine and an execution target from another —
     * so the machine rides with the path, and the host composes against it.
     */
    it('carries the machine a resolved placement named beside its directory', () => {
        const placement: TriageActionPlacementV1 = {
            kind: 'launch',
            candidate: {
                projectKey: { id: 'project-api' },
                serverId: 'server-1',
                machineId: 'machine-b',
                rootPath: '/checkouts/api',
                label: 'API',
                reachable: true,
                worktrees: [{ path: '/checkouts/api', branch: 'main', isMain: true, isCurrent: true }],
            },
        };

        expect(triageNewSessionDraftSeedV1({}, {
            profileId: 'profile-repair',
            checkoutIntent: 'reuseWorkspace',
            placement,
        })).toEqual({
            profileId: 'profile-repair',
            executionTarget: { serverId: 'server-1', machineId: 'machine-b' },
            directory: '/checkouts/api',
            checkoutIntent: 'reuseWorkspace',
            candidates: [{
                projectKey: { id: 'project-api' },
                serverId: 'server-1',
                machineId: 'machine-b',
                rootPath: '/checkouts/api',
                label: 'API',
                reachable: true,
                worktrees: [{ path: '/checkouts/api', branch: 'main', isMain: true, isCurrent: true }],
            }],
        });
    });

    /**
     * A placement that named a machine and no path still names the machine: the
     * reader picks the directory on THAT machine rather than on this surface's.
     */
    it('carries a machine a placement pinned with no directory', () => {
        expect(triageNewSessionDraftSeedV1({}, {
            profileId: 'profile-repair',
            checkoutIntent: 'reuseWorkspace',
            placement: {
                kind: 'pinned',
                target: { serverId: 'server-1', machineId: 'machine-b' },
            },
        })).toEqual({
            profileId: 'profile-repair',
            executionTarget: { serverId: 'server-1', machineId: 'machine-b' },
            checkoutIntent: 'reuseWorkspace',
        });
    });

    it('carries an ambiguous placement to the Session owner without picking a checkout', () => {
        const candidates = ['a', 'b'].map((projectId) => ({
            projectKey: { id: projectId },
            serverId: 'server-1',
            machineId: `machine-${projectId}`,
            rootPath: `/src/${projectId}`,
            reachable: true,
            worktrees: [],
        }));

        expect(triageNewSessionDraftSeedV1({}, {
            profileId: 'profile-repair',
            checkoutIntent: 'ask',
            placement: { kind: 'prefill', reason: 'ambiguous', candidates },
        })).toEqual({
            profileId: 'profile-repair',
            checkoutIntent: 'ask',
            candidates: [
                {
                    projectKey: { id: 'a' },
                    serverId: 'server-1',
                    machineId: 'machine-a',
                    rootPath: '/src/a',
                    reachable: true,
                    worktrees: [],
                },
                {
                    projectKey: { id: 'b' },
                    serverId: 'server-1',
                    machineId: 'machine-b',
                    rootPath: '/src/b',
                    reachable: true,
                    worktrees: [],
                },
            ],
        });
    });

    /**
     * A directory the reader pinned in Triage settings names no machine, so it
     * is seeded alone and the host stamps its own — unchanged behaviour.
     */
    it('leaves a stated preference to the host’s own machine', () => {
        expect(triageNewSessionDraftSeedV1({ directory: '/pinned' }))
            .toEqual({ directory: '/pinned' });
    });
});
