import { describe, expect, it } from 'vitest';

import { createSessionStateSyncEngine } from './syncEngine.js';

describe('createSessionStateSyncEngine', () => {
  it('writes Happier fields through the metadata update port before optional provider mirroring', async () => {
    const applied: string[] = [];
    const portUpdates: unknown[] = [];
    const engine = createSessionStateSyncEngine({
      capabilities: {
        display: {
          title: {
            supported: true,
            happierToProvider: { supported: true, transport: 'runtime-hook' },
          },
        },
      },
      metadataPort: {
        update: async (sessionId, updater, opts) => {
          portUpdates.push({
            sessionId,
            opts,
            metadata: updater({
              summary: {
                text: 'Previous',
                updatedAt: 1,
              },
            }),
          });
          return { ok: true, version: 7 };
        },
      },
      facet: {
        applyHappierField: async (_ctx, field, value) => {
          applied.push(`${field}:${String(value)}`);
        },
        readField: async () => null,
      },
    });

    await expect(engine.writeHappierField({
      ctx: { sessionId: 's1' },
      sessionId: 's1',
      fieldId: 'display.title',
      value: 'Renamed',
      reason: 'user-mutation',
      metadataReason: 'test-title',
      mirrorToProvider: true,
    })).resolves.toEqual({
      ok: true,
      version: 7,
      provider: { ok: true },
    });

    expect(portUpdates).toEqual([{
      sessionId: 's1',
      opts: { reason: 'test-title' },
      metadata: {
        summary: {
          text: 'Renamed',
          updatedAt: expect.any(Number),
        },
      },
    }]);
    expect(applied).toEqual(['display.title:Renamed']);
  });

  it('reports unsupported when a metadata write is requested without a metadata port', async () => {
    const events: unknown[] = [];
    const engine = createSessionStateSyncEngine({
      capabilities: {},
      telemetry: (event) => events.push(event),
    });

    await expect(engine.writeHappierField({
      sessionId: 's1',
      fieldId: 'display.title',
      value: 'Renamed',
      reason: 'user-mutation',
      metadataReason: 'test-title',
    })).resolves.toEqual({ ok: false, reason: 'unsupported' });

    expect(events).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        fieldId: 'display.title',
        direction: 'happierMetadata',
        outcome: 'skipped',
        errorCode: 'unsupported',
      }),
    ]);
  });

  it('emits metadata write telemetry for successful writes', async () => {
    const events: unknown[] = [];
    const engine = createSessionStateSyncEngine({
      capabilities: {
        display: {
          title: { supported: true },
        },
      },
      telemetry: (event) => events.push(event),
      metadataPort: {
        update: async () => ({ ok: true, version: 8 }),
      },
    });

    await expect(engine.writeHappierField({
      sessionId: 's1',
      fieldId: 'display.title',
      value: 'Renamed',
      reason: 'user-mutation',
      metadataReason: 'test-title',
    })).resolves.toEqual({ ok: true, version: 8 });

    expect(events).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        fieldId: 'display.title',
        direction: 'happierMetadata',
        reason: 'test-title',
        outcome: 'applied',
      }),
    ]);
  });

  it('emits sanitized metadata write telemetry for port failures', async () => {
    const events: unknown[] = [];
    const engine = createSessionStateSyncEngine({
      capabilities: {
        display: {
          title: { supported: true },
        },
      },
      telemetry: (event) => events.push(event),
      metadataPort: {
        update: async () => ({ ok: false, reason: 'forbidden' }),
      },
    });

    await expect(engine.writeHappierField({
      sessionId: 's1',
      fieldId: 'display.title',
      value: 'Renamed',
      reason: 'user-mutation',
      metadataReason: 'test-title',
    })).resolves.toEqual({ ok: false, reason: 'forbidden' });

    expect(events).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        fieldId: 'display.title',
        direction: 'happierMetadata',
        reason: 'test-title',
        outcome: 'failed',
        errorCode: 'forbidden',
      }),
    ]);
  });

  it('preserves session lookup timeouts from the metadata update port', async () => {
    const engine = createSessionStateSyncEngine({
      capabilities: {
        display: {
          title: { supported: true },
        },
      },
      metadataPort: {
        update: async () => ({ ok: false, reason: 'session_lookup_timeout' }),
      },
    });

    await expect(engine.writeHappierField({
      sessionId: 'c123456789012345678901234',
      fieldId: 'display.title',
      value: 'Renamed',
      reason: 'user-mutation',
      metadataReason: 'test-title',
    })).resolves.toEqual({ ok: false, reason: 'session_lookup_timeout' });
  });

  it('reports unsupported when metadata writes target a field not declared in capabilities', async () => {
    const portUpdates: unknown[] = [];
    const engine = createSessionStateSyncEngine({
      capabilities: {},
      metadataPort: {
        update: async () => {
          portUpdates.push('called');
          return { ok: true, version: 1 };
        },
      },
    });

    await expect(engine.writeHappierField({
      sessionId: 's1',
      fieldId: 'display.title',
      value: 'Renamed',
      reason: 'user-mutation',
      metadataReason: 'test-title',
    })).resolves.toEqual({ ok: false, reason: 'unsupported' });
    expect(portUpdates).toEqual([]);
  });

  it('dispatches Happier-to-provider writes only when the provider facet and capability support the field', async () => {
    const applied: string[] = [];
    const engine = createSessionStateSyncEngine({
      capabilities: {
        display: {
          title: {
            supported: true,
            happierToProvider: { supported: true, transport: 'runtime-hook' },
          },
        },
        intent: {
          model: {
            supported: true,
            happierToProvider: { supported: false },
          },
        },
      },
      facet: {
        applyHappierField: async (_ctx, field, value) => {
          applied.push(`${field}:${String(value)}`);
        },
        readField: async () => null,
      },
    });

    await expect(engine.applyHappierField({
      ctx: { sessionId: 's1' },
      fieldId: 'display.title',
      value: 'Renamed',
      reason: 'user-mutation',
    })).resolves.toEqual({ ok: true });

    await expect(engine.applyHappierField({
      ctx: { sessionId: 's1' },
      fieldId: 'intent.model',
      value: { v: 1, modelId: 'm1', updatedAt: 1 },
      reason: 'user-mutation',
    })).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
      gate: { supported: false, reason: 'direction-unsupported' },
    });

    expect(applied).toEqual(['display.title:Renamed']);
  });

  it('reports unsupported instead of throwing for deferred view metadata writes', async () => {
    const engine = createSessionStateSyncEngine({
      capabilities: {
        view: {
          readState: { supported: true, happierToProvider: { supported: true } },
        },
      },
      metadataPort: {
        update: async (_sessionId, updater) => {
          updater({});
          return { ok: true, version: 1 };
        },
      },
    });

    await expect(engine.writeHappierField({
      sessionId: 's1',
      fieldId: 'view.readState',
      value: { v: 1, lastReadMessageSeq: 12, updatedAt: 12 },
      reason: 'user-mutation',
      metadataReason: 'test-view',
    })).resolves.toEqual({ ok: false, reason: 'unsupported' });
  });

  it('never dispatches deferred view provider handlers even when capabilities claim support', async () => {
    const applied: unknown[] = [];
    const read: unknown[] = [];
    const observed: unknown[] = [];
    const engine = createSessionStateSyncEngine({
      capabilities: {
        view: {
          readState: {
            supported: true,
            happierToProvider: { supported: true },
            providerToHappier: { supported: true },
          },
          attention: {
            supported: true,
            providerToHappier: { supported: true },
          },
        },
      },
      facet: {
        applyHappierField: async (_ctx, field) => {
          applied.push(field);
        },
        readField: async (_ctx, field) => {
          read.push(field);
          return null;
        },
        observeField: (_ctx, field) => {
          observed.push(field);
          return { dispose: () => {} };
        },
      },
    });

    await expect(engine.applyHappierField({
      ctx: { sessionId: 's1' },
      fieldId: 'view.readState',
      value: { v: 1, lastReadMessageSeq: 12, updatedAt: 12 },
      reason: 'user-mutation',
    })).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
      gate: { supported: false, reason: 'field-unsupported' },
    });

    await expect(engine.readProviderField({
      ctx: { sessionId: 's1' },
      fieldId: 'view.readState',
    })).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
      gate: { supported: false, reason: 'field-unsupported' },
    });

    expect(engine.observeProviderField({
      ctx: { sessionId: 's1' },
      fieldId: 'view.attention',
      emit: () => {},
    })).toEqual({
      ok: false,
      reason: 'unsupported',
      gate: { supported: false, reason: 'field-unsupported' },
    });
    expect(applied).toEqual([]);
    expect(read).toEqual([]);
    expect(observed).toEqual([]);
  });

  it('reports provider read failures through typed results and telemetry', async () => {
    const events: unknown[] = [];
    const engine = createSessionStateSyncEngine({
      capabilities: {
        display: {
          title: {
            supported: true,
            providerToHappier: { supported: true, source: 'snapshot' },
          },
        },
      },
      telemetry: (event) => events.push(event),
      facet: {
        applyHappierField: async () => {},
        readField: async () => {
          throw Object.assign(new Error('boom'), { code: 'provider_unavailable' });
        },
      },
    });

    await expect(engine.readProviderField({
      ctx: { sessionId: 's1' },
      fieldId: 'display.title',
    })).resolves.toEqual({
      ok: false,
      reason: 'provider_error',
      errorCode: 'provider_unavailable',
    });

    expect(events).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        fieldId: 'display.title',
        direction: 'providerToHappier',
        outcome: 'failed',
        errorCode: 'provider_unavailable',
      }),
    ]);
  });

  it('delegates provider observations through registered field handlers', () => {
    const emitted: unknown[] = [];
    const disposed: string[] = [];
    const engine = createSessionStateSyncEngine({
      capabilities: {
        display: {
          title: {
            supported: true,
            providerToHappier: { supported: true, source: 'event' },
          },
        },
      },
      facet: {
        applyHappierField: async () => {},
        readField: async () => null,
        observeField: (_ctx, field, emit) => {
          emit(`${field}:observed`);
          return { dispose: () => disposed.push(String(field)) };
        },
      },
    });

    const disposable = engine.observeProviderField({
      ctx: { sessionId: 's1' },
      fieldId: 'display.title',
      emit: (value) => emitted.push(value),
    });

    expect(disposable).toEqual({ ok: true, disposable: expect.any(Object) });
    if (disposable.ok && typeof disposable.disposable === 'object' && 'dispose' in disposable.disposable) {
      disposable.disposable.dispose();
    }
    expect(emitted).toEqual(['display.title:observed']);
    expect(disposed).toEqual(['display.title']);
  });
});
