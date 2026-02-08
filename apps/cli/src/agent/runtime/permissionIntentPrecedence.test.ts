import { describe, expect, it } from 'vitest';

import { resolvePermissionIntentPrecedence } from './permissionIntentPrecedence';

describe('resolvePermissionIntentPrecedence', () => {
  it('prefers latest user message permission over older metadata', () => {
    const res = resolvePermissionIntentPrecedence({
      metadata: { permissionMode: 'default', permissionModeUpdatedAt: 100 } as any,
      latestUserMessage: { meta: { permissionMode: 'bypassPermissions' }, createdAt: 200 } as any,
    });
    expect(res).toEqual({ intent: 'yolo', updatedAt: 200 });
  });

  it('falls back to metadata when there is no user message permission', () => {
    const res = resolvePermissionIntentPrecedence({
      metadata: { permissionMode: 'read-only', permissionModeUpdatedAt: 100 } as any,
      latestUserMessage: null,
    });
    expect(res).toEqual({ intent: 'read-only', updatedAt: 100 });
  });
});

