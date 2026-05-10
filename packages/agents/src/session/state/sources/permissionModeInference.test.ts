import { describe, expect, it } from 'vitest';

import { inferLatestUserPermissionModeIntent } from './permissionModeInference.js';

describe('inferLatestUserPermissionModeIntent', () => {
  it('returns the latest valid user message permission-mode intent', () => {
    expect(inferLatestUserPermissionModeIntent([
      { kind: 'user-text', createdAt: 10, meta: { permissionMode: 'read-only' } },
      { kind: 'assistant-text', createdAt: 20, meta: { permissionMode: 'bypassPermissions' } },
      { kind: 'user-text', createdAt: 30, meta: { permissionMode: 'acceptEdits' } },
    ])).toEqual({
      permissionMode: 'safe-yolo',
      updatedAt: 30,
    });
  });

  it('ignores invalid modes and invalid timestamps', () => {
    expect(inferLatestUserPermissionModeIntent([
      { kind: 'user-text', createdAt: 10, meta: { permissionMode: 'not-a-mode' } },
      { kind: 'user-text', createdAt: Number.NaN, meta: { permissionMode: 'read-only' } },
    ])).toBeNull();
  });
});
