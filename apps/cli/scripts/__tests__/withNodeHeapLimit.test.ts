import { describe, expect, it } from 'vitest';

import {
  hasMaxOldSpaceSize,
  resolveMaxOldSpaceSizeMb,
  upsertMaxOldSpaceSize,
} from '../withNodeHeapLimit.mjs';

describe('withNodeHeapLimit', () => {
  it('detects existing max-old-space-size flags (equals form)', () => {
    expect(hasMaxOldSpaceSize('--trace-warnings --max-old-space-size=4096')).toBe(true);
  });

  it('detects existing max-old-space-size flags (space form)', () => {
    expect(hasMaxOldSpaceSize('--max-old-space-size 2048')).toBe(true);
  });

  it('appends max-old-space-size when NODE_OPTIONS is empty', () => {
    expect(upsertMaxOldSpaceSize('', 8192)).toBe('--max-old-space-size=8192');
  });

  it('appends max-old-space-size without dropping existing NODE_OPTIONS', () => {
    expect(upsertMaxOldSpaceSize('--trace-warnings', 8192)).toBe('--trace-warnings --max-old-space-size=8192');
  });

  it('does not overwrite existing max-old-space-size', () => {
    expect(upsertMaxOldSpaceSize('--max-old-space-size=2048 --trace-warnings', 8192)).toBe(
      '--max-old-space-size=2048 --trace-warnings',
    );
  });

  it('defaults to 8192 when env override is missing/invalid', () => {
    expect(resolveMaxOldSpaceSizeMb({})).toBe(8192);
    expect(resolveMaxOldSpaceSizeMb({ HAPPIER_CLI_TEST_MAX_OLD_SPACE_SIZE_MB: 'nope' })).toBe(8192);
    expect(resolveMaxOldSpaceSizeMb({ HAPPIER_CLI_TEST_MAX_OLD_SPACE_SIZE_MB: '0' })).toBe(8192);
  });

  it('respects HAPPIER_CLI_TEST_MAX_OLD_SPACE_SIZE_MB override when valid', () => {
    expect(resolveMaxOldSpaceSizeMb({ HAPPIER_CLI_TEST_MAX_OLD_SPACE_SIZE_MB: '4096' })).toBe(4096);
  });
});

