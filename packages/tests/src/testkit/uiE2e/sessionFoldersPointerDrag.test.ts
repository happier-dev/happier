import { describe, expect, it, vi } from 'vitest';

import { buildSessionListIndexNodeId } from '../../../../../apps/ui/sources/sync/domains/sessionList/sessionListIndexIdentity';
import { readVisibleSessionRowOrder } from './sessionFoldersPointerDrag';

describe('readVisibleSessionRowOrder', () => {
  it('reads base order for the supplied Home without confusing mirrors or same-id foreign Sessions', async () => {
    const serverId = 'home:["a"]';
    const sessionIds = ['one:session', 'two"session'];
    const row = (serverId: string, sessionId: string, y: number, occurrenceRole: 'base' | 'needsYou' | 'working' = 'base') => ({
      getAttribute: () => `session-list-item-${buildSessionListIndexNodeId({ type: 'session', serverId, sessionId, occurrenceRole })}`,
      getBoundingClientRect: () => ({ top: y }),
    });
    // The DOM is the external browser boundary; occurrence generation stays real.
    vi.stubGlobal('document', {
      querySelectorAll: () => [
        row(serverId, sessionIds[0]!, 0, 'needsYou'),
        row('other-home', sessionIds[0]!, 10),
        row(serverId, sessionIds[0]!, 40),
        row(serverId, sessionIds[1]!, 20),
        row(serverId, sessionIds[1]!, 5, 'working'),
      ],
    });
    const page = {
      evaluate: async <TArg, TResult>(callback: (arg: TArg) => TResult, arg: TArg) => callback(arg),
    };
    try {
      await expect(readVisibleSessionRowOrder(page as never, { serverId, sessionIds })).resolves.toEqual([
        sessionIds[1], sessionIds[0],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
