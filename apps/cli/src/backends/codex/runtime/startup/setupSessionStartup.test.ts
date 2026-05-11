import { describe, expect, it } from 'vitest';

import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { setupCodexSessionStartup } from './setupSessionStartup';
import type { CodexTerminalRuntimeLaunchResult } from '../../terminalRuntime/launchTerminalRuntime';

describe('setupCodexSessionStartup', () => {
    it('forwards native Codex args into the fast-start terminal launcher', async () => {
        let capturedCodexArgs: readonly string[] | undefined;
        const startupParams: Parameters<typeof setupCodexSessionStartup>[0] = {
            requestedDirectory: '/tmp/happier-codex-startup',
            startedByForTerminalRuntime: 'cli',
            hasTtyForTerminalRuntime: true,
            explicitStartingRuntimeMode: 'terminal',
            resumeIdFromArgs: null,
            codexBackendMode: 'appServer',
            existingSessionId: null,
            hasExplicitPermissionMode: true,
            messageQueue: {},
            messageBuffer: {} as MessageBuffer,
            initialPermissionMode: 'default',
            codexArgs: ['exec', '--model', 'gpt-5.1-codex-max'],
            nowMs: () => 123,
            timing: null,
            requireCodexTerminalRuntimeLaunch: async () =>
                async (launchArgs): Promise<CodexTerminalRuntimeLaunchResult> => {
                    capturedCodexArgs = launchArgs.codexArgs;
                    expect(launchArgs.path).toBe('/tmp/happier-codex-startup');
                    return { type: 'exit', code: 0 };
                },
            logger: { debug: () => undefined },
        };

        const artifacts = await setupCodexSessionStartup(startupParams);
        await expect(artifacts.terminalLauncherPromise).resolves.toEqual({ type: 'exit', code: 0 });
        expect(capturedCodexArgs).toEqual(['exec', '--model', 'gpt-5.1-codex-max']);
    });
});
