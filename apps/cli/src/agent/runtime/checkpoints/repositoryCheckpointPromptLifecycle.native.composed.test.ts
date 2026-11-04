import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentRuntime } from '@happier-dev/plugin-sdk/agents/runtime';

import { createDeferred } from '@/testkit/async/deferred';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { resolveBackendRuntimeCore } from '../registry/engineRegistry/runtimeCore';
import { createEmptyBackendExecutionSurfaces } from '../registry/engineRegistryTypes';
import { createExternalContributionFixtures, createLease } from '../registry/engineRegistry/nativeAgentSession.testkit';
import { isHostSessionRuntimePlan } from '../session/loop/lifecycle';
import { resolveHostSessionRuntimeFactoryResult } from '../session/loop/factoryResult';
import { createRepositoryCheckpointPromptLifecycle } from './repositoryCheckpointPromptLifecycle';

it('holds an opened native mutation until checkpoint preparation completes and preserves rewind bytes', async () => {
    await withTempDir('happier-native-checkpoint-', async directory => {
        const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
        git('init', '-q');
        await writeFile(join(directory, 'tracked.txt'), 'before\n');
        git('add', 'tracked.txt');
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial');
        const cwd = git('rev-parse', '--show-toplevel');
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        // Home's earliest-prompt read is the controlled boundary; Git and native
        // host services remain real while checkpoint preparation is held.
        const session = createMutableApiSessionClientFixture({ overrides: {
            sessionId: 'native-checkpoint',
            fetchEarliestCommittedUserMessageLocalId: async () => { entered.resolve(); await release.promise; return 'message'; },
        } });
        const runtime: AgentRuntime = { toolExecution: { capability: 'interceptable' }, sessions: {
            async open(_request, context) {
                return {
                    async send() {
                        const proposal = await context.session.services.toolExecution.before({ callId: 'edit', name: 'Edit', input: {} });
                        if (proposal.status !== 'continue') throw new Error('Native edit was refused');
                        await writeFile(join(cwd, 'tracked.txt'), 'native edit\n');
                        return { status: 'admitted' };
                    },
                    watch() { return { dispose() {} }; },
                    async dispose() {},
                };
            },
        } };
        const agentId = 'checkpoint-agent';
        const adapter = await resolveBackendRuntimeCore({
            ...createExternalContributionFixtures(agentId), executionSurfaces: createEmptyBackendExecutionSurfaces(),
            runtimeOwner: { backendId: agentId, selected: { kind: 'plugin_engine', ownerId: 'acme.agent-plugin',
                provenance: 'external', pluginId: 'acme.agent-plugin' }, candidates: [] },
            runtimeRegistry: null, happyHomeDir: directory, nativeAgentRuntime: runtime,
            nativeAgentRuntimeIdentity: createLease(agentId),
        });
        if (!adapter) throw new Error('Missing native runtime core');
        const plan = await adapter.runtimeCore.createSessionRuntime({ credentials: { token: 'test-token', encryption: null }, directory: cwd });
        if (!isHostSessionRuntimePlan(plan) || !plan.config.createSessionRuntime) throw new Error('Missing native Session plan');
        const created = await plan.config.createSessionRuntime({
            directory: cwd, metadata: {}, machineId: 'machine', session, transcriptSession: session,
            currentSessionPresentation: createCurrentSessionPresentationHost({ session, signal: new AbortController().signal }).bindCurrentSession,
            messageBuffer: new MessageBuffer(), mcpServers: {}, getPermissionMode: () => 'default', setThinking() {},
            permissionHandler: createProviderEnforcedPermissionHandler({ session, logPrefix: '[checkpoint]' }), memoryRecallGuidanceEnabled: false,
        });
        const operations = resolveHostSessionRuntimeFactoryResult(created).runtime;
        const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: cwd, provider: 'claude', protocol: 'claude' });
        let capture: Promise<void> | undefined;
        let send: Promise<void> | undefined;
        try {
            expect(operations.setBeforeToolExecution).toBeTypeOf('function');
            capture = Promise.resolve(lifecycle.onBeforePromptDispatch?.({ messageId: 'message', prompt: 'edit' }));
            await entered.promise;
            operations.setBeforeToolExecution?.(async () => { await capture; });
            operations.beginTurnLifecycle();
            send = operations.sendTurnPrompt('edit', { localId: 'message', turnId: 'turn', userMessageSeq: 1 });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(await readFile(join(cwd, 'tracked.txt'), 'utf8')).toBe('before\n');
            release.resolve();
            await Promise.all([capture, send]);
            await lifecycle.onTurnStarted?.({ messageId: 'message', turnId: 'turn', sequence: 1 });
            const baseline = git('for-each-ref', '--format=%(refname)', 'refs/happier/checkpoints/').split('\n')
                .find(ref => ref.endsWith('/turn-start/turn'));
            expect(baseline).toBeDefined();
            expect(git('show', `${baseline}:tracked.txt`)).toBe('before');
            expect(await readFile(join(cwd, 'tracked.txt'), 'utf8')).toBe('native edit\n');
        } finally {
            release.resolve();
            await Promise.allSettled([capture, send]);
            operations.setBeforeToolExecution?.(null);
            await lifecycle.onSessionEnd?.();
            await created.operations.resetOrDisposeRuntime();
        }
    });
});
