import { describe, expect, it } from 'vitest';
import { createDirectTriageFixPullRequestsTransport } from './useTriageFixPullRequests.js';
import { createTestkitCorpusCollections } from '../../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';

describe('direct fix-link transport', () => {
  it('waits for the Action-bound host decision before the real Account writer, and writes nothing on decline', async () => {
    const fixture = createTestkitCorpusCollections();
    const entryRef = testkitEntryRef({ kindId: 'issue', entryId: '42' });
    const fixPullRequest = testkitEntryRef({ kindId: 'pull-request', entryId: '43' });
    let answer: ((approved: boolean) => void) | undefined;
    // The public UI host is outside this plugin process; its decision is the boundary.
    const host = { confirm: async (_message: string, options?: Readonly<{ action?: unknown }>) => {
      expect(options?.action).toBe('marks/set-fix-pull-request-v1');
      return await new Promise<boolean>(resolve => { answer = resolve; });
    } };
    const transport = createDirectTriageFixPullRequestsTransport(fixture.collections, {
      workflowSubjectOf: ref => ref.kindId === 'pull-request' ? 'pullRequest' : 'issue',
      presentationOf: () => 'active',
    }, () => 10, host, () => 'Set fix pull request?');
    const write = transport.write({ v: 1, linked: true, entryRef, fixPullRequest,
      displayAtMark: { title: 'Issue', scopeLabel: 'test' },
      displayAtLink: { title: 'Fix', scopeLabel: 'test' },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await transport.read(entryRef)).candidates).toEqual([]);
    expect(answer).toBeTypeOf('function');
    answer?.(false);
    await expect(write).resolves.toBeNull();
    expect((await transport.read(entryRef)).candidates).toEqual([]);
    const accepted = transport.write({ v: 1, linked: true, entryRef, fixPullRequest,
      displayAtMark: { title: 'Issue', scopeLabel: 'test' },
      displayAtLink: { title: 'Fix', scopeLabel: 'test' },
    });
    answer?.(true);
    await expect(accepted).resolves.toEqual({ v: 1, status: 'linked' });
    expect((await transport.read(entryRef)).candidates).toHaveLength(1);
  });
});
