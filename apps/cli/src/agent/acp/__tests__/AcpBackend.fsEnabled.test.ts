import { describe, expect, it } from 'vitest';

import { isAcpFsEnabled } from '../AcpBackend';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const envScope = createEnvKeyScope(['HAPPIER_ACP_FS']);

describe('ACP fs capability flag', () => {
  it('defaults to enabled when HAPPIER_ACP_FS is unset', () => {
    try {
      envScope.patch({ HAPPIER_ACP_FS: undefined });
      expect(isAcpFsEnabled()).toBe(true);
    } finally {
      envScope.restore();
    }
  });

  it('can be disabled explicitly via HAPPIER_ACP_FS=0', () => {
    try {
      envScope.patch({ HAPPIER_ACP_FS: '0' });
      expect(isAcpFsEnabled()).toBe(false);
    } finally {
      envScope.restore();
    }
  });
});
