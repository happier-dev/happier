import { describe, expect, it } from 'vitest';

import {
  acpConfigOptionIntentBinding,
  readAcpConfigOptionIntentFromMetadata,
  readAcpSessionModeIntentFromMetadata,
  writeAcpConfigOptionIntentToMetadata,
  writeAcpSessionModeIntentToMetadata,
  readModelIntentFromMetadata,
  writeModelIntentToMetadata,
  writePermissionModeIntentToMetadata,
} from './intent.js';
import {
  clearSessionStateFieldFromMetadata,
  createSessionStateFieldMetadataUpdater,
  publishSessionStateFieldToMetadata,
} from './publishField.js';

describe('intent session-state bindings', () => {
  it('reads the newest canonical-or-legacy model intent with canonical tie precedence', () => {
    const canonical = {
      v: 1 as const,
      updatedAt: 10,
      selection: {
        agentTargetKey: 'agent:codex',
        providerConnectionId: 'pc_work',
        modelId: 'vendor/model',
      },
    };
    expect(readModelIntentFromMetadata({
      modelSelectionIntentV1: canonical,
      modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'legacy-native' },
    })).toEqual(canonical);
    expect(readModelIntentFromMetadata({
      modelSelectionIntentV1: canonical,
      modelOverrideV1: { v: 1, updatedAt: 11, modelId: null },
    })).toEqual({ v: 1, updatedAt: 11, modelId: null });
  });

  it('writes canonical model intent only, with bumped stale updates and clear tombstones', () => {
    const base = {
      modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gpt-4' },
    };

    const changed = writeModelIntentToMetadata(base, {
      v: 1,
      updatedAt: 9,
      selection: {
        agentTargetKey: 'agent:codex',
        providerConnectionId: 'pc_work',
        modelId: 'gpt-5',
      },
    });
    expect(changed).toEqual({
      modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gpt-4' },
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 11,
        selection: {
          agentTargetKey: 'agent:codex',
          providerConnectionId: 'pc_work',
          modelId: 'gpt-5',
        },
      },
    });

    const cleared = writeModelIntentToMetadata(changed, {
      v: 1,
      updatedAt: 8,
      selection: null,
    });
    expect(cleared).toEqual({
      modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gpt-4' },
      modelSelectionIntentV1: { v: 1, updatedAt: 12, selection: null },
    });
  });

  it('canonicalizes valid permission aliases and drops stale or invalid candidates', () => {
    const base = { permissionMode: 'safe-yolo', permissionModeUpdatedAt: 10 };

    expect(writePermissionModeIntentToMetadata(base, {
      permissionMode: 'read-only',
      updatedAt: 9,
    })).toBe(base);

    expect(writePermissionModeIntentToMetadata(base, {
      permissionMode: 'definitely-invalid-token',
      updatedAt: 99,
    })).toBe(base);

    expect(writePermissionModeIntentToMetadata(base, {
      permissionMode: 'bypassPermissions',
      updatedAt: 11,
    })).toEqual({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 11,
    });
  });

  it('dual-writes ACP session mode canonical and legacy aliases using canonical timestamp source', () => {
    const base = {
      sessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 3, modeId: 'plan' },
    };

    expect(writeAcpSessionModeIntentToMetadata(base, {
      modeId: 'build',
      updatedAt: 5,
    })).toEqual({
      sessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'build' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'build' },
    });
  });

  it('arbitrates ACP session mode writes against the newest alias value', () => {
    const base = {
      sessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 20, modeId: 'review' },
    };

    expect(writeAcpSessionModeIntentToMetadata(base, {
      modeId: 'build',
      updatedAt: 15,
    })).toEqual({
      sessionModeOverrideV1: { v: 1, updatedAt: 21, modeId: 'build' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 21, modeId: 'build' },
    });

    expect(writeAcpSessionModeIntentToMetadata(base, {
      modeId: 'review',
      updatedAt: 15,
    })).toBe(base);
  });

  it('reads ACP session mode from the newest divergent alias', () => {
    expect(readAcpSessionModeIntentFromMetadata({
      sessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 20, modeId: 'review' },
    })).toEqual({
      v: 1,
      modeId: 'review',
      updatedAt: 20,
    });
  });

  it('reads ACP session mode clear tombstones from the newest alias', () => {
    expect(readAcpSessionModeIntentFromMetadata({
      sessionModeOverrideV1: { v: 1, updatedAt: 20, modeId: null },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
    })).toEqual({
      v: 1,
      modeId: null,
      updatedAt: 20,
    });

    expect(readAcpSessionModeIntentFromMetadata({
      sessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 20, modeId: null },
    })).toEqual({
      v: 1,
      modeId: null,
      updatedAt: 20,
    });
  });

  it('dual-writes ACP config option aliases and preserves sibling per-entry timestamps', () => {
    const base = {
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 11,
        overrides: {
          telemetry: { updatedAt: 11, value: 'true' },
          notifications: { updatedAt: 9, value: 'false' },
        },
      },
    };

    const stale = writeAcpConfigOptionIntentToMetadata(base, {
      configId: 'telemetry',
      value: 'false',
      updatedAt: 10,
    });
    expect(stale).toBe(base);

    expect(writeAcpConfigOptionIntentToMetadata(base, {
      configId: 'notifications',
      value: 'true',
      updatedAt: 12,
    })).toEqual({
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 12,
        overrides: {
          telemetry: { updatedAt: 11, value: 'true' },
          notifications: { updatedAt: 12, value: 'true' },
        },
      },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 12,
        overrides: {
          telemetry: { updatedAt: 11, value: 'true' },
          notifications: { updatedAt: 12, value: 'true' },
        },
      },
    });
  });

  it('reads the latest ACP config option entry through the generic binding', () => {
    const value = acpConfigOptionIntentBinding.read({
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 20,
        overrides: {
          effort: { updatedAt: 10, value: 'medium' },
          speed: { updatedAt: 20, value: 'fast' },
        },
      },
    });

    expect(value).toEqual({
      value: {
        v: 1,
        configId: 'speed',
        value: 'fast',
        updatedAt: 20,
      },
      updatedAt: 20,
    });
    expect(readAcpConfigOptionIntentFromMetadata({
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 20,
        overrides: {
          effort: { updatedAt: 10, value: 'medium' },
        },
      },
    }, 'effort')).toEqual({
      v: 1,
      configId: 'effort',
      value: 'medium',
      updatedAt: 10,
    });
  });

  it('arbitrates divergent ACP config option aliases per option by newest entry timestamp', () => {
    const metadata = {
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 20,
        overrides: {
          effort: { updatedAt: 20, value: 'medium' },
          speed: { updatedAt: 15, value: 'fast' },
        },
      },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 30,
        overrides: {
          effort: { updatedAt: 30, value: 'high' },
          notifications: { updatedAt: 25, value: false },
        },
      },
    };

    expect(readAcpConfigOptionIntentFromMetadata(metadata, 'effort')).toEqual({
      v: 1,
      configId: 'effort',
      value: 'high',
      updatedAt: 30,
    });
    expect(readAcpConfigOptionIntentFromMetadata(metadata, 'speed')).toEqual({
      v: 1,
      configId: 'speed',
      value: 'fast',
      updatedAt: 15,
    });
    expect(readAcpConfigOptionIntentFromMetadata(metadata, 'notifications')).toEqual({
      v: 1,
      configId: 'notifications',
      value: false,
      updatedAt: 25,
    });
  });

  it('writes ACP config option updates against the newest alias value instead of canonical-first state', () => {
    const base = {
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 10,
        overrides: {
          effort: { updatedAt: 10, value: 'medium' },
        },
      },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 20,
        overrides: {
          effort: { updatedAt: 20, value: 'high' },
        },
      },
    };

    expect(writeAcpConfigOptionIntentToMetadata(base, {
      configId: 'effort',
      value: 'low',
      updatedAt: 15,
    })).toBe(base);

    expect(writeAcpConfigOptionIntentToMetadata(base, {
      configId: 'effort',
      value: 'low',
      updatedAt: 21,
    })).toEqual({
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 21,
        overrides: {
          effort: { updatedAt: 21, value: 'low' },
        },
      },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 21,
        overrides: {
          effort: { updatedAt: 21, value: 'low' },
        },
      },
    });
  });

  it('keeps canonical ACP config option values when aliases tie on timestamp', () => {
    expect(readAcpConfigOptionIntentFromMetadata({
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 20,
        overrides: {
          effort: { updatedAt: 20, value: 'canonical' },
        },
      },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 20,
        overrides: {
          effort: { updatedAt: 20, value: 'legacy' },
        },
      },
    }, 'effort')).toEqual({
      v: 1,
      configId: 'effort',
      value: 'canonical',
      updatedAt: 20,
    });
  });

  it('writes null ACP config option tombstones through canonical and legacy aliases', () => {
    expect(writeAcpConfigOptionIntentToMetadata({
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 10,
        overrides: {
          speed: { updatedAt: 10, value: 'fast' },
        },
      },
    }, {
      configId: 'speed',
      value: null,
      updatedAt: 11,
    })).toEqual({
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 11,
        overrides: {
          speed: { updatedAt: 11, value: null },
        },
      },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 11,
        overrides: {
          speed: { updatedAt: 11, value: null },
        },
      },
    });
  });
});

describe('intent session-state metadata updater', () => {
  it('creates a field updater backed by the registered binding', () => {
    const updater = createSessionStateFieldMetadataUpdater('intent.model', {
      v: 1,
      updatedAt: 20,
      selection: {
        agentTargetKey: 'agent:codex',
        providerConnectionId: null,
        modelId: 'gpt-5',
      },
    });

    expect(updater({ modelOverrideV1: { v: 1, modelId: 'gpt-4', updatedAt: 10 } })).toEqual({
      modelOverrideV1: { v: 1, modelId: 'gpt-4', updatedAt: 10 },
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 20,
        selection: {
          agentTargetKey: 'agent:codex',
          providerConnectionId: null,
          modelId: 'gpt-5',
        },
      },
    });
  });

  it('publishes intent fields through a metadata updater callback', async () => {
    const updates: unknown[] = [];

    await publishSessionStateFieldToMetadata({
      sessionId: 's1',
      fieldId: 'intent.permissionMode',
      value: { v: 1, permissionMode: 'safe-yolo', updatedAt: 42 },
      updateSessionMetadataWithRetry: async (_sessionId, updater) => {
        updates.push(updater({ permissionModeUpdatedAt: 10 }));
      },
    });

    expect(updates).toEqual([{ permissionMode: 'safe-yolo', permissionModeUpdatedAt: 42 }]);
  });

  it('publishes intent fields through the metadata update port when provided', async () => {
    const updates: unknown[] = [];

    await publishSessionStateFieldToMetadata({
      sessionId: 's1',
      fieldId: 'intent.permissionMode',
      value: { v: 1, permissionMode: 'safe-yolo', updatedAt: 42 },
      metadataPort: {
        update: async (sessionId, updater, opts) => {
          updates.push({
            sessionId,
            opts,
            metadata: updater({ permissionModeUpdatedAt: 10 }),
          });
          return { ok: true, version: 1 };
        },
      },
      reason: 'intent-test',
    });

    expect(updates).toEqual([{
      sessionId: 's1',
      opts: { reason: 'intent-test' },
      metadata: { permissionMode: 'safe-yolo', permissionModeUpdatedAt: 42 },
    }]);
  });

  it('clears both canonical and legacy ACP config option override aliases', () => {
    expect(clearSessionStateFieldFromMetadata({
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 20,
        overrides: {
          effort: { updatedAt: 20, value: 'high' },
        },
      },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 10,
        overrides: {
          effort: { updatedAt: 10, value: 'medium' },
        },
      },
      modelOverrideV1: { v: 1, updatedAt: 5, modelId: 'gpt-5' },
    }, 'intent.acpConfigOption')).toEqual({
      modelOverrideV1: { v: 1, updatedAt: 5, modelId: 'gpt-5' },
    });
  });
});
