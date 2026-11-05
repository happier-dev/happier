import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { testkitEntryRef, testkitObservation, TESTKIT_SOURCE_INSTANCE_ID } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { projectTriageSessionLinkedEntryCandidates, linkTriageSessionEntry } from './linkedEntrySearch.js';
import { projectTriageSessionLinkedEntrySummary } from './linkedEntrySummary.js';

describe('Session entry linking', () => {
    it('uses the existing entry search matcher and marks full-reference Session links', () => {
        const entryRef = testkitEntryRef();
        const window = foldTriageListWindow({
            observations: [{ ...testkitObservation(), entryRef }],
            lanes: [], activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 10,
        });
        expect(projectTriageSessionLinkedEntryCandidates(window.rows, 'repository NORMALIZER', [entryRef], () => 'pullRequest'))
            .toMatchObject([{ alreadyLinked: true, entry: { title: 'Replace the duplicated normalizer' } }]);
        expect(projectTriageSessionLinkedEntryCandidates(window.rows, 'missing', [entryRef], () => 'pullRequest')).toEqual([]);
        expect(projectTriageSessionLinkedEntryCandidates(window.rows, '', [{ ...entryRef, collisionScope: 'other' }], () => 'pullRequest'))
            .toMatchObject([{ alreadyLinked: false }]);
    });
    it('reports the existing link action outcome and never claims a failed write linked', async () => {
        const entryRef = testkitEntryRef();
        const window = foldTriageListWindow({ observations: [{ ...testkitObservation(), entryRef }],
            lanes: [], activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 10 });
        const entry = projectTriageSessionLinkedEntrySummary(window.rows[0]!, 'pullRequest')!;
        const requests: unknown[] = [];
        const host = { executeAction: async (action: string, input: unknown) => {
            requests.push({ action, input });
            return { v: 1, status: 'failed' };
        } };
        expect(await linkTriageSessionEntry(host, 'session-1', entry)).toEqual({ v: 1, status: 'failed' });
        expect(requests[0]).toMatchObject({ action: 'sessions/link-entry-v1', input: {
            sessionId: 'session-1', entryRef, display: { scopeLabel: 'example/repository', locator: { displayPath: 'example/repository #17' } },
        } });
        expect(await linkTriageSessionEntry({ executeAction: async () => ({ v: 1, status: 'linked' }) }, 'session-1', entry))
            .toEqual({ v: 1, status: 'linked' });
        expect(await linkTriageSessionEntry({ executeAction: async () => ({ v: 1, status: 'linked', extra: true }) }, 'session-1', entry))
            .toEqual({ v: 1, status: 'failed' });
        expect(await linkTriageSessionEntry({ executeAction: async () => { throw new Error('Account unreachable'); } }, 'session-1', entry))
            .toEqual({ v: 1, status: 'failed' });
        const refusal = new PluginError({ code: 'channels_pr_link_binding_not_ready', retryable: false });
        await expect(linkTriageSessionEntry({ executeAction: async () => { throw refusal; } }, 'session-1', entry))
            .rejects.toBe(refusal);
    });
});
