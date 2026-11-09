import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import type { ActionId } from './actionIds.js';

describe('mounted client scope Actions', () => {
  it.each(['session.list.view.get', 'session.list.view.set', 'session.list.view.reset',
    'workflow.library.view.get', 'workflow.library.view.set', 'workflow.library.view.reset', 'shell.column.get', 'shell.column.set'])(
    'discovers %s and refuses execution without its mounted client owner', async (id) => {
      const executor = createActionExecutor({} as ActionExecutorDeps);
      const input = id === 'session.list.view.set' ? { filters: { scope: 'assigned_to_me' } }
        : id === 'workflow.library.view.set' ? { filters: { view: 'running' }, searchQuery: 'release' }
        : id === 'shell.column.set' ? { visible: true } : {};
      const result = await executor.execute(id as ActionId, input, { surface: 'ui' });
      expect(result).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
      expect(getActionSpec(id)).toMatchObject({ executionPlacement: 'client' });
    },
  );
});
