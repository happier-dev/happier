import { describe, expect, it } from 'vitest';

import {
    projectTriageNewSessionDestinationV1,
    triageNewSessionDraftSeedV1,
} from './newSessionDestination.js';

/**
 * The one projection from the host's own settled new-Session draft to the
 * destination this plugin's start Action can carry.
 *
 * Triage names no Agent on the default path: the reader picks one on the host's
 * new-Session surface exactly as they do for any other Session, and the
 * settlement carries that choice back. These cases pin what survives that
 * crossing — and, at least as importantly, what does not.
 */

const SETTLED = Object.freeze({
    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.claude', localId: 'claude' } },
    directory: '/workspaces/example',
});

describe('projecting the settled new-Session draft', () => {
    it('carries an Ask into a reference-only start on the directory the reader chose', () => {
        expect(projectTriageNewSessionDestinationV1({
            intent: 'ask',
            workflowSubject: 'issue',
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

    it('carries a Fix on any other subject into the project the reader chose', () => {
        const projected = projectTriageNewSessionDestinationV1({
            intent: 'fix',
            workflowSubject: 'issue',
            creationKey: 'creation-key-2',
            settlement: SETTLED,
        });
        expect(projected.status).toBe('settled');
        expect(projected.status === 'settled' ? projected.destination.kind === 'new'
            && projected.destination.materialization : null)
            .toEqual({ kind: 'selectedProject', directory: '/workspaces/example' });
    });

    it('leaves every other member of the settled draft behind rather than spawning with it', () => {
        // The draft is the host's whole New Session projection. Only the two
        // members this plugin's wire declares may reach the creation call: a
        // title, a permission mode or a startup instruction smuggled through
        // here would make Triage a second Session-authoring surface.
        const projected = projectTriageNewSessionDestinationV1({
            intent: 'ask',
            workflowSubject: 'issue',
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

    it('refuses a pull-request Fix before any Session surface is opened', () => {
        // The reachable wire cannot request a prepared review workspace
        // (`actions/entrySessionProtocol.ts`), so asking the reader to pick an
        // Agent and a directory first would spend their choice on a start the
        // gate refuses afterwards.
        expect(projectTriageNewSessionDestinationV1({
            intent: 'fix',
            workflowSubject: 'pullRequest',
            creationKey: 'creation-key-4',
            settlement: SETTLED,
        })).toEqual({ status: 'refused', reason: 'pullRequestFixUnsupported' });
    });

    it('refuses a settlement whose Agent identity is not the one the creator requires', () => {
        expect(projectTriageNewSessionDestinationV1({
            intent: 'ask',
            workflowSubject: 'issue',
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
            intent: 'ask',
            workflowSubject: 'issue',
            creationKey: 'creation-key-6',
            settlement: withoutDirectory,
        })).toEqual({ status: 'refused', reason: 'draftUnusable' });
    });

    it('refuses a settlement the host did not settle at all', () => {
        expect(projectTriageNewSessionDestinationV1({
            intent: 'ask',
            workflowSubject: 'issue',
            creationKey: 'creation-key-7',
            settlement: null,
        })).toEqual({ status: 'refused', reason: 'draftUnusable' });
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
});
