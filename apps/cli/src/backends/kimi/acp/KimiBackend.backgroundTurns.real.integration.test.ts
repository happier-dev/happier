import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createKimiBackend } from '@/backends/kimi/acp/backend';
import { createTestAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { FakePermissionSession } from '@/testkit/backends/permissionHandler';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createDeferred } from '@/testkit/async/deferred';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { AcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { Metadata, PermissionMode } from '@/api/types';
import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import {
    createKimiLoopbackModel,
    KIMI_FIXTURE_BACKGROUND,
    KIMI_FIXTURE_FOREGROUND,
    KIMI_FIXTURE_SECOND_FOREGROUND,
    type KimiLoopbackModelOptions,
} from './kimiLoopbackModel.testkit';

const executable = process.env.HAPPIER_TEST_KIMI_PATH?.trim();

type RuntimeFixture = Readonly<{
    model: Awaited<ReturnType<typeof createKimiLoopbackModel>>;
    runtime: AcpRuntime;
    permissionSession: FakePermissionSession;
    lifecycle: ReturnType<typeof createSessionTurnLifecycle>;
    mutations: SessionTurnMutationV1[];
    published: string[];
    thinking: boolean[];
    getMetadata(): Metadata & { sessionWorkStateV1?: unknown };
    isPlanPublicationPending(): boolean;
    releasePlanPublication(): void;
    loadReplay(): Promise<unknown[]>;
    setPermissionMode(mode: PermissionMode): void;
    startBackground(): Promise<void>;
    respondToTool(toolId: string, approved: boolean): Promise<string>;
    releaseBackground(): Promise<void>;
    waitForNativeTurn(turnId: number, reason: 'completed' | 'cancelled'): Promise<void>;
}>;

async function withKimiRuntime(
    options: KimiLoopbackModelOptions & { holdPlanPublication?: boolean },
    run: (fixture: RuntimeFixture) => Promise<void>,
): Promise<void> {
    await withTempDir('happier-kimi-background-', async (directory) => {
        const model = await createKimiLoopbackModel(directory, options);
        const permissionSession = new FakePermissionSession();
        const permissionHandler = new ProviderEnforcedPermissionHandler(permissionSession.asApiSessionClient(), {
            logPrefix: '[Kimi background fixture]',
        });
        let permissionMode: PermissionMode = 'default';
        const mutations: SessionTurnMutationV1[] = [];
        const published: string[] = [];
        const thinking: boolean[] = [];
        let metadata: Metadata & { sessionWorkStateV1?: unknown } = createTestMetadata({ flavor: 'kimi', path: model.workspace });
        let planPublicationPending = false;
        const planPublicationGate = createDeferred();
        if (!options.holdPlanPublication) planPublicationGate.resolve();
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 'kimi-background-fixture',
            enqueueSessionTurn: async (mutation) => { mutations.push(mutation); },
        });
        const createBackend = () => createKimiBackend({
            cwd: model.workspace,
            env: {
                HAPPIER_KIMI_PATH: executable!,
                KIMI_CODE_HOME: model.home,
                KIMI_DISABLE_TELEMETRY: '1',
            },
            unsetEnv: Object.keys(process.env).filter((key) => /^(KIMI_|OPENAI_|ANTHROPIC_)/.test(key)
                && key !== 'KIMI_CODE_HOME' && key !== 'KIMI_DISABLE_TELEMETRY'),
            permissionMode: 'default',
            getPermissionMode: () => permissionMode,
            permissionHandler,
            mcpServers: {},
        });
        const backend = createBackend();
        const runtime = createTestAcpRuntime({
            provider: 'kimi',
            directory: model.workspace,
            messageBuffer: new MessageBuffer(),
            mcpServers: {},
            permissionHandler,
            onThinkingChange: (value) => { thinking.push(value); },
            ensureBackend: async () => backend,
            session: createBasicSessionClientWithOverrides({
                sessionTurnLifecycle: lifecycle,
                updateMetadata: async (updater) => {
                    const next = updater(metadata) as typeof metadata;
                    if (next.sessionWorkStateV1 !== metadata.sessionWorkStateV1) {
                        planPublicationPending = true;
                        await planPublicationGate.promise;
                        published.push('plan-persisted');
                    }
                    metadata = next;
                },
                sendAgentMessage: (provider, body) => {
                    void lifecycle.observeAcpLifecycleMarker({ provider, body }).pendingWrite;
                    published.push(body.type);
                },
                sendAgentMessageCommitted: async (_provider, body) => {
                    published.push(body.type === 'message' ? body.message : body.type);
                },
            }),
        });
        let foregroundPrompt: Promise<void> | undefined;
        const pendingId = (toolId: string) => Object.keys(permissionSession.snapshot().requests ?? {})
            .find((id) => id.includes(toolId));
        const respondToTool = async (toolId: string, approved: boolean) => {
            await expect.poll(() => pendingId(toolId), { timeout: 10_000 }).toBeTruthy();
            const id = pendingId(toolId)!;
            await permissionSession.rpcHandlerManager.dispatchPermission({
                id, approved, decision: approved ? 'approved' : 'denied',
            });
            return id;
        };
        try {
            await runtime.startOrLoad({});
            await runtime.setSessionModel('fixture');
            await run({
                model, runtime, permissionSession, lifecycle, mutations, published, thinking,
                getMetadata: () => metadata,
                isPlanPublicationPending: () => planPublicationPending,
                releasePlanPublication: () => planPublicationGate.resolve(),
                respondToTool,
                async loadReplay() {
                    const sessionId = runtime.getSessionId();
                    if (!sessionId) throw new Error('Expected a native session identity');
                    await runtime.reset();
                    const resumed = createBackend();
                    try {
                        if (!resumed.loadSessionWithReplayCapture) throw new Error('Kimi does not expose native history replay');
                        const loaded = await resumed.loadSessionWithReplayCapture(sessionId);
                        expect(loaded.sessionId).toBe(sessionId);
                        return loaded.replay;
                    } finally {
                        await resumed.dispose();
                    }
                },
                setPermissionMode(mode) {
                    permissionMode = mode;
                    permissionHandler.setPermissionMode(mode);
                },
                async startBackground() {
                    runtime.beginTurn();
                    foregroundPrompt = runtime.sendPrompt('Run the isolated background fixture and report when it finishes.');
                    await respondToTool('call_background', true);
                    await foregroundPrompt;
                    await runtime.flushTurn();
                    expect(published).toContain(KIMI_FIXTURE_FOREGROUND);
                    expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete']);
                },
                async releaseBackground() {
                    await model.releaseBackground();
                    await expect.poll(() => model.getRequestCount(), { timeout: 15_000 })
                        .toBe(options.interveningForeground ? 4 : 3);
                    await model.continuationRequested;
                },
                async waitForNativeTurn(turnId, reason) {
                    // Native terminal evidence distinguishes dropped Happier output from a slow provider.
                    await expect.poll(async () => (await model.readNativeEvents()).some((event) =>
                        event.type === 'turn.ended' && event.turnId === turnId && event.reason === reason,
                    ), { timeout: 15_000 }).toBe(true);
                },
            });
        } finally {
            planPublicationGate.resolve();
            model.releaseContinuation();
            await model.releaseBackground();
            await runtime.reset();
            await foregroundPrompt?.catch(() => undefined);
            await model.close();
        }
    });
}

async function expectBackgroundCompletion(fixture: RuntimeFixture, nativeTurnId: number): Promise<void> {
    await fixture.waitForNativeTurn(nativeTurnId, 'completed');
    await expect.poll(() => fixture.published, { timeout: 10_000 }).toContain(KIMI_FIXTURE_BACKGROUND);
    await fixture.runtime.flushTurn();
    expect(fixture.published.indexOf(KIMI_FIXTURE_BACKGROUND)).toBeLessThan(fixture.published.lastIndexOf('task_complete'));
    expect(fixture.lifecycle.hasActiveTurn()).toBe(false);
}

async function expectBackgroundCancellation(fixture: RuntimeFixture, nativeTurnId: number): Promise<void> {
    await fixture.waitForNativeTurn(nativeTurnId, 'cancelled');
    await expect.poll(() => fixture.lifecycle.hasActiveTurn()).toBe(false);
    await fixture.runtime.flushTurn();
    expect(fixture.published).not.toContain(KIMI_FIXTURE_BACKGROUND);
    expect(await fixture.model.continuationExecuted()).toBe(false);
}

// Opt in with an official Kimi executable. All inference stays on loopback.
describe.skipIf(!executable || process.platform === 'win32')('Kimi background turns through Happier', () => {
    it('publishes a provider continuation after foreground settlement and commits output before completion', async () => {
        await withKimiRuntime({}, async (fixture) => {
            await fixture.startBackground();
            const afterForeground = fixture.thinking.length;
            await fixture.releaseBackground();
            fixture.model.releaseContinuation();
            await expectBackgroundCompletion(fixture, 1);
            expect(fixture.model.getRequestCount()).toBe(3);
            expect(fixture.mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete', 'begin', 'complete']);
            expect(fixture.mutations[0]?.turnId).not.toBe(fixture.mutations[2]?.turnId);
            expect(fixture.thinking.slice(afterForeground)).toContain(true);
            expect(fixture.thinking.at(-1)).toBe(false);
            const replay = await fixture.loadReplay();
            expect(replay).toContainEqual(expect.objectContaining({
                type: 'message', role: 'agent', text: KIMI_FIXTURE_FOREGROUND,
            }));
            expect(replay).toContainEqual(expect.objectContaining({
                type: 'message', role: 'agent', text: KIMI_FIXTURE_BACKGROUND,
            }));
            expect(replay).toContainEqual(expect.objectContaining({
                type: 'tool_call', title: 'Bash', rawInput: expect.objectContaining({ run_in_background: true }),
            }));
            expect(fixture.model.getRequestCount()).toBe(3);
        });
    }, 60_000);

    it('keeps a continuation distinct and retains its permission mode after a broader foreground turn', async () => {
        await withKimiRuntime({ interveningForeground: true, continuationTool: true }, async (fixture) => {
            await fixture.startBackground();
            fixture.setPermissionMode('yolo');
            fixture.runtime.beginTurn();
            await fixture.runtime.sendPrompt('Complete a second foreground turn while the original background task waits.');
            await fixture.runtime.flushTurn();
            expect(fixture.published).toContain(KIMI_FIXTURE_SECOND_FOREGROUND);
            await fixture.releaseBackground();
            fixture.model.releaseContinuation();
            await fixture.respondToTool('call_continuation', false);
            await expectBackgroundCancellation(fixture, 2);
            expect(await fixture.model.continuationExecuted()).toBe(false);
            expect(fixture.mutations.map((mutation) => mutation.action))
                .toEqual(['begin', 'complete', 'begin', 'complete', 'begin', 'cancel']);
            expect(new Set(fixture.mutations.map((mutation) => mutation.turnId)).size).toBe(3);
        });
    }, 60_000);

    it('persists a background plan before publishing its final output and terminal status', async () => {
        await withKimiRuntime({ continuationPlan: true, holdPlanPublication: true }, async (fixture) => {
            await fixture.startBackground();
            await fixture.releaseBackground();
            fixture.model.releaseContinuation();
            try {
                await expect.poll(() => fixture.isPlanPublicationPending(), { timeout: 10_000 }).toBe(true);
                await fixture.waitForNativeTurn(1, 'completed');
                expect(fixture.lifecycle.hasActiveTurn()).toBe(true);
                expect(fixture.published).not.toContain(KIMI_FIXTURE_BACKGROUND);
                fixture.releasePlanPublication();
                await expectBackgroundCompletion(fixture, 1);
                const work = z.object({
                    backendId: z.string(), items: z.array(z.object({ title: z.string(), status: z.string() })),
                }).parse(fixture.getMetadata().sessionWorkStateV1);
                expect(work.backendId).toBe('kimi');
                expect(work.items.map(item => [item.title, item.status])).toEqual([
                    ['FIXTURE_INVESTIGATE', 'complete'], ['FIXTURE_REPAIR', 'active'], ['FIXTURE_VERIFY', 'pending'],
                ]);
                expect(fixture.published.indexOf('plan-persisted')).toBeLessThan(fixture.published.lastIndexOf('task_complete'));
                expect(fixture.model.getRequestCount()).toBe(4);
            } finally { fixture.releasePlanPublication(); }
        });
    }, 60_000);

    it('routes a native subagent approval through the originating host turn', async () => {
        await withKimiRuntime({ subagent: true }, async (fixture) => {
            fixture.runtime.beginTurn();
            const prompt = fixture.runtime.sendPrompt('Run the isolated subagent fixture.').then(() => null, error => error as Error);
            try {
                await fixture.respondToTool('call_child_bash', false);
                expect(await prompt).toMatchObject({ name: 'AbortError' });
                await fixture.waitForNativeTurn(0, 'cancelled');
                await fixture.runtime.flushTurn();
                expect(await fixture.model.continuationExecuted()).toBe(false);
                expect(fixture.mutations.map((mutation) => mutation.action)).toEqual(['begin', 'cancel']);
            } finally {
                await fixture.runtime.cancel();
                await prompt.catch(() => undefined);
            }
        });
    }, 60_000);

    it('executes an approved continuation tool and publishes its final result', async () => {
        await withKimiRuntime({ continuationTool: true }, async (fixture) => {
            await fixture.startBackground();
            await fixture.releaseBackground();
            fixture.model.releaseContinuation();
            await fixture.respondToTool('call_continuation', true);
            await expectBackgroundCompletion(fixture, 1);
            expect(await fixture.model.continuationExecuted()).toBe(true);
            expect(Object.keys(fixture.permissionSession.snapshot().requests ?? {})).toEqual([]);
        });
    }, 60_000);

    it('presents and rejects a continuation approval without executing the tool', async () => {
        await withKimiRuntime({ continuationTool: true }, async (fixture) => {
            await fixture.startBackground();
            await fixture.releaseBackground();
            fixture.model.releaseContinuation();
            await fixture.respondToTool('call_continuation', false);
            await expectBackgroundCancellation(fixture, 1);
            expect(await fixture.model.continuationExecuted()).toBe(false);
            expect(Object.keys(fixture.permissionSession.snapshot().requests ?? {})).toEqual([]);
        });
    }, 60_000);

    it('cancels a continuation while its model request is still pending', async () => {
        await withKimiRuntime({}, async (fixture) => {
            await fixture.startBackground();
            await fixture.releaseBackground();
            await expect.poll(() => fixture.lifecycle.hasActiveTurn()).toBe(true);
            await fixture.runtime.cancel();
            fixture.model.releaseContinuation();
            await fixture.waitForNativeTurn(1, 'cancelled');
            await fixture.runtime.flushTurn();
            expect(fixture.published).not.toContain(KIMI_FIXTURE_BACKGROUND);
            expect(fixture.mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete', 'begin', 'cancel']);
            expect(fixture.lifecycle.hasActiveTurn()).toBe(false);
        });
    }, 60_000);

    it('cancels a pending continuation approval without executing its command', async () => {
        await withKimiRuntime({ continuationTool: true }, async (fixture) => {
            await fixture.startBackground();
            await fixture.releaseBackground();
            fixture.model.releaseContinuation();
            await expect.poll(() => Object.keys(fixture.permissionSession.snapshot().requests ?? {})
                .some((id) => id.includes('call_continuation')), { timeout: 10_000 }).toBe(true);
            await fixture.runtime.cancel();
            await fixture.waitForNativeTurn(1, 'cancelled');
            await fixture.runtime.flushTurn();
            expect(await fixture.model.continuationExecuted()).toBe(false);
            expect(fixture.published).not.toContain(KIMI_FIXTURE_BACKGROUND);
            expect(Object.keys(fixture.permissionSession.snapshot().requests ?? {})).toEqual([]);
            expect(fixture.lifecycle.hasActiveTurn()).toBe(false);
        });
    }, 60_000);
});
