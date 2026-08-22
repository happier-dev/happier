import { describe, expect, it } from 'vitest';

import {
    TriageSourceDescriptorV1Schema,
    type TriageSourceDescriptorV1,
} from '@happier-dev/triage-protocol/v1';

import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import {
    testkitLocator,
    testkitPresentOutcome,
    testkitSnapshot,
    testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import type { TriageListLaneV1, TriageListRowV1 } from '../../projection/listWindow.js';
import { projectTriageDetailHeaderV1 } from './header.js';

/**
 * The common header's own boundary.
 *
 * Its failure mode is a sentence: this projection decides what the detail pane
 * says about the connection the entry is being read through, and the reader has
 * no way to check it. So the discriminating case is a connection **no pass
 * asked** — which the surface once reported as one that did not answer.
 */

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE = '11111111-1111-4111-8111-111111111111';

function row(): TriageListRowV1 {
    const outcome = testkitPresentOutcome({
        locator: testkitLocator(),
        snapshot: testkitSnapshot({ title: 'Fix the parser' }),
        viewer: testkitViewer(),
    });
    return {
        entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'origin', entryId: '42' },
        content: { sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome },
        lane: CORPUS_LANE.open,
        sortAtMs: 1_000,
        presence: { kind: 'present' },
        attention: null,
        selected: { kind: 'selected', sourceInstanceId: INSTANCE, reason: 'onlyPresent' },
        observations: [{ sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome }],
    };
}

const DESCRIPTOR: TriageSourceDescriptorV1 = TriageSourceDescriptorV1Schema.parse({
    v: 1,
    purpose: 'triage-source',
    displayName: 'Example forge',
    kinds: [
        { id: 'issue', workflowSubject: 'issue', displayName: 'Issue' },
        { id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' },
    ],
});

function header(
    lane: TriageListLaneV1,
    sourceDescriptor: TriageSourceDescriptorV1 | null = null,
) {
    return projectTriageDetailHeaderV1({
        row: row(),
        lanes: [lane],
        connectionLabel: 'acme/widgets',
        sourceDescriptor,
        linkedSessions: [],
    });
}

const HEALTHY_LANE: TriageListLaneV1 = {
    sourceInstanceId: INSTANCE,
    source: SOURCE,
    health: { kind: 'unavailable' },
    exhausted: false,
};

describe('projectTriageDetailHeaderV1', () => {
    it('says nothing about a connection no pass asked', () => {
        // `projection/sourceHealth.ts` excludes `unavailable` deliberately: the
        // invocation never settled into provider evidence, so there is nothing to
        // report and reporting it accuses a provider that was never asked. The
        // detail header re-derived its own health and collapsed the two, so a
        // configured-but-unasked connection was told to the reader as one that
        // "did not answer in the last pass".
        expect(header({
            sourceInstanceId: INSTANCE,
            source: SOURCE,
            health: { kind: 'unavailable' },
            exhausted: false,
        }).sourceReadFailed).toBe(false);
    });

    it('reports the connection this detail is read through when it answered with a failure', () => {
        expect(header({
            sourceInstanceId: INSTANCE,
            source: SOURCE,
            health: { kind: 'failed', failure: { class: 'permission', code: 'forbidden' } },
            exhausted: false,
        }).sourceReadFailed).toBe(true);
    });

    it('names the source and this entry\'s kind in the source\'s own words', () => {
        // The row's `kindId` is `pull-request`, and the descriptor declares
        // `issue` first. A projection that took the declared order — or the
        // first kind — would call a pull request an Issue.
        const named = header(HEALTHY_LANE, DESCRIPTOR);

        expect(named.sourceLabel).toBe('Example forge');
        expect(named.kindLabel).toBe('Pull request');
    });

    it('says nothing about a kind the source never declared', () => {
        // The `kindId` is a routing token the source chose. Falling back to it
        // would print an internal identifier as the source's own word for the
        // thing, which is worse than saying nothing.
        const undeclared = header(HEALTHY_LANE, TriageSourceDescriptorV1Schema.parse({
            v: 1,
            purpose: 'triage-source',
            displayName: 'Example forge',
            kinds: [{ id: 'issue', workflowSubject: 'issue', displayName: 'Issue' }],
        }));

        expect(undeclared.sourceLabel).toBe('Example forge');
        expect(undeclared.kindLabel).toBeNull();
    });

    it('carries neither name while no admitted contribution has answered', () => {
        expect(header(HEALTHY_LANE).sourceLabel).toBeNull();
        expect(header(HEALTHY_LANE).kindLabel).toBeNull();
    });

    it('never repeats another connection\'s failure onto the entry on screen', () => {
        // Aggregate list health belongs beside the list. Attributing it here would
        // make one broken connection look like a problem with this entry.
        expect(header({
            sourceInstanceId: '22222222-2222-4222-8222-222222222222',
            source: SOURCE,
            health: { kind: 'failed', failure: { class: 'permission', code: 'forbidden' } },
            exhausted: false,
        }).sourceReadFailed).toBe(false);
    });
});
