import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveCandidateDriverSessionPorts,
    resolveExactDriverSessionTarget,
    resolvePreferredStackTauriIdentifier,
    startTargetedDriverSession,
} from './tauriDriverSessionSelection.mjs';

test('tauri driver-session selection rejects a stale single-app status for a different port', () => {
    const selection = resolveExactDriverSessionTarget(
        {
            connected: true,
            port: 9223,
            identifier: 'dev.happier.app.publicdev',
            app: 'Happier (dev)',
        },
        9224,
    );

    assert.equal(selection, null);
});

test('tauri driver-session selection prefers the exact requested app when multiple apps are connected', () => {
    const selection = resolveExactDriverSessionTarget(
        {
            connected: true,
            defaultPort: 9224,
            apps: [
                {
                    port: 9223,
                    identifier: 'dev.happier.app.publicdev',
                    isDefault: false,
                    name: 'Happier (dev)',
                },
                {
                    port: 9224,
                    identifier: 'com.happier.stack.activity-surfaces-qa',
                    isDefault: true,
                    name: 'Happier (activity-surfaces-qa)',
                },
            ],
        },
        9224,
    );

    assert.deepEqual(selection, {
        identifier: 'com.happier.stack.activity-surfaces-qa',
        port: 9224,
        host: null,
        isDefault: true,
        name: 'Happier (activity-surfaces-qa)',
    });
});

test('tauri driver-session selection prefers stack-owned default ports when no explicit port is configured', () => {
    const ports = resolveCandidateDriverSessionPorts({
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
    });

    assert.deepEqual(ports.slice(0, 5), [9223, 9224, 9225, 9226, 9227]);
});

test('tauri driver-session selection derives the stack-owned Tauri identifier from the stack name when needed', () => {
    assert.equal(typeof resolvePreferredStackTauriIdentifier, 'function');

    assert.equal(
        resolvePreferredStackTauriIdentifier({
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
        }),
        'com.happier.stack.activity-surfaces-qa',
    );

    assert.equal(
        resolvePreferredStackTauriIdentifier({
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.custom-override',
        }),
        'com.happier.stack.custom-override',
    );
});

test('tauri targeted driver-session start reuses an already-connected stack-owned app without stopping other ports', async () => {
    const cliJsonCalls = [];
    const attempts = [];

    const result = await startTargetedDriverSession({
        candidatePorts: [9223, 9224],
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        runCliJson: async (args) => {
            cliJsonCalls.push(args);
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9223') {
                return {
                    text: JSON.stringify({
                        connected: true,
                        defaultPort: 9223,
                        apps: [
                            {
                                port: 9223,
                                identifier: 'dev.happier.app.publicdev',
                                isDefault: true,
                                name: 'Happier (dev)',
                            },
                            {
                                port: 9224,
                                identifier: 'com.happier.stack.activity-surfaces-qa',
                                isDefault: false,
                                name: 'Happier (activity-surfaces-qa)',
                            },
                        ],
                    }),
                };
            }
            throw new Error(`Unexpected CLI JSON call: ${args.join(' ')}`);
        },
        appendAttempt: async (payload) => {
            attempts.push(payload);
        },
    });

    assert.equal(result.driverSessionPort, 9223);
    assert.equal(result.resolvedAppIdentifier, 9224);
    assert.deepEqual(attempts, [
        {
            ok: true,
            port: 9223,
            appIdentifier: 9224,
            connectedIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
    ]);
    assert.deepEqual(cliJsonCalls, [
        ['driver-session', 'status', '--port', '9223'],
    ]);
});

test('tauri targeted driver-session start reuses the current stack-owned session when only the stack name is known', async () => {
    const cliJsonCalls = [];
    const attempts = [];

    const result = await startTargetedDriverSession({
        candidatePorts: [9223, 9224],
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
        },
        runCliJson: async (args) => {
            cliJsonCalls.push(args);
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9223') {
                return { ok: true };
            }
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9223') {
                return {
                    text: JSON.stringify({
                        connected: true,
                        defaultPort: 9223,
                        apps: [
                            {
                                port: 9223,
                                identifier: 'com.happier.stack.repo-dev-a1cc5e0671',
                                isDefault: true,
                                name: 'Happier (repo-dev-a1cc5e0671)',
                            },
                            {
                                port: 9224,
                                identifier: 'com.happier.stack.activity-surfaces-qa',
                                isDefault: false,
                                name: 'Happier (activity-surfaces-qa)',
                            },
                        ],
                    }),
                };
            }
            if (args[0] === 'driver-session' && args[1] === 'stop' && args[3] === '9224') {
                return { ok: true };
            }
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224') {
                return { ok: true };
            }
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224') {
                return {
                    text: JSON.stringify({
                        connected: true,
                        defaultPort: 9224,
                        apps: [
                            {
                                port: 9223,
                                identifier: 'com.happier.stack.repo-dev-a1cc5e0671',
                                isDefault: false,
                                name: 'Happier (repo-dev-a1cc5e0671)',
                            },
                            {
                                port: 9224,
                                identifier: 'com.happier.stack.activity-surfaces-qa',
                                isDefault: true,
                                name: 'Happier (activity-surfaces-qa)',
                            },
                        ],
                    }),
                };
            }
            throw new Error(`Unexpected CLI JSON call: ${args.join(' ')}`);
        },
        appendAttempt: async (payload) => {
            attempts.push(payload);
        },
    });

    assert.equal(result.driverSessionPort, 9223);
    assert.equal(result.resolvedAppIdentifier, 9224);
    assert.deepEqual(attempts, [
        {
            ok: true,
            port: 9223,
            appIdentifier: 9224,
            connectedIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
    ]);
    assert.deepEqual(cliJsonCalls, [
        ['driver-session', 'status', '--port', '9223'],
    ]);
});

test('tauri targeted driver-session start skips stale apps and keeps scanning until the requested port is connected', async () => {
    const cliJsonCalls = [];
    const attempts = [];

    const result = await startTargetedDriverSession({
        candidatePorts: [9225, 9224],
        runCliJson: async (args) => {
            cliJsonCalls.push(args);
            if (args[0] === 'driver-session' && args[1] === 'stop') {
                return { ok: true };
            }
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9225') {
                return { ok: true };
            }
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9225') {
                return {
                    text: JSON.stringify({
                        connected: true,
                        port: 9223,
                        identifier: 'dev.happier.app.publicdev',
                        app: 'Happier (dev)',
                    }),
                };
            }
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224') {
                return { ok: true };
            }
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224') {
                return {
                    text: JSON.stringify({
                        connected: true,
                        defaultPort: 9224,
                        apps: [
                            {
                                port: 9223,
                                identifier: 'dev.happier.app.publicdev',
                                isDefault: false,
                                name: 'Happier (dev)',
                            },
                            {
                                port: 9224,
                                identifier: 'com.happier.stack.activity-surfaces-qa',
                                isDefault: true,
                                name: 'Happier (activity-surfaces-qa)',
                            },
                        ],
                    }),
                };
            }
            throw new Error(`Unexpected CLI JSON call: ${args.join(' ')}`);
        },
        appendAttempt: async (payload) => {
            attempts.push(payload);
        },
    });

    assert.equal(result.driverSessionPort, 9224);
    assert.equal(result.resolvedAppIdentifier, 9224);
    assert.equal(result.driverSessionStatusResponse.text.includes('activity-surfaces-qa'), true);
    assert.deepEqual(attempts, [
        {
            ok: false,
            port: 9225,
            reason: 'connected-different-app',
            connectedAppIdentifier: 9223,
            connectedIdentifier: 'dev.happier.app.publicdev',
        },
        {
            ok: true,
            port: 9224,
            appIdentifier: 9224,
            connectedIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
    ]);
    assert.deepEqual(cliJsonCalls, [
        ['driver-session', 'stop', '--port', '9225'],
        ['driver-session', 'start', '--port', '9225'],
        ['driver-session', 'status', '--port', '9225'],
        ['driver-session', 'stop', '--port', '9224'],
        ['driver-session', 'start', '--port', '9224'],
        ['driver-session', 'status', '--port', '9224'],
    ]);
});

test('tauri targeted driver-session start keeps polling the same port until the connected app appears', async () => {
    const cliJsonCalls = [];
    const attempts = [];

    const result = await startTargetedDriverSession({
        candidatePorts: [9224],
        statusPollAttempts: 3,
        statusPollDelayMs: 0,
        runCliJson: async (args) => {
            cliJsonCalls.push(args);
            if (args[0] === 'driver-session' && args[1] === 'stop') {
                return { ok: true };
            }
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224') {
                return { ok: true };
            }
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224') {
                if (cliJsonCalls.filter((entry) => entry[1] === 'status').length === 1) {
                    return { text: JSON.stringify({ connected: true, apps: [] }) };
                }
                return {
                    text: JSON.stringify({
                        connected: true,
                        defaultPort: 9224,
                        apps: [
                            {
                                port: 9224,
                                identifier: 'com.happier.stack.activity-surfaces-qa',
                                isDefault: true,
                                name: 'Happier (activity-surfaces-qa)',
                            },
                        ],
                    }),
                };
            }
            throw new Error(`Unexpected CLI JSON call: ${args.join(' ')}`);
        },
        appendAttempt: async (payload) => {
            attempts.push(payload);
        },
    });

    assert.equal(result.driverSessionPort, 9224);
    assert.equal(result.resolvedAppIdentifier, 9224);
    assert.equal(attempts.at(-1)?.ok, true);
    assert.deepEqual(cliJsonCalls, [
        ['driver-session', 'stop', '--port', '9224'],
        ['driver-session', 'start', '--port', '9224'],
        ['driver-session', 'status', '--port', '9224'],
        ['driver-session', 'status', '--port', '9224'],
    ]);
});

test('tauri targeted driver-session start times out a stalled status probe and advances to the next candidate', async () => {
    const cliJsonCalls = [];
    const attempts = [];

    const resultPromise = startTargetedDriverSession({
        candidatePorts: [9225, 9224],
        attemptTimeoutMs: 1,
        runCliJson: async (args, options) => {
            cliJsonCalls.push(args);
            if (args[0] === 'driver-session' && args[1] === 'stop') {
                return { ok: true };
            }
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9225') {
                return { ok: true };
            }
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9225') {
                if (options?.timeoutMs === 1) {
                    throw new Error('timed out');
                }
                return new Promise(() => {});
            }
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224') {
                return { ok: true };
            }
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224') {
                return {
                    text: JSON.stringify({
                        connected: true,
                        defaultPort: 9224,
                        apps: [
                            {
                                port: 9224,
                                identifier: 'com.happier.stack.activity-surfaces-qa',
                                isDefault: true,
                                name: 'Happier (activity-surfaces-qa)',
                            },
                        ],
                    }),
                };
            }
            throw new Error(`Unexpected CLI JSON call: ${args.join(' ')}`);
        },
        appendAttempt: async (payload) => {
            attempts.push(payload);
        },
    });

    const completed = await Promise.race([
        resultPromise.then(() => true, () => true),
        new Promise((resolve) => {
            setTimeout(() => resolve(false), 100);
        }),
    ]);

    assert.equal(completed, true);
    assert.equal(attempts.some((attempt) => attempt.ok === false && attempt.reason === 'timeout'), true);
    assert.equal(cliJsonCalls.some((args) => args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224'), true);
});
