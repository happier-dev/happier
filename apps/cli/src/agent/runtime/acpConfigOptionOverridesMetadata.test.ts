import { describe, expect, it } from 'vitest';

import { computeNextMetadataConfigOptionOverrideV1 } from '@happier-dev/agents';

describe('computeNextMetadataConfigOptionOverrideV1', () => {
  it('stores a config option override when updatedAt is newer', () => {
    const next = computeNextMetadataConfigOptionOverrideV1({
      metadata: {},
      configId: 'telemetry',
      value: 'true',
      updatedAt: 10,
    });

    expect((next as any).acpConfigOptionOverridesV1).toEqual({
      v: 1,
      updatedAt: 10,
      overrides: {
        telemetry: { updatedAt: 10, value: 'true' },
      },
    });
  });

  it('ignores an older override for the same configId', () => {
    const base = {
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 10,
        overrides: {
          telemetry: { updatedAt: 10, value: 'true' },
        },
      },
    };

    const next = computeNextMetadataConfigOptionOverrideV1({
      metadata: base,
      configId: 'telemetry',
      value: 'false',
      updatedAt: 9,
    });

    expect((next as any).acpConfigOptionOverridesV1).toEqual((base as any).acpConfigOptionOverridesV1);
  });

  it('adds a second configId override without deleting the first', () => {
    const base = computeNextMetadataConfigOptionOverrideV1({
      metadata: {},
      configId: 'telemetry',
      value: 'true',
      updatedAt: 10,
    });

    const next = computeNextMetadataConfigOptionOverrideV1({
      metadata: base,
      configId: 'mode',
      value: 'ask',
      updatedAt: 11,
    });

    expect((next as any).acpConfigOptionOverridesV1).toEqual({
      v: 1,
      updatedAt: 11,
      overrides: {
        telemetry: { updatedAt: 10, value: 'true' },
        mode: { updatedAt: 11, value: 'ask' },
      },
    });
  });

  it('ignores non-string config option values', () => {
    const base = { existing: true } as any;

    const next = computeNextMetadataConfigOptionOverrideV1({
      metadata: base,
      configId: 'telemetry',
      // ACP spec uses string value IDs for config options.
      value: true as any,
      updatedAt: 10,
    });

    expect(next).toEqual(base);
  });
});
