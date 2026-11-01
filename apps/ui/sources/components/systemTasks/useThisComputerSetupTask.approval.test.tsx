import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createSetupAccountConsentPromptData,
    createSetupCliChoicePromptData,
    createSetupServiceConsentPromptData,
    SYSTEM_TASK_PROTOCOL_VERSION,
    type SystemTaskSpec,
} from '@happier-dev/protocol';

import { encodeBase64 } from '@/encryption/base64';
import { renderHook } from '@/dev/testkit';

const mocks = vi.hoisted(() => ({
    serverFetch: vi.fn(),
    getCredentialsForServerUrl: vi.fn(),
}));

// The two genuine boundaries beneath the exchange: the relay (network) and secure storage.
vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getCredentialsForServerUrl: mocks.getCredentialsForServerUrl,
        },
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import { createDeterministicSystemTaskBridge, type DeterministicScenarioStep } from './createDeterministicSystemTaskBridge';
import { createSystemTaskRunner } from './createSystemTaskRunner';
import { useThisComputerSetupTask, type SetupServiceConsentPrompt } from './useThisComputerSetupTask';

const RELAY_URL = 'https://relay.example.test';
const SERVER_ID = 'custom-2';
const ACCOUNT_ID = 'account-1';
const SENSITIVE_KEY_PATTERN = /secret|token|password|statefile/i;

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function buildSetupSpec(): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'setup.thisComputer.v1',
        params: {
            activeRelayUrl: RELAY_URL,
            activeWebappUrl: RELAY_URL,
            activeLocalRelayUrl: null,
            channel: 'stable',
            expectedAccountId: ACCOUNT_ID,
            surface: 'desktop.ui',
        },
    };
}

async function advance(ms: number): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

function collectKeys(value: unknown, into: string[] = []): string[] {
    if (Array.isArray(value)) {
        for (const entry of value) collectKeys(entry, into);
    } else if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            into.push(key);
            collectKeys(entry, into);
        }
    }
    return into;
}

beforeEach(() => {
    vi.useFakeTimers();
    mocks.serverFetch.mockReset();
    mocks.getCredentialsForServerUrl.mockReset();
    mocks.getCredentialsForServerUrl.mockResolvedValue({
        token: `header.${Buffer.from(JSON.stringify({ sub: ACCOUNT_ID })).toString('base64')}.signature`,
        encryption: {
            publicKey: encodeBase64(new Uint8Array(32).fill(1)),
            machineKey: encodeBase64(new Uint8Array(32).fill(9)),
        },
    });
    mocks.serverFetch.mockImplementation(async (path: string) => {
        if (String(path).endsWith('/v1/account/encryption')) {
            return jsonResponse({ mode: 'plain', updatedAt: 1 });
        }
        if (String(path).includes('/v1/auth/request/status')) {
            return jsonResponse({ status: 'pending', supportsV2: true });
        }
        return jsonResponse({ ok: true });
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('useThisComputerSetupTask automatic approval (R4 / INV2, end to end)', () => {
    it('retains the scoped run and answers the next prompt after navigation, then adopts it on reopen', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const respond = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const options = {
            runner,
            authRequestApproval: { expectedRelayUrl: RELAY_URL, expectedAccountId: ACCOUNT_ID, serverId: SERVER_ID },
        };
        const initiating = await renderHook(() => useThisComputerSetupTask(options));
        let taskId: string;
        await act(async () => { taskId = await initiating.getCurrent().launch(buildSetupSpec()); });
        await initiating.unmount();
        await advance(2_000);

        expect(respond).toHaveBeenCalledWith(taskId!, { approved: true });
        expect(runner.getSnapshot(taskId!)?.status).toBe('succeeded');
        const reopened = await renderHook(() => useThisComputerSetupTask(options));
        expect(reopened.getCurrent().activeTaskId).toBe(taskId!);
        expect(reopened.getCurrent().activeTaskSnapshot?.status).toBe('succeeded');
        expect(respond).toHaveBeenCalledTimes(1);
    });

    it('retains a delayed launch after the initiating surface unmounts', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        let finishStart!: () => void;
        const started = new Promise<void>((resolve) => { finishStart = resolve; });
        const runner = createSystemTaskRunner({ bridge: { ...bridge, start: async (spec) => {
            await started;
            return bridge.start(spec);
        } }, mode: 'dev' });
        const options = {
            runner,
            authRequestApproval: { expectedRelayUrl: RELAY_URL, expectedAccountId: ACCOUNT_ID, serverId: SERVER_ID },
        };
        const initiating = await renderHook(() => useThisComputerSetupTask(options));
        let launch!: Promise<string>;
        await act(async () => { launch = initiating.getCurrent().launch(buildSetupSpec()); });
        await initiating.unmount();
        await act(async () => { finishStart(); await launch; });
        await advance(2_000);
        const reopened = await renderHook(() => useThisComputerSetupTask(options));
        expect(reopened.getCurrent().activeTaskId).toBe(await launch);
        expect(reopened.getCurrent().activeTaskSnapshot?.status).toBe('succeeded');
    });

    it('completes an unauthenticated-CLI setup with no user interaction when the app is authenticated', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const respondSpy = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });

        const hook = await renderHook(() => useThisComputerSetupTask({
            runner,
            authRequestApproval: {
                expectedRelayUrl: RELAY_URL,
                expectedAccountId: ACCOUNT_ID,
                serverId: SERVER_ID,
            },
        }));

        await act(async () => {
            await hook.getCurrent().launch(buildSetupSpec());
        });

        // Let the whole simulated exchange run: prompt → approval → resume → result.
        await advance(2_000);

        const snapshot = hook.getCurrent().activeTaskSnapshot;
        expect(snapshot?.status).toBe('succeeded');
        expect(snapshot?.awaitingInput).toBe(false);
        // A task result's `machineId` is not readiness and is not read anywhere (INV8): the proof
        // is `verifyCurrentTarget`'s alone.
        expect(snapshot?.result?.ok).toBe(true);

        // The task was answered exactly once, with a boolean and nothing else.
        expect(respondSpy).toHaveBeenCalledTimes(1);
        expect(respondSpy.mock.calls[0]?.[1]).toEqual({ approved: true });

        // The relay received the sealed response, addressed at the app's relay.
        const posted = mocks.serverFetch.mock.calls.find((call) => String(call[0]).endsWith('/v1/auth/response'));
        expect(String(posted?.[0])).toBe(`${RELAY_URL}/v1/auth/response`);

        // The prompt this exchange consumed was raised by the setup task itself.
        const prompts = snapshot?.events.filter((event) => event.type === 'prompt') ?? [];
        expect(prompts).toHaveLength(1);
    });

    it('never places secret, token, password or state-file material in the emitted events', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const hook = await renderHook(() => useThisComputerSetupTask({
            runner,
            authRequestApproval: { expectedRelayUrl: RELAY_URL, expectedAccountId: ACCOUNT_ID, serverId: SERVER_ID },
        }));

        await act(async () => {
            await hook.getCurrent().launch(buildSetupSpec());
        });
        await advance(2_000);

        const events = hook.getCurrent().activeTaskSnapshot?.events ?? [];
        expect(events.length).toBeGreaterThan(0);
        const keys = collectKeys(events);
        for (const key of keys) {
            expect(key).not.toMatch(SENSITIVE_KEY_PATTERN);
        }
    });

    it('declines the prompt instead of hanging when the caller wired no approval', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const respondSpy = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const hook = await renderHook(() => useThisComputerSetupTask({ runner }));

        await act(async () => {
            await hook.getCurrent().launch(buildSetupSpec());
        });
        await advance(2_000);

        const snapshot = hook.getCurrent().activeTaskSnapshot;
        expect(respondSpy).toHaveBeenCalledTimes(1);
        expect(respondSpy.mock.calls[0]?.[1]).toEqual({ approved: false, reason: 'approval_unavailable' });
        expect(snapshot?.status).toBe('failed');
        expect(snapshot?.result?.ok === false ? snapshot.result.error.code : null).toBe('pairing_declined');
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('refuses a prompt raised for another account, and never reads that account\'s credentials', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const respondSpy = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const hook = await renderHook(() => useThisComputerSetupTask({
            runner,
            authRequestApproval: {
                expectedRelayUrl: RELAY_URL,
                expectedAccountId: 'account-other',
                serverId: SERVER_ID,
            },
        }));

        await act(async () => {
            await hook.getCurrent().launch(buildSetupSpec());
        });
        await advance(2_000);

        expect(respondSpy).toHaveBeenCalledTimes(1);
        expect(respondSpy.mock.calls[0]?.[1]).toEqual({ approved: false, reason: 'account_mismatch' });
        expect(hook.getCurrent().activeTaskSnapshot?.status).toBe('failed');
        expect(mocks.getCredentialsForServerUrl).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('refuses a prompt whose relay is not the one the app sent, and the task fails by name', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const hook = await renderHook(() => useThisComputerSetupTask({
            runner,
            authRequestApproval: {
                expectedRelayUrl: 'https://other.example.test',
                expectedAccountId: ACCOUNT_ID,
                serverId: SERVER_ID,
            },
        }));

        await act(async () => {
            await hook.getCurrent().launch(buildSetupSpec());
        });
        await advance(2_000);

        const snapshot = hook.getCurrent().activeTaskSnapshot;
        expect(snapshot?.status).toBe('failed');
        expect(mocks.getCredentialsForServerUrl).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });
});

describe('useThisComputerSetupTask service consent (UD5 / C6)', () => {
    function createConsentBridge() {
        return createDeterministicSystemTaskBridge({
            buildScenario: (_spec, taskId): DeterministicScenarioStep[] => [
                {
                    delayMs: 10,
                    type: 'prompt',
                    payload: {
                        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                        taskId,
                        tsMs: 10,
                        type: 'prompt',
                        stepId: 'setup.thisComputer.serviceConsent',
                        message: 'Allow Happier to take over the existing background service on this computer?',
                        // The shared wire contract the executor builds through, so this fixture
                        // cannot drift from the live prompt.
                        data: createSetupServiceConsentPromptData({
                            takeover: 'Taking over happier-daemon.',
                            message: 'A pinned service already exists.',
                            competingServices: ['pinned'],
                            servicesToRemove: [],
                        }),
                    },
                },
                {
                    delayMs: 40,
                    type: 'result',
                    payload: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: true, data: { machineId: 'machine-local-1' } },
                },
            ],
        });
    }

    it('asks the caller once and answers the task with the decision', async () => {
        const bridge = createConsentBridge();
        const respondSpy = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const seen: SetupServiceConsentPrompt[] = [];
        const hook = await renderHook(() => useThisComputerSetupTask({
            runner,
            onServiceConsentRequired: async (prompt) => {
                seen.push(prompt);
                return true;
            },
        }));

        await act(async () => {
            await hook.getCurrent().launch(buildSetupSpec());
        });
        await advance(500);

        expect(seen).toHaveLength(1);
        expect(seen[0]?.message).toBe('A pinned service already exists.');
        expect(seen[0]?.competingServices).toEqual(['pinned']);
        expect(respondSpy).toHaveBeenCalledTimes(1);
        expect(respondSpy.mock.calls[0]?.[1]).toEqual({ approved: true });
        expect(hook.getCurrent().activeTaskSnapshot?.status).toBe('succeeded');
    });

    it('declines by name instead of hanging when nobody can present the consent', async () => {
        const bridge = createConsentBridge();
        const respondSpy = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const hook = await renderHook(() => useThisComputerSetupTask({ runner }));

        await act(async () => {
            await hook.getCurrent().launch(buildSetupSpec());
        });
        await advance(500);

        expect(respondSpy).toHaveBeenCalledTimes(1);
        expect(respondSpy.mock.calls[0]?.[1]).toEqual({ approved: false, reason: 'consent_unavailable' });
        expect(hook.getCurrent().activeTaskSnapshot?.status).toBe('failed');
    });
});

describe('useThisComputerSetupTask account consent (D1)', () => {
    function createAccountConsentBridge() {
        return createDeterministicSystemTaskBridge({
            buildScenario: (_spec, taskId): DeterministicScenarioStep[] => [
                {
                    delayMs: 10,
                    type: 'prompt',
                    payload: {
                        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                        taskId,
                        tsMs: 10,
                        type: 'prompt',
                        stepId: 'setup.thisComputer.accountConsent',
                        message: 'Move this computer to the account you are signed in to in Happier?',
                        data: createSetupAccountConsentPromptData({
                            currentAccountId: 'acct_other',
                            currentAccountLabel: 'bob',
                            expectedAccountId: ACCOUNT_ID,
                            relayUrl: RELAY_URL,
                        }),
                    },
                },
                {
                    delayMs: 40,
                    type: 'result',
                    payload: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: true, data: { machineId: 'machine-local-1' } },
                },
            ],
        });
    }

    it('asks the one account question naming both accounts and the relay, and answers the task with it', async () => {
        const bridge = createAccountConsentBridge();
        const respondSpy = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const seen: unknown[] = [];
        const hook = await renderHook(() => useThisComputerSetupTask({
            runner,
            onAccountConsentRequired: async (request) => {
                seen.push(request);
                return false;
            },
        }));

        await act(async () => {
            await hook.getCurrent().launch(buildSetupSpec());
        });
        await advance(500);

        expect(seen).toEqual([expect.objectContaining({
            kind: 'account',
            fromAccountLabel: 'bob',
            relayHost: 'relay.example.test',
            fromRelayHost: null,
        })]);
        expect(respondSpy).toHaveBeenCalledTimes(1);
        expect(respondSpy.mock.calls[0]?.[1]).toEqual({ approved: false });
        expect(hook.getCurrent().activeTaskSnapshot?.status).toBe('failed');
    });
});

describe('useThisComputerSetupTask one-CLI question (R12)', () => {
    function createCliChoiceBridge() {
        return createDeterministicSystemTaskBridge({
            buildScenario: (_spec, taskId): DeterministicScenarioStep[] => [
                {
                    delayMs: 10,
                    type: 'prompt',
                    payload: {
                        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                        taskId,
                        tsMs: 10,
                        type: 'prompt',
                        stepId: 'setup.thisComputer.cliChoice',
                        message: 'Should Happier manage the command line on this computer?',
                        data: createSetupCliChoicePromptData({
                            command: '/usr/local/bin/happier',
                            version: '0.2.13',
                            origin: 'npm',
                            removalCommand: 'npm uninstall -g @happier-dev/cli',
                            updateCommand: 'npm install -g @happier-dev/cli@latest',
                            belowSetupFloor: false,
                            missing: false,
                            keepBlockedBy: null,
                        }),
                    },
                },
                {
                    delayMs: 40,
                    type: 'result',
                    payload: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: true, data: { machineId: 'machine-local-1' } },
                },
            ],
        });
    }

    it('asks once, naming the CLI it found, and answers the task with the choice', async () => {
        const bridge = createCliChoiceBridge();
        const respondSpy = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const seen: unknown[] = [];
        const hook = await renderHook(() => useThisComputerSetupTask({
            runner,
            onCliChoiceRequired: async (prompt) => {
                seen.push(prompt);
                return 'own';
            },
        }));

        await act(async () => {
            await hook.getCurrent().launch(buildSetupSpec());
        });
        await advance(500);

        expect(seen).toEqual([expect.objectContaining({ command: '/usr/local/bin/happier', version: '0.2.13', origin: 'npm' })]);
        expect(respondSpy).toHaveBeenCalledTimes(1);
        expect(respondSpy.mock.calls[0]?.[1]).toEqual({ choice: 'own' });
    });

    it('answers a dismissed question with no choice, so the run stops without writing anything', async () => {
        const bridge = createCliChoiceBridge();
        const respondSpy = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const hook = await renderHook(() => useThisComputerSetupTask({ runner, onCliChoiceRequired: async () => null }));

        await act(async () => {
            await hook.getCurrent().launch(buildSetupSpec());
        });
        await advance(500);

        expect(respondSpy.mock.calls[0]?.[1]).toEqual({ choice: null });
    });
});
