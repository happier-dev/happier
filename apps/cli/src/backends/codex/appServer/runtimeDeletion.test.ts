import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Codex host app-server runtime ownership', () => {
    it('does not retain the old host app-server runtime folder', () => {
        const appServerDir = dirname(fileURLToPath(import.meta.url));

        expect(existsSync(join(appServerDir, 'runtime'))).toBe(false);
    });

    it('does not retain stale host-only app-server helper leaves', () => {
        const appServerDir = dirname(fileURLToPath(import.meta.url));

        expect(existsSync(join(appServerDir, 'rememberCodexUsageLimitRecoveryPreference.ts'))).toBe(false);
        expect(existsSync(join(appServerDir, 'seedPendingSessionOverrides.ts'))).toBe(false);
    });

    it('does not retain stale host app-server lifecycle/request/stream owners', () => {
        const appServerDir = dirname(fileURLToPath(import.meta.url));
        const staleFiles = [
            'createCodexAppServerClientLifecycle.ts',
            'createCodexAppServerPendingTurnLifecycle.ts',
            'createCodexAppServerRequestHandlers.ts',
            'createCodexAppServerRuntimeControlState.ts',
            'createCodexAppServerStreamLifecycle.ts',
            'media/extractCodexGeneratedMedia.ts',
            'permissionProfile.ts',
            'projection/toolProjector.ts',
            'projection/turnDiffProjector.ts',
            'readCodexAppServerRpcFields.ts',
            'registerCodexAppServerClientHandlers.ts',
            'reviews/codexAppServerReviewTypes.ts',
            'reviews/resolveCodexAppServerNativeReviewRequest.ts',
            'rollbackConversation.ts',
            'rollbackMetadata.ts',
            'sessionControlsMetadata.ts',
            'startOrLoadThread.ts',
            'streamEventBridge.ts',
        ];

        for (const staleFile of staleFiles) {
            expect(existsSync(join(appServerDir, staleFile))).toBe(false);
        }
    });

    it('does not retain stale host Codex runtime utility wrappers', () => {
        const appServerDir = dirname(fileURLToPath(import.meta.url));
        const codexDir = join(appServerDir, '..');

        expect(existsSync(join(codexDir, 'runtime'))).toBe(false);
    });
});
