import { describe, expect, it } from 'vitest';

import { buildDeepSecCostWarning } from './costWarning.js';

describe('buildDeepSecCostWarning', () => {
  it('requires confirmation for full scans and large review scopes', () => {
    expect(buildDeepSecCostWarning({ mode: 'repository_security_audit' })).toMatchObject({
      status: 'requires_confirmation',
      costClass: 'expensive',
    });
    expect(buildDeepSecCostWarning({ mode: 'current_diff', changedFileCount: 51, diffBytes: 100 })).toMatchObject({
      status: 'requires_confirmation',
      reason: 'changed_file_count',
    });
    expect(buildDeepSecCostWarning({ mode: 'current_diff', changedFileCount: 2, diffBytes: 1024 })).toEqual({
      status: 'ok',
    });
  });

  it('uses configured thresholds instead of hard-coded defaults', () => {
    expect(buildDeepSecCostWarning({
      mode: 'current_diff',
      changedFileCount: 3,
      diffBytes: 1024,
      thresholds: {
        changedFileCount: 2,
      },
    })).toMatchObject({
      status: 'requires_confirmation',
      reason: 'changed_file_count',
    });
  });

  it('requires confirmation for large selected-file scopes', () => {
    expect(buildDeepSecCostWarning({
      mode: 'selected_files',
      selectedFileCount: 101,
    })).toMatchObject({
      status: 'requires_confirmation',
      reason: 'selected_file_count',
    });
    expect(buildDeepSecCostWarning({
      mode: 'selected_files',
      selectedBytes: 10 * 1024 * 1024 + 1,
    })).toMatchObject({
      status: 'requires_confirmation',
      reason: 'selected_bytes',
    });
    expect(buildDeepSecCostWarning({
      mode: 'selected_files',
      largestSelectedFileBytes: 5 * 1024 * 1024 + 1,
    })).toMatchObject({
      status: 'requires_confirmation',
      reason: 'single_file_bytes',
    });
  });
});
