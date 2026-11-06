import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createHostScmCommandRunner, createScmCommandRunnerFromExecService, runScmCommand, runWithScmCommandRunner, type ScmCommandRunner } from '@/scm/runtime';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import { captureScmComparison, deleteCapturedScmComparison, prepareCapturedScmComparisonInvestigation } from '@/scm/comparisons/captureScmComparison';
import { createRepositoryCheckpointPromptLifecycle } from './repositoryCheckpointPromptLifecycle';
import { configuration } from '@/configuration';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createSessionDaemonAuthorityFixture } from '@/mcp/runtime/sessionDaemonAuthority.testkit';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { createRunnerDaemonPluginServicesHost, projectRunnerDaemonPluginServicesFailure } from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import { RunnerDaemonPluginServiceOperationV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { isHostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import { resolveHostSessionRuntimeFactoryResult } from '@/agent/runtime/session/loop/factoryResult';
import type { HostSessionRuntimeHookRuntime } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';

async function openNativeSession(cwd: string, session: ReturnType<typeof createMutableApiSessionClientFixture>, pluginExec: ReturnType<typeof createStablePluginExecService>, hasIsolation: boolean) {
    const pluginId = `acme.checkpoint-${session.sessionId}`;
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir, plugins: [{
        manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { agents: [{
            id: 'agent', title: 'Checkpoint Agent', runtime: { kind: 'custom' }, primary: 'sessions',
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: false } },
        }] } }),
        files: { 'factory.mjs': `
            export function createRuntime() { return { sessions: { async open() { return {
                async send() { return { status: 'admitted' }; }, watch() { return { dispose() {} }; }, async dispose() {},
            }; } } }; }
        `, 'daemon.mjs': `
            import { createRuntime } from './factory.mjs';
            export function activate(api) { api.agents.register('agent', createRuntime, {
                sessionRunnerFactory: { module: './factory.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            }); }
        ` },
    }] });
    const agentId = `${pluginId}/agent`;
    const registration = fixture.registry.agentRuntimesByAgentId.get(agentId);
    const binding = registration?.sessionRunnerFactoryBinding;
    if (!registration || !binding || 'kind' in binding) {
        const diagnostics = fixture.registry.pluginDiagnosticsByPluginId[pluginId];
        await fixture.dispose();
        throw new Error(`Missing native fixture Agent binding: ${JSON.stringify(diagnostics)}`);
    }
    const unavailable = createUnavailablePluginServices();
    const services = { ...unavailable, exec: pluginExec };
    let current = true;
    let withdrawAfterAdmission = false;
    let online = true;
    const requests: string[] = [];
    const makeHost = () => createRunnerDaemonPluginServicesHost({ createInvocation: async () => ({
        services, ...(hasIsolation ? { agentIsolation: { read: () => ({ enabled: false,
            status: { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' }, workspaceRoots: [cwd] }) } } : {}),
        resourceDescriptors: {}, subscriptionCapabilities: { settingsWatch: false, eventSubscriptions: [], resourceWatches: [], notificationPreferencesWatch: false },
        authorizeOperation: () => {
            const admitted = current;
            if (withdrawAfterAdmission) {
                withdrawAfterAdmission = false;
                queueMicrotask(() => { current = false; });
            }
            return admitted;
        }, executeCurrentGlobalAction: unavailable.actions.execute,
        currentGlobalMcp: unavailable.mcp, currentGlobalExternalSessions: unavailable.sessions.external, dispose() {},
    }) });
    let host = makeHost();
    let authority: Awaited<ReturnType<typeof createSessionDaemonAuthorityFixture>> | undefined;
    let source: Awaited<ReturnType<typeof createRunnerAgentSessionRuntimeSource>> = null;
    let created: Awaited<ReturnType<NonNullable<import('@/agent/runtime/session/loop/runHostSessionRuntime').HostSessionRuntimeConfig['createSessionRuntime']>>> | undefined;
    try {
        authority = await createSessionDaemonAuthorityFixture({ sessionId: session.sessionId, retainedAgent: binding,
            runnerRuntimeRoot: await realpath(join(import.meta.dirname, '../../../..')),
            execute: async () => { throw new Error('Checkpoint capture does not execute an Action'); },
            dispatchService: async request => {
                requests.push(request.operation.kind);
                if (request.operation.kind === 'voice.authority.snapshot') return { ok: true, result: {
                    kind: 'voice.authority.snapshot', agentSourceCustody: binding.sourceCustody, providers: [],
                } };
                if (request.operation.kind === 'session.open.attest') return { ok: true, result: {
                    kind: 'session.open.attestation', status: request.operation.phase === 'prepare' ? 'accepted' : 'recorded',
                } };
                if (!online) return { ok: false, error: { code: 'unsupported_operation', message: 'SCM operation is unavailable' } };
                if (!authority) throw new Error('Missing Session authority');
                try {
                    return { ok: true, result: await host.dispatch({ sessionId: session.sessionId, runner: authority.runner,
                        retainedAgent: binding, operation: RunnerDaemonPluginServiceOperationV1Schema.parse(request.operation) }) };
                } catch (error) { return { ok: false, error: projectRunnerDaemonPluginServicesFailure(error) }; }
            },
        });
        const authorityFilePath = authority.trackedSession.agentRuntimeDaemonServiceAuthorityFilePath;
        source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: configuration.happyHomeDir,
            publicReleaseRing: configuration.publicReleaseRing, authorityFilePath, expectedSessionId: session.sessionId,
            occurrenceId: registration.occurrenceId });
        if (!source) throw new Error('Missing real runner source');
        const registry = await resolveCliEngineRegistry({ happyHomeDir: configuration.happyHomeDir, backendId: agentId,
            runnerAgentSessionRuntimeSource: source, requireRunnerAgentSessionRuntimeSource: true });
        const resolution = await registry.resolveForBackendId(agentId);
        const plan = await resolution?.engineAdapter.runtimeCore.createSessionRuntime({
            credentials: { token: 'test-token', encryption: null }, directory: cwd, backendTarget: { kind: 'backend', backendId: agentId },
        });
        if (!isHostSessionRuntimePlan(plan) || !plan.config.createSessionRuntime) throw new Error('Missing native Session plan');
        const presentation = createCurrentSessionPresentationHost({ session, signal: new AbortController().signal });
        // The Session network port is a fixture; engine/source/native/channel/Exec/Git owners above and below it are real.
        created = await plan.config.createSessionRuntime({ directory: cwd, metadata: {}, machineId: 'machine', session,
            currentSessionPresentation: presentation.bindCurrentSession, transcriptSession: {}, messageBuffer: {}, mcpServers: {},
            permissionHandler: { cancelByPluginTurn: async () => undefined }, getPermissionMode: () => 'default',
            setThinking() {}, memoryRecallGuidanceEnabled: false,
        } as never);
        const resolved = resolveHostSessionRuntimeFactoryResult(created);
        const hooks = (resolved.nativeRuntime ?? resolved.runtime) as HostSessionRuntimeHookRuntime;
        if (!hooks.runScmCommand) throw new Error('Native SCM binding is absent');
        return { runner: hooks.runScmCommand,
            requests,
            async replaceDaemon() { await host.dispose(); host = makeHost(); },
            withdrawOnNextAdmission() { withdrawAfterAdmission = true; },
            withdrawAuthority() { current = false; }, unsupportedDaemon() { online = false; },
            async dispose() { await created?.operations.resetOrDisposeRuntime(); await source?.retire?.(); await host.dispose(); await authority?.close(); await fixture.dispose(); },
        };
    } catch (error) {
        await source?.retire?.(); await host.dispose(); await authority?.close(); await fixture.dispose(); throw error;
    }
}

describe('Session checkpoint execution and captured-turn reads', () => {
    it.each(['available', 'unavailable'] as const)('reads the real checkpoint producer output when Session execution is %s', async availability => {
        await withTempDir('happier-turn-scm-', async directory => {
            const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
            git('init', '-q');
            await writeFile(join(directory, 'tracked.txt'), 'committed\n');
            const binary = Buffer.from([0, 255, 128, 13, 10, 195, 169]);
            await writeFile(join(directory, 'tracked.bin'), binary);
            git('add', 'tracked.txt', 'tracked.bin');
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial');
            const cwd = git('rev-parse', '--show-toplevel');
            const sessionId = randomUUID();
            const messages: ACPMessageData[] = [];
            const session = createMutableApiSessionClientFixture({ overrides: { sessionId,
                async enqueueAgentMessageCommitted(_provider, body) {
                    messages.push(body);
                    return { persisted: true, delivered: false };
                },
            } });
            const reader = createHostScmCommandRunner({
                agentIsolation: { read: () => ({ enabled: false, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [] }) },
                isCurrent: () => true,
            });
            // A plugin's executable declarations do not include host-owned Git.
            // Use the real resolver that denies the loaded Codex plugin's Git request.
            const pluginExec = createStablePluginExecService({ signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                systemTools: createPluginExecSystemToolResolver({ registerGrant() {} }),
                async resolveExecutable() { throw new Error('Undeclared tool must fail before launch'); },
                async resolvePath() { throw new Error('Undeclared tool must fail before path resolution'); },
            });
            const native = await openNativeSession(cwd, session, pluginExec, availability === 'available');
            const runner = native.runner;
            if (availability === 'unavailable') {
                expect(await runWithScmCommandRunner(createScmCommandRunnerFromExecService(pluginExec), () => runScmCommand({ bin: 'git', cwd, args: ['rev-parse', '--show-toplevel'] })))
                    .toMatchObject({ success: false, stderr: 'plugin_exec_system_tool_undeclared' });
            }
            const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: cwd,
                provider: 'codex', protocol: 'codex', sessionIsNew: true, scmCommandRunner: runner });
            const captures: Awaited<ReturnType<typeof captureScmComparison>>[] = [];
            try {
                for (const [turnId, before, after] of [['turn-1', null, 'added\n'], ['turn-2', 'added\n', 'modified\n']] as const) {
                    await lifecycle.onBeforePromptDispatch?.({ messageId: turnId, prompt: 'edit' });
                    await lifecycle.onTurnStarted?.({ messageId: turnId, turnId, sequence: 1 });
                    await writeFile(join(cwd, 'untracked.txt'), after);
                    await lifecycle.publishTurnChangeSet({ eventKind: 'turn-final', turnChangeSet: {
                        sessionId, turnId, seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 }, status: 'completed',
                        provider: 'codex', derivedAt: 1, files: [{ filePath: 'untracked.txt',
                            changeKind: before === null ? 'added' : 'modified', source: 'provider_tool', confidence: 'exact', provider: 'codex' }],
                    } });
                    const endpointReads: string[][] = [];
                    const readRunner: ScmCommandRunner = command => {
                        if (command.args[0] === 'rev-parse' && command.args.includes('--end-of-options')) endpointReads.push(command.args);
                        return reader(command);
                    };
                    const captured = await runWithScmCommandRunner(readRunner, () => captureScmComparison({ cwd, sessionId, source: { kind: 'turnCheckpoint', turnId },
                        readTranscriptPage: async () => ({ messages: messages.map((data, index) => ({ seq: index + 1, createdAt: index + 1,
                            content: { role: 'agent', content: { type: 'acp', provider: 'codex', data } } })), hasMore: false, nextAfterSeq: null }) }));
                    captures.push(captured);
                    if (availability === 'unavailable') {
                        expect(captured.comparison.endpoints).toEqual({});
                        expect(captured.comparison.inventory).toMatchObject({ state: 'unavailable', files: [] });
                        expect(captured.comparison.inventory.reasons.join('\n')).toContain('scm_exec_unavailable');
                        expect(endpointReads).toHaveLength(0);
                    } else {
                        expect(captured.comparison.inventory).toMatchObject({ state: 'complete', reasons: [], files: [{
                            path: 'untracked.txt', changeKind: before === null ? 'added' : 'modified', evidence: { state: 'available' },
                        }] });
                        const pinned = await runWithScmCommandRunner(runner, () => prepareCapturedScmComparisonInvestigation({ cwd, sessionId,
                            comparisonId: captured.comparison.id, directory: join(cwd, '.git', `investigation-${turnId}`) }));
                        expect(await readFile(join(pinned.afterDirectory, 'untracked.txt'), 'utf8')).toBe(after);
                        expect(await readFile(join(pinned.beforeDirectory, 'tracked.bin'))).toEqual(binary);
                        expect(await readFile(join(pinned.afterDirectory, 'tracked.bin'))).toEqual(binary);
                        if (before === null) await expect(readFile(join(pinned.beforeDirectory, 'untracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
                        else expect(await readFile(join(pinned.beforeDirectory, 'untracked.txt'), 'utf8')).toBe(before);
                        if (turnId === 'turn-1') await native.replaceDaemon();
                    }
                }
                expect(git('status', '--porcelain')).toBe('?? untracked.txt');
                if (availability === 'available') {
                    native.withdrawOnNextAdmission();
                    expect(await runner({ bin: 'git', cwd, args: ['update-ref', 'refs/happier/checkpoints/admission-race', 'HEAD'] }))
                        .toMatchObject({ success: false, stderr: 'scm_exec_unavailable', exitCode: -1 });
                    expect(git('for-each-ref', '--format=%(refname)', 'refs/happier/checkpoints/admission-race')).toBe('');
                }
                native.withdrawAuthority();
                expect(await runner({ bin: 'git', cwd, args: ['rev-parse', '--show-toplevel'] }))
                    .toMatchObject({ success: false, stderr: 'scm_exec_unavailable', exitCode: -1 });
                native.unsupportedDaemon();
                const beforeUnsupported = native.requests.length;
                expect(await runner({ bin: 'git', cwd, args: ['rev-parse', '--show-toplevel'] }))
                    .toMatchObject({ success: false, stderr: 'scm_exec_unavailable', exitCode: -1 });
                expect(native.requests.slice(beforeUnsupported)).toEqual(['host_scm.run_v1']);
            } finally {
                await lifecycle.onSessionEnd?.();
                await Promise.all(captures.map(captured => deleteCapturedScmComparison({ cwd, sessionId, comparisonId: captured.comparison.id })));
                await native.dispose();
            }
        });
    }, 180_000);
});
