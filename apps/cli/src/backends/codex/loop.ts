import type { ApiSessionClient } from '@/api/apiSession';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

import { codexLocalLauncher, type CodexLauncherResult } from './codexLocalLauncher';

type Mode = 'local' | 'remote';

type LoopOptions = {
  path: string;
  onModeChange: (mode: Mode) => void;
  session: ApiSessionClient;
  api: unknown;
  messageQueue: MessageQueue2<unknown>;
  remoteLauncher: (opts: {
    path: string;
    session: ApiSessionClient;
    api: unknown;
    messageQueue: MessageQueue2<unknown>;
  }) => Promise<'exit' | 'switch'>;
  onSessionReady?: (session: { cleanup: () => void }) => void;
};

/**
 * Minimal remote/local loop for Codex.
 *
 * This is primarily used by unit tests and establishes the shared shape needed
 * by the remote/local switching design.
 */
export async function loop(opts: LoopOptions): Promise<number> {
  let mode: Mode = 'local';

  const cleanup = () => {
    // No-op for now; placeholder for parity with Claude loop.
  };

  opts.onSessionReady?.({ cleanup });

  while (true) {
    switch (mode) {
      case 'local': {
        const result: CodexLauncherResult = await codexLocalLauncher({
          path: opts.path,
          api: opts.api,
          session: opts.session,
          messageQueue: opts.messageQueue,
        });

        if (result.type === 'exit') {
          return result.code;
        }

        mode = 'remote';
        opts.onModeChange(mode);
        opts.session.keepAlive(false, mode);
        break;
      }
      case 'remote': {
        const reason = await opts.remoteLauncher({
          path: opts.path,
          api: opts.api,
          session: opts.session,
          messageQueue: opts.messageQueue,
        });

        if (reason === 'exit') {
          return 0;
        }

        mode = 'local';
        opts.onModeChange(mode);
        opts.session.keepAlive(false, mode);
        break;
      }
    }
  }
}
