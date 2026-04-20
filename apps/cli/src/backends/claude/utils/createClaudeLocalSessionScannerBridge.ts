import { configuration } from '@/configuration';
import { createSessionScanner } from './sessionScanner';
import { resolveClaudeConfigDirOverride } from './resolveClaudeConfigDirOverride';
import type { Session } from '../runtime/session/ClaudeSession';
import type { SessionFoundInfo } from '../runtime/session/ClaudeSession';

type SessionScannerResult = Awaited<ReturnType<typeof createSessionScanner>>;

export async function createClaudeLocalSessionScannerBridge(params: Readonly<{
    session: Session;
    onMessage: Parameters<typeof createSessionScanner>[0]['onMessage'];
}>): Promise<Readonly<{
    handleSessionStart: (sessionId: string) => void;
    cleanup: () => Promise<void>;
}>> {
    const scanner = await createSessionScanner({
        sessionId: params.session.sessionId,
        transcriptPath: params.session.transcriptPath,
        claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
        workingDirectory: params.session.path,
        onMessage: params.onMessage,
        onTranscriptMissing: () => {
            params.session.client.sendSessionEvent({
                type: 'message',
                message: 'Claude transcript not available yet — waiting for it to appear…',
            });
        },
        transcriptMissingWarningMs: configuration.claudeTranscriptMissingWarningMs,
    });

    const scannerSessionCallback = (info: SessionFoundInfo) => {
        scanner.onNewSession({ sessionId: info.sessionId, transcriptPath: info.transcriptPath });
    };
    params.session.addSessionFoundCallback(scannerSessionCallback);

    return {
        handleSessionStart(sessionId: string) {
            params.session.onSessionFound(sessionId);
            scanner.onNewSession({ sessionId, transcriptPath: params.session.transcriptPath });
        },
        async cleanup() {
            params.session.removeSessionFoundCallback(scannerSessionCallback);
            await scanner.cleanup();
        },
    };
}
