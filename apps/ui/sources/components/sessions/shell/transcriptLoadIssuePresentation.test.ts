import { describe, expect, it } from 'vitest';

import { presentTranscriptLoadIssue } from './transcriptLoadIssuePresentation';

const context = {
  retainedTranscriptVisible: false,
  machineName: 'NLDW6-3-11-20',
  homeName: 'Studio Home',
} as const;

describe('presentTranscriptLoadIssue', () => {
  it('names the Home a Happier transcript read could not reach, and says why once', () => {
    const presented = presentTranscriptLoadIssue(
      { kind: 'read_failed', errorCode: 'network_error' },
      context,
    );
    expect(presented.title).toContain('Studio Home');
    expect(presented.title).not.toContain('NLDW6-3-11-20');
    expect(presented.body).toBeDefined();
    expect(presented.body).not.toBe(presented.title);
    expect(presented.retryable).toBe(true);
  });

  it('names the Machine that holds an external transcript', () => {
    for (const issue of [
      { kind: 'read_failed', errorCode: 'agent_timeout' },
      { kind: 'authority_unavailable', reason: 'machine_offline' },
    ] as const) {
      expect(presentTranscriptLoadIssue(issue, context).title).toContain(
        'NLDW6-3-11-20',
      );
    }
  });

  it('adds no echo of the title when the failure has no specific cause', () => {
    expect(
      presentTranscriptLoadIssue(
        { kind: 'read_failed', errorCode: 'http_error', httpStatus: 500 },
        context,
      ).body,
    ).toBeUndefined();
  });

  it('keeps the retained-rows title and an explanation while earlier content stays on screen', () => {
    const retained = presentTranscriptLoadIssue(
      { kind: 'read_failed', errorCode: 'http_error', httpStatus: 500 },
      { ...context, retainedTranscriptVisible: true },
    );
    const fresh = presentTranscriptLoadIssue(
      { kind: 'read_failed', errorCode: 'http_error', httpStatus: 500 },
      context,
    );
    expect(retained.title).not.toBe(fresh.title);
    expect(retained.body).toBeDefined();
  });

  it('falls back to the unnamed title when the place is not known yet', () => {
    const named = presentTranscriptLoadIssue(
      { kind: 'read_failed', errorCode: 'network_error' },
      context,
    );
    const unnamed = presentTranscriptLoadIssue(
      { kind: 'read_failed', errorCode: 'network_error' },
      { ...context, homeName: null },
    );
    expect(unnamed.title).not.toBe(named.title);
    expect(unnamed.title.length).toBeGreaterThan(0);
  });
});
