import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import type { TerminalHostHandle } from './_types';
import { createDefaultTerminalHostRegistry } from './defaultRegistry';

it('disposes the recorded Herdr pane with no Herdr executable in the daemon environment', async () => {
  await withHerdrApi(async ({ binary, panes, socketPath }) => {
    vi.stubEnv('HERDR_BIN_PATH', join(binary, 'missing'));
    try {
      const launchAdapters = await createDefaultTerminalHostRegistry({ zellijBinary: null });
      expect(launchAdapters.herdr).toBeUndefined();
      const controlOptions = { zellijBinary: null, forExistingAttachments: true } as const;
      const controlAdapters = await createDefaultTerminalHostRegistry(controlOptions);
      const handle: TerminalHostHandle = {
        kind: 'herdr', sessionName: 'default', socketPath, paneId: 'stale-pane-id', terminalId: 'terminal_1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
      };
      panes.add('managed');
      panes.add('unrelated');

      expect(controlAdapters.herdr).toBeDefined();
      await controlAdapters.herdr!.dispose(handle);

      expect([...panes]).toEqual(['unrelated']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
