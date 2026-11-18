import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { normalizePanelReview } from './document.js';

export function reviewRecord() {
  return {
    job_id: 42,
    job: { id: 42, status: 'done' },
    structured_output: {
      schema_version: 3,
      verdict: 'fail',
      summary: 'A review with evidence.',
      source_labels: ['Security', 'Correctness'],
      findings: [{
        severity: 'high', kind: 'defect', topic: 'security', confidence: 0.9,
        problem: 'Untrusted input reaches the shell.', fix: 'Pass arguments without a shell.',
        file: 'src/run.ts', start_line: 4, end_line: 6, sources: [1],
      }],
    },
    panel: {
      name: 'default', synthesis_job_id: 42,
      members: [
        { job_id: 40, name: 'Security', agent: 'codex', status: 'done', verdict: 'F' },
        { job_id: 41, name: 'Correctness', agent: 'claude-code', status: 'failed' },
      ],
    },
  };
}

describe('selected native panel document', () => {
  it('normalizes the published v0.75.0 selected-job recording', () => {
    // Captured from native panel enqueue/wait/show with a stub model process;
    // prompt, machine identity and transient repository paths are removed.
    const captured: unknown = JSON.parse(readFileSync(new URL('./fixtures/selected-review.json', import.meta.url), 'utf8'));
    expect(normalizePanelReview(captured, 3)).toMatchObject({
      outcome: 'complete', verdict: 'fail', findings: [{
        filePath: 'index.js', startLine: 1, endLine: 1, suggestion: 'Return the selected value.',
      }],
      members: [{ name: 'first', verdict: 'F' }, { name: 'second', verdict: 'F' }],
      findingEvidence: [{ sources: [1], sourceLabels: ['codex (exhaustive)', 'codex (exhaustive)'] }],
    });
  });

  it('keeps substantive findings and member attribution when a panel member fails', () => {
    const result = normalizePanelReview(reviewRecord());
    expect(result.outcome).toBe('partial');
    expect(result.verdict).toBe('fail');
    expect(result.members[1]).toMatchObject({ name: 'Correctness', status: 'failed' });
    expect(result.findings).toEqual([expect.objectContaining({
      severity: 'high', category: 'security', filePath: 'src/run.ts', startLine: 4, endLine: 6,
      summary: 'Untrusted input reaches the shell.', suggestion: 'Pass arguments without a shell.',
    })]);
    expect(result.findingEvidence).toEqual([expect.objectContaining({
      findingId: result.findings[0]?.id, sources: [1], sourceLabels: ['Security', 'Correctness'],
    })]);
  });

  it('does not interpret unable-to-review or missing verdict as a clean result', () => {
    const record = reviewRecord();
    record.panel.members = [];
    record.structured_output.findings = [];
    record.structured_output.verdict = 'unable_to_review';
    expect(normalizePanelReview(record)).toMatchObject({ outcome: 'failed', verdict: 'unable_to_review', findings: [] });
    expect(normalizePanelReview({ structured_output: { schema_version: 3, summary: 'Converted review.', findings: [] } }))
      .toMatchObject({ outcome: 'partial', verdict: null });
  });

  it('retains substantive findings when the selected native job itself is failed', () => {
    const record = reviewRecord();
    record.job.status = 'failed';
    expect(normalizePanelReview(record)).toMatchObject({
      outcome: 'failed', findings: [{ summary: 'Untrusted input reaches the shell.' }],
    });
  });

  it('accepts native FAIL with findings and PASS with no findings as completed reviews', () => {
    const record = reviewRecord();
    record.panel.members = record.panel.members.slice(0, 1);
    expect(normalizePanelReview(record)).toMatchObject({ outcome: 'complete', verdict: 'fail' });
    record.structured_output.verdict = 'pass';
    record.structured_output.findings = [];
    expect(normalizePanelReview(record)).toMatchObject({ outcome: 'complete', verdict: 'pass', findings: [] });
  });

  it('rejects missing, legacy or malformed structured output instead of scraping prose', () => {
    for (const value of [
      { output: 'No findings.' },
      { structured_output: { schema_version: 0, legacy: { markdown: 'No findings.' } } },
      { structured_output: { schema_version: 3, summary: 'No findings.', verdict: 'pass' } },
      { structured_output: { ...reviewRecord().structured_output, findings: [{ problem: 'Something' }] } },
    ]) expect(() => normalizePanelReview(value)).toThrow();
  });

  it('preserves version 2 text locations as evidence without guessing a file anchor', () => {
    expect(normalizePanelReview({ structured_output: {
      schema_version: 2, verdict: 'fail', summary: 'Older structured review.',
      findings: [{ severity: 'medium', problem: 'Missing test.', fix: 'Add coverage.', location: 'src/run.ts:4' }],
    } }).findings[0]).toMatchObject({ evidence: 'src/run.ts:4', severity: 'medium', summary: 'Missing test.' });
  });
});
