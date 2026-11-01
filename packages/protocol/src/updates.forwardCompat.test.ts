import { describe, expect, it } from 'vitest';

import {
  SessionBroadcastContainerSchema,
  UpdateBodySchema,
  UpdateMetadataAckResponseSchema,
  UpdateStateAckResponseSchema,
} from './updates.js';

describe('updates forward compatibility', () => {
  it('accepts a whole Machine content transition including an absent daemon state', () => {
    const body = {
      t: 'update-machine',
      machineId: 'machine_1',
      metadata: { value: 'encoded-next-metadata', version: 2 },
      daemonState: { value: null, version: 3 },
      dataEncryptionKey: 'encoded-next-key-carrier',
      contentPublicKeyFingerprint: null,
    };
    expect(UpdateBodySchema.parse(body)).toEqual(body);
  });
  const completeRuntimeActivityProjection = {
    runtimeActivityState: 'active' as const,
    runtimeActivityActiveCount: 1,
    runtimeActivityObservedAt: 1,
    runtimeActivityRevision: 1,
  };

  it('accepts extra fields in session broadcast containers', () => {
    const parsed = SessionBroadcastContainerSchema.safeParse({
      id: 'b1',
      createdAt: Date.now(),
      body: { t: 'session-changed', sessionId: 'sess_1' },
      extraFieldAddedInFuture: true,
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts extra fields in update-metadata ack responses', () => {
    const parsed = UpdateMetadataAckResponseSchema.safeParse({
      result: 'success',
      version: 1,
      metadata: 'cipher',
      extra: { ok: true },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts extra fields in update-state ack responses', () => {
    const parsed = UpdateStateAckResponseSchema.safeParse({
      result: 'success',
      version: 1,
      agentState: null,
      extra: { ok: true },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts extra fields in kv-batch-update changes', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'kv-batch-update',
      changes: [
        {
          key: 'k',
          value: null,
          version: 1,
          extra: { ok: true },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  const sessionUpdatesWithCompleteRuntimeActivity = [
    {
      label: 'new-session',
      body: {
        t: 'new-session',
        id: 'sess_1',
        seq: 1,
        metadata: 'metadata',
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        dataEncryptionKey: null,
        active: true,
        activeAt: 1,
        createdAt: 1,
        updatedAt: 1,
        ...completeRuntimeActivityProjection,
      },
    },
    {
      label: 'update-session',
      body: {
        t: 'update-session',
        id: 'sess_1',
        ...completeRuntimeActivityProjection,
      },
    },
  ] as const;

  it.each(sessionUpdatesWithCompleteRuntimeActivity)(
    'accepts a complete Runtime Activity tuple in $label',
    ({ body }) => {
      expect(UpdateBodySchema.safeParse(body).success).toBe(true);
    },
  );

  it.each(sessionUpdatesWithCompleteRuntimeActivity)(
    'rejects every partial Runtime Activity tuple in $label',
    ({ body }) => {
      for (const missingField of [
        'runtimeActivityState',
        'runtimeActivityActiveCount',
        'runtimeActivityObservedAt',
        'runtimeActivityRevision',
      ] as const) {
        const { [missingField]: _omitted, ...partialBody } = body;
        expect(UpdateBodySchema.safeParse(partialBody).success, missingField).toBe(false);
      }
    },
  );

  it.each(sessionUpdatesWithCompleteRuntimeActivity)(
    'rejects a contradictory complete Runtime Activity tuple in $label',
    ({ body }) => {
      expect(UpdateBodySchema.safeParse({
        ...body,
        runtimeActivityActiveCount: 0,
      }).success).toBe(false);
    },
  );

  it.each(sessionUpdatesWithCompleteRuntimeActivity)(
    'rejects a complete Runtime Activity tuple above the public count bound in $label',
    ({ body }) => {
      expect(UpdateBodySchema.safeParse({
        ...body,
        runtimeActivityActiveCount: 2_147_483_648,
      }).success).toBe(false);
    },
  );

  it('rejects an explicitly null state in a complete Runtime Activity tuple', () => {
    expect(UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      ...completeRuntimeActivityProjection,
      runtimeActivityState: null,
    }).success).toBe(false);
  });

  it.each(sessionUpdatesWithCompleteRuntimeActivity)(
    'rejects the superseded Runtime Activity sourceClass field in $label',
    ({ body }) => {
      expect(UpdateBodySchema.safeParse({
        ...body,
        runtimeActivitySourceClass: 'agent_detached_task',
      }).success).toBe(false);
    },
  );

  it('keeps unrelated update-session fields forward-compatible when Activity is absent', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      futureSessionField: { enabled: true },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({ futureSessionField: { enabled: true } });
  });
});
