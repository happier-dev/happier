import { describe, expect, it } from 'vitest';

import {
  buildOpenCodeTodoWorkState,
} from './openCodeTodoWorkState.js';

describe('OpenCode todo work-state mapping', () => {
  it('maps native todos to bounded generic work-state todo items', () => {
    const snapshot = buildOpenCodeTodoWorkState({
      backendId: 'opencode',
      agentId: 'opencode',
      updatedAt: 100,
      maxItems: 2,
      todos: [
        { content: 'Pending later', status: 'pending', priority: 'medium' },
        { id: 'active-1', content: 'Doing now', status: 'in_progress', priority: 'high' },
        { content: 'Done', status: 'completed', priority: 'low' },
      ],
    });

    expect(snapshot).toMatchObject({
      v: 1,
      backendId: 'opencode',
      agentId: 'opencode',
      updatedAt: 100,
      primaryItemId: 'todo:opencode:active-1',
      truncated: {
        reason: 'item_limit',
        omittedCount: 1,
      },
    });
    expect(snapshot.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      origin: item.origin,
      status: item.status,
      title: item.title,
      priority: item.priority,
      vendorRef: item.vendorRef,
    }))).toEqual([
      {
        id: 'todo:opencode:active-1',
        kind: 'todo',
        origin: 'vendor',
        status: 'active',
        title: 'Doing now',
        priority: 'high',
        vendorRef: 'active-1',
      },
      {
        id: expect.stringMatching(/^todo:opencode:derived:/),
        kind: 'todo',
        origin: 'vendor',
        status: 'pending',
        title: 'Pending later',
        priority: 'medium',
        vendorRef: undefined,
      },
    ]);
  });

  it('retains the active todo when bounding would otherwise truncate it', () => {
    const snapshot = buildOpenCodeTodoWorkState({
      backendId: 'opencode',
      updatedAt: 100,
      maxItems: 2,
      todos: [
        { id: 'old-pending-1', content: 'Old pending 1', status: 'pending' },
        { id: 'old-pending-2', content: 'Old pending 2', status: 'pending' },
        { id: 'active-1', content: 'Doing now', status: 'in_progress' },
      ],
    });

    expect(snapshot.primaryItemId).toBe('todo:opencode:active-1');
    expect(snapshot.items.map((item) => item.id)).toEqual([
      'todo:opencode:active-1',
      'todo:opencode:old-pending-1',
    ]);
    expect(snapshot.truncated).toEqual({
      reason: 'item_limit',
      omittedCount: 1,
    });
  });

});
