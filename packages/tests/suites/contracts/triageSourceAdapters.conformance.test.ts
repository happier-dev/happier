import { describe, expect, it } from 'vitest';

import {
  readConformanceEntryIds,
  TRIAGE_SOURCE_ADAPTER_CONFORMANCE_CASES,
} from './triageSourceAdapters.conformance';

const IMPLEMENTED_SOURCE_ADAPTERS = Object.freeze([
  'Azure DevOps',
  'Bitbucket',
  'GitHub',
  'GitLab',
  'PostHog',
  'Sentry',
]);

describe('Triage source adapter conformance', () => {
  it('runs the shared contract against every implemented source adapter', () => {
    expect(TRIAGE_SOURCE_ADAPTER_CONFORMANCE_CASES.map(({ name }) => name).sort())
      .toEqual(IMPLEMENTED_SOURCE_ADAPTERS);
  });

  describe.each(TRIAGE_SOURCE_ADAPTER_CONFORMANCE_CASES)('$name', (adapter) => {
    it('lists at least one configured source candidate', async () => {
      await expect(adapter.discover()).resolves.toBeGreaterThan(0);
    });

    it('returns the expected non-empty first page in provider order', async () => {
      const page = await adapter.firstPage();
      expect(page.result.kind).toBe('page');
      expect(readConformanceEntryIds(page.result)).toEqual(adapter.expectedFirstPageEntryIds);
      expect(page.requestWitness).not.toBe('');
    });

    it('resumes through the continuation instead of dropping the remaining walk', async () => {
      const first = await adapter.firstPage();
      if (first.result.kind !== 'page') throw new Error('expected a resumable first page');
      const next = await adapter.nextPage(first.result.continuation);
      expect(next.result.kind).not.toBe('failed');
      expect(next.requestWitness).not.toBe('');
      expect(next.requestWitness).not.toBe(first.requestWitness);
    });

    it('returns authoritative detail for an entry the list emitted', async () => {
      const first = await adapter.firstPage();
      if (first.result.kind === 'failed') throw new Error('expected a readable first page');
      const present = first.result.observations.find((observation) => observation.kind === 'present');
      if (!present || present.kind !== 'present') throw new Error('expected a present list row');
      const detail = await adapter.detail(present.localRef);
      expect(detail.kind).toBe('present');
      expect(detail.localRef).toEqual(present.localRef);
    });

    it('preserves a provider failure as a typed error arm, never empty success', async () => {
      const result = await adapter.providerError();
      expect(['failed', 'unresolved']).toContain(result.kind);
      expect(result.failure.class).toBeTruthy();
      expect(result.failure.code).toBeTruthy();
    });
  });
});
