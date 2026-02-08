import { describe, expect, it } from 'vitest';

import { isAcpFsEnabled } from './AcpBackend';

describe('ACP fs capability flag', () => {
  it('defaults to enabled when HAPPIER_ACP_FS is unset', () => {
    const prev = process.env.HAPPIER_ACP_FS;
    try {
      delete process.env.HAPPIER_ACP_FS;
      expect(isAcpFsEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_ACP_FS;
      else process.env.HAPPIER_ACP_FS = prev;
    }
  });

  it('can be disabled explicitly via HAPPIER_ACP_FS=0', () => {
    const prev = process.env.HAPPIER_ACP_FS;
    try {
      process.env.HAPPIER_ACP_FS = '0';
      expect(isAcpFsEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_ACP_FS;
      else process.env.HAPPIER_ACP_FS = prev;
    }
  });
});

