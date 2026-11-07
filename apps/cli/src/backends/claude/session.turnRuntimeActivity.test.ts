import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { createSessionRuntimeActivity } from '@/session/runtimeActivity/createSessionRuntimeActivity';
import type { SessionRuntimeActivitySnapshotPublisher } from '@/session/runtimeActivity/types';

import type { EnhancedMode } from './loop';
import { hashClaudeEnhancedModeForQueue } from './remote/modeHash';
import { Session } from './session';

function createClient(overrides: Partial<SessionClientPort> = {}) {
    // Mirror production ordering: the canonical turn is opened by the task_started send and
    // closed by the task_complete/turn_aborted send — both AFTER the thinking-funnel publish.
    // A static mock hid the settlement race this suite exists to pin.
    let canonicalTurnActive = false;
    const sendAgentMessage = vi.fn((provider: string, message: { type: string }) => {
        if (message.type === 'task_started') canonicalTurnActive = true;
        if (message.type === 'task_complete' || message.type === 'turn_aborted') canonicalTurnActive = false;
    });
    return {
        sessionId: 'happier-session-turn-activity',
        keepAlive: vi.fn(),
        sendAgentMessage,
        registerSessionRuntimeControls: vi.fn(() => vi.fn()),
        hasActiveCanonicalTurn: vi.fn((): boolean => canonicalTurnActive),
        ...overrides,
    } as unknown as SessionClientPort;
}

function createPublisher(): SessionRuntimeActivitySnapshotPublisher & {
    publish: ReturnType<typeof vi.fn>;
} {
    return {
        publish: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
    };
}

async function createHarness(overrides: Partial<SessionClientPort> = {}) {
    const runtimeActivity = createSessionRuntimeActivity('supported');
    const publisher = createPublisher();
    await runtimeActivity.bindPublisher(publisher);
    // Mirror the provider-task adapter's prelaunch idle so turn transitions are
    // the only variable under observation.
    await runtimeActivity.agentRuntimeContributionHandle?.report(
        { state: 'idle', activeCount: 0 },
        'test prelaunch idle',
    );

    const client = createClient(overrides);
    const session = new Session({
        client,
        path: '/tmp',
        logPath: '/tmp/claude-turn-activity.log',
        sessionId: null,
        messageQueue: new MessageQueue2<EnhancedMode>(hashClaudeEnhancedModeForQueue),
        onModeChange: () => {},
        hookSettingsPath: '/tmp/claude-hooks.json',
        runtimeActivityContributions: {
            turnActivity: runtimeActivity.turnActivityContributionHandle,
        },
    });
    return { session, publisher, client };
}

describe('claude Session turn Runtime Activity', () => {
    it('publishes active while a turn is in flight and idle again at turn end', async () => {
        const { session, publisher } = await createHarness();
        expect(publisher.publish).toHaveBeenLastCalledWith({ state: 'idle', activeCount: 0 });

        session.onThinkingChange(true);
        await vi.waitFor(() => {
            expect(publisher.publish).toHaveBeenLastCalledWith({ state: 'active', activeCount: 1 });
        });

        session.onThinkingChange(false);
        await vi.waitFor(() => {
            expect(publisher.publish).toHaveBeenLastCalledWith({ state: 'idle', activeCount: 0 });
        });
    });

    it('publishes active when only the canonical turn is in flight (thinking false)', async () => {
        const { session, publisher } = await createHarness(
            { hasActiveCanonicalTurn: vi.fn((): boolean => true) },
        );

        // A redundant thinking write still re-reads combined turn truth.
        session.setThinkingWithoutTaskLifecycle(false);
        await vi.waitFor(() => {
            expect(publisher.publish).toHaveBeenLastCalledWith({ state: 'active', activeCount: 1 });
        });
    });

    it('publishes idle when an abort clears the in-flight turn', async () => {
        const { session, publisher } = await createHarness();
        session.onThinkingChange(true);
        await vi.waitFor(() => {
            expect(publisher.publish).toHaveBeenLastCalledWith({ state: 'active', activeCount: 1 });
        });

        session.abortCurrentTaskTurn();
        await vi.waitFor(() => {
            expect(publisher.publish).toHaveBeenLastCalledWith({ state: 'idle', activeCount: 0 });
        });
    });
});
