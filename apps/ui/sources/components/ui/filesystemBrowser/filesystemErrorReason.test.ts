import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import {
  isFilesystemErrorRetryable,
  resolveFilesystemErrorReason,
} from './filesystemErrorReason';

describe('resolveFilesystemErrorReason', () => {
  it('names a Machine whose Happier cannot serve the listing instead of a generic failure, and keeps Retry (RU2 19:25Z)', () => {
    expect(resolveFilesystemErrorReason('unsupported_action')).toBe(
      t('errors.machineActionUnsupported'),
    );
    expect(resolveFilesystemErrorReason('unsupported_action')).not.toBe(
      t('errors.operationFailed'),
    );
    // Updating the Machine and retrying is the recovery, so Retry stays offered.
    expect(isFilesystemErrorRetryable('unsupported_action')).toBe(true);
  });
});
