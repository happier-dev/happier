import { describe, expect, it } from 'vitest';

import { applyAcpConfigOptionIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

function writeAcpConfigOptionOverride(params: Readonly<{
  metadata: Record<string, unknown>;
  configId: string;
  value: string | number | boolean | null;
  updatedAt: number;
}>): Record<string, unknown> {
  return applyAcpConfigOptionIntentSessionMetadata(params.metadata, {
    v: 1,
    configId: params.configId,
    value: params.value,
    updatedAt: params.updatedAt,
  });
}

describe('session-state ACP config option metadata binding', () => {
  it('stores a config option override when updatedAt is newer', () => {
    const next = writeAcpConfigOptionOverride({
      metadata: {},
      configId: 'telemetry',
      value: 'true',
      updatedAt: 10,
    });

    expect((next as any).sessionConfigOptionOverridesV1).toEqual({
      v: 1,
      updatedAt: 10,
      overrides: {
        telemetry: { updatedAt: 10, value: 'true' },
      },
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
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 10,
        overrides: {
          telemetry: { updatedAt: 10, value: 'true' },
        },
      },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 10,
        overrides: {
          telemetry: { updatedAt: 10, value: 'true' },
        },
      },
    };

    const next = writeAcpConfigOptionOverride({
      metadata: base,
      configId: 'telemetry',
      value: 'false',
      updatedAt: 9,
    });

    expect((next as any).sessionConfigOptionOverridesV1).toEqual((base as any).sessionConfigOptionOverridesV1);
    expect((next as any).acpConfigOptionOverridesV1).toEqual((base as any).acpConfigOptionOverridesV1);
  });

  it('adds a second configId override without deleting the first', () => {
    const base = writeAcpConfigOptionOverride({
      metadata: {},
      configId: 'telemetry',
      value: 'true',
      updatedAt: 10,
    });

    const next = writeAcpConfigOptionOverride({
      metadata: base,
      configId: 'mode',
      value: 'ask',
      updatedAt: 11,
    });

    expect((next as any).sessionConfigOptionOverridesV1).toEqual({
      v: 1,
      updatedAt: 11,
      overrides: {
        telemetry: { updatedAt: 10, value: 'true' },
        mode: { updatedAt: 11, value: 'ask' },
      },
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

  it('stores typed config option values', () => {
    const next = writeAcpConfigOptionOverride({
      metadata: {},
      configId: 'telemetry',
      value: true,
      updatedAt: 10,
    });

    expect((next as any).sessionConfigOptionOverridesV1.overrides.telemetry).toEqual({
      updatedAt: 10,
      value: true,
    });
    expect((next as any).acpConfigOptionOverridesV1.overrides.telemetry).toEqual({
      updatedAt: 10,
      value: true,
    });
  });
});
