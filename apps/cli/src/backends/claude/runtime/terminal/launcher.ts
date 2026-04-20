import { createClaudeRawMessageTurnDiffBridge } from '@/backends/claude/utils/createClaudeRawMessageTurnDiffBridge';

import { Session } from '../session/ClaudeSession';
import { createClaudeTerminalLaunchController } from './createLaunchController';

export type LauncherResult = { type: 'switch' } | { type: 'exit', code: number };

export async function launchClaudeTerminalSession(
    session: Session,
    opts?: {
        /**
         * Indicates why we are entering local mode.
         *
         * - `initial`: first local launch for this process (must not block spawn on server pending-queue inspection)
         * - `switch`: switching from remote → local (must enforce discard/pending safety before switching)
         */
        entry?: 'initial' | 'switch';
    },
): Promise<LauncherResult> {
    const entry = opts?.entry ?? 'initial';
    const turnDiffBridge = createClaudeRawMessageTurnDiffBridge({
        getSessionId: () => session.sessionId ?? session.client.sessionId ?? 'unknown',
        sendMessage: (message) => {
            session.client.sendClaudeSessionMessage(message);
        },
    });
    const controller = createClaudeTerminalLaunchController({
        session,
        entry,
        turnDiffBridge,
    });
    return await controller.run();
}
