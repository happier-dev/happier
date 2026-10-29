import { describe, expect, it } from 'vitest';

import { applyAcpConfigOptionIntentSessionMetadata, clearAcpConfigOptionIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

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
  it('clears only the rejected candidate across aliases without reviving an older value', () => {
    const metadata = {
      unrelated: 'retained',
      sessionConfigOptionOverridesV1: { v: 1, updatedAt: 30, overrides: {
        provider: { updatedAt: 30, value: 'gateway' }, effort: { updatedAt: 20, value: 'high' },
      } },
      acpConfigOptionOverridesV1: { v: 1, updatedAt: 29, overrides: { provider: { updatedAt: 29, value: 'grok' } } },
    };
    const candidate = { configId: 'provider', value: 'gateway', updatedAt: 30 };
    const cleared = clearAcpConfigOptionIntentSessionMetadata(metadata, candidate);
    expect(cleared.unrelated).toBe('retained');
    expect(cleared.sessionConfigOptionOverridesV1.overrides).toEqual({ effort: { updatedAt: 20, value: 'high' } });
    expect(cleared.acpConfigOptionOverridesV1).toEqual(cleared.sessionConfigOptionOverridesV1);
    const newer = applyAcpConfigOptionIntentSessionMetadata(metadata, { v: 1, ...candidate, value: 'codex', updatedAt: 31 });
    expect(clearAcpConfigOptionIntentSessionMetadata(newer, candidate)).toBe(newer);
    const equalTime = { ...metadata, sessionConfigOptionOverridesV1: { v: 1, updatedAt: 30,
      overrides: { provider: { updatedAt: 30, value: 'codex' } } } };
    expect(clearAcpConfigOptionIntentSessionMetadata(equalTime, candidate)).toBe(equalTime);
  });

  it.each([' selected ', '', ' '])('preserves opaque config ids and string value %j in metadata writes', value => {
    const next = applyAcpConfigOptionIntentSessionMetadata({}, { v: 1, configId: ' custom ', value, updatedAt: 1 });
    expect(next).toMatchObject({ sessionConfigOptionOverridesV1: { overrides: { ' custom ': { value } } } });
  });
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
