import { describe, expect, it } from 'vitest';

import { buildConfiguredAcpBackendSessionMetadata } from './sessionMetadata';

describe('buildConfiguredAcpBackendSessionMetadata', () => {
  it('builds persisted metadata for configured ACP backends', () => {
    expect(buildConfiguredAcpBackendSessionMetadata({
      backendId: 'custom-backend',
      title: 'Custom Kiro',
    })).toEqual({
      acpConfiguredBackendV1: {
        v: 1,
        updatedAt: expect.any(Number),
        backendId: 'custom-backend',
        title: 'Custom Kiro',
      },
    });
  });
});
