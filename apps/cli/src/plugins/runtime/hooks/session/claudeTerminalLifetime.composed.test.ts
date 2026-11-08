import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createNativeAgentTerminalModeBinding } from '@/agent/runtime/session/terminal/nativeAgentModeBinding';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { createSessionHooksService } from './service';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createEventsFixture, createPluginContextFixture, createTerminalHostFixture } from '../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';

describe('Claude terminal materialized resource lifetime', () => {
    it('keeps SessionEnd hooks and MCP files until native termination during Session disposal', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'claude-terminal-lifetime-'));
        const disposables: Array<{ dispose(): void | Promise<void> }> = [];
        const hooks = createSessionHooksService({ happyHomeDir: directory,
            hasCapability: capability => capability === 'sessionHooks',
            addDisposable: disposable => { disposables.push(disposable); } });
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
            { sessionHooks: hooks });
        const operations = createClaudeAgentSdkTurnOperations({ ctx, directory, launchEnv: {},
            happierSessionId: 'terminal-lifetime', permissionMode: 'default',
            mcpServers: { fixture: { command: 'fixture-mcp' } }, startupInstructions: 'Fixture startup instructions' });
        // Adapt the real provider operations to the generic host contract; no internal owner is mocked.
        let runtimeDisposalStarted = false;
        const runtime: RuntimeTurnOperations = {
            beginTurnLifecycle: () => operations.beginProviderTurn(),
            sendTurnPrompt: async prompt => { await operations.sendProviderTurnPrompt(prompt); },
            steerInFlightTurn: async prompt => { await operations.steerProviderTurn(prompt); },
            waitForTurnCompletion: options => operations.waitForProviderTurnCompletion(options),
            subscribeRuntimeEvents: listener => operations.subscribeCanonicalAgentSessionEvents(listener),
            cancelTurn: async () => { await operations.cancelProviderTurn(); },
            readSessionIdentity: () => operations.readProviderIdentity(),
            updateSessionRuntimeConfig: update => operations.updateProviderConfiguration({
                ...update,
                modeId: update.modeId ?? undefined,
                permissionMode: update.permissionMode ?? undefined,
                configOption: update.configOption ?? undefined,
            }),
            resetOrDisposeRuntime: async () => {
                runtimeDisposalStarted = true;
                await operations.disposeProviderSession();
                await Promise.all(disposables.map(disposable => disposable.dispose()));
            },
        };
        let nativeStarted!: () => void;
        const started = new Promise<void>(resolve => { nativeStarted = resolve; });
        let finishNative!: () => void;
        const nativeCanExit = new Promise<void>(resolve => { finishNative = resolve; });
        let stopRequested!: () => void;
        const stopping = new Promise<void>(resolve => { stopRequested = resolve; });
        let pluginDir = '';
        let mcpPath = '';
        let instructionsPath = '';
        const binding = createNativeAgentTerminalModeBinding({ runtime, agentId: 'claude', sessionId: 'terminal-lifetime',
            directory, readMetadata: () => ({}), host: null,
            runWithTerminalModelSelection: async effect => ({ status: 'completed',
                value: await effect(null, async localEffect => ({ status: 'completed', value: await localEffect() })) }),
            terminal: { launch: async request => {
                const presentation = await operations.prepareTerminalPresentation();
                if (presentation.kind !== 'terminal_launch') throw new Error('Expected terminal launch');
                const plan = presentation.plan;
                pluginDir = plan.argv[plan.argv.indexOf('--plugin-dir') + 1]!;
                mcpPath = plan.argv[plan.argv.indexOf('--mcp-config') + 1]!;
                instructionsPath = plan.argv[plan.argv.indexOf('--append-system-prompt-file') + 1]!;
                await operations.observeTerminalExecution({ kind: 'started', plan });
                request.signal?.addEventListener('abort', stopRequested, { once: true });
                nativeStarted();
                // The external process boundary acknowledges stop before its SessionEnd hook runs.
                await nativeCanExit;
                await readFile(join(pluginDir, 'hooks', 'hooks.json'), 'utf8');
                await operations.observeTerminalExecution({ kind: 'provider_stopped', plan, exitCode: 0, signal: null });
                return { type: 'process_exited', exitCode: 0 };
            } },
        });
        const run = binding.terminalRemoteModeLoop!.runTerminal({ entry: 'initial' });
        let disposal: Promise<void> | undefined;
        try {
            await started;
            let disposed = false;
            disposal = binding.runtime.resetOrDisposeRuntime('session_closed').then(() => { disposed = true; });
            await stopping;
            // Observe completed teardown if it raced ahead of the native process.
            if (runtimeDisposalStarted) await disposal;
            await stat(join(pluginDir, 'hooks', 'hooks.json'));
            await stat(mcpPath);
            await stat(instructionsPath);
            expect(disposed).toBe(false);
            finishNative();
            await run;
            await disposal;
            await expect(stat(pluginDir)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(mcpPath)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(instructionsPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            finishNative();
            await run.catch(() => undefined);
            await disposal?.catch(() => undefined);
            await runtime.resetOrDisposeRuntime();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
