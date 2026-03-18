import { describe, expect, it } from 'vitest';

import {
  AcpConfiguredBackendV1Schema,
  buildAcpConfiguredBackendV1,
  readAcpConfiguredBackendV1FromMetadata,
} from './acpConfiguredBackendV1.js';

describe('acpConfiguredBackendV1', () => {
  it('builds and parses configured ACP backend metadata', () => {
    const built = buildAcpConfiguredBackendV1({
      updatedAt: 123,
      backendId: 'custom-kiro',
      title: 'Custom Kiro',
    });

    expect(AcpConfiguredBackendV1Schema.parse({ ...built, extra: 'x' })).toMatchObject({
      v: 1,
      updatedAt: 123,
      backendId: 'custom-kiro',
      title: 'Custom Kiro',
    });
  });

  it('reads configured ACP backend metadata from a metadata object', () => {
    expect(readAcpConfiguredBackendV1FromMetadata({
      acpConfiguredBackendV1: {
        v: 1,
        updatedAt: 123,
        backendId: 'custom-kiro',
        title: 'Custom Kiro',
      },
    })).toEqual({
      v: 1,
      updatedAt: 123,
      backendId: 'custom-kiro',
      title: 'Custom Kiro',
    });
  });

  it('returns null for invalid configured ACP backend metadata', () => {
    expect(readAcpConfiguredBackendV1FromMetadata({
      acpConfiguredBackendV1: {
        v: 1,
        updatedAt: 123,
        backendId: '',
      },
    })).toBeNull();
  });

  it('accepts configured ACP backend metadata built by the canonical helper', () => {
    const built = buildAcpConfiguredBackendV1({
      updatedAt: 456,
      backendId: 'review-backend',
      title: 'Review Backend',
    });

    expect(AcpConfiguredBackendV1Schema.parse(built)).toEqual({
      v: 1,
      updatedAt: 456,
      backendId: 'review-backend',
      title: 'Review Backend',
    });
    expect(readAcpConfiguredBackendV1FromMetadata({
      acpConfiguredBackendV1: built,
    })).toEqual(built);
  });
});
