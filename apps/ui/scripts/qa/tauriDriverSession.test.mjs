import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveCandidateDriverSessionPorts,
    resolveExactDriverSessionTarget,
    resolvePreferredStackTauriIdentifier,
    resolveStackNameFromStackOwnedTauriIdentifier,
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

test('tauri driver-session selection derives the stack name from a stack-owned Tauri identifier', () => {
    assert.equal(
        resolveStackNameFromStackOwnedTauriIdentifier('com.happier.stack.activity-surfaces-qa'),
        'activity-surfaces-qa',
    );
    assert.equal(
        resolveStackNameFromStackOwnedTauriIdentifier('dev.happier.app.publicdev'),
        '',
    );
});

test('tauri targeted driver-session start reuses an already-connected stack-owned app without stopping other ports', async () => {
    const cliJsonCalls = [];
    const attempts = [];

    const result = await startTargetedDriverSession({
        candidatePorts: [9223, 9224],
        statusPollAttempts: 3,
        statusPollDelayMs: 0,
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
    assert.equal(result.resolvedAppIdentifier, 'com.happier.stack.activity-surfaces-qa');
    assert.deepEqual(attempts, [
        {
            ok: true,
            port: 9223,
            appIdentifier: 'com.happier.stack.activity-surfaces-qa',
            connectedIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
    ]);
    assert.deepEqual(cliJsonCalls, [
        ['driver-session', 'status', '--port', '9223'],
    ]);
});

test('tauri targeted driver-session start soft-prefers a stack-scoped app over a generic dev app when the stack name is known', async () => {
    const cliJsonCalls = [];
    const attempts = [];
    let status9224Calls = 0;

    const result = await startTargetedDriverSession({
        candidatePorts: [9223, 9224],
        statusPollAttempts: 3,
        statusPollDelayMs: 0,
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
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
                        ],
                    }),
                };
            }
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224') {
                status9224Calls += 1;
                if (status9224Calls <= 2) {
                    return {
                        text: JSON.stringify({
                            connected: true,
                            defaultPort: 9224,
                            apps: [
                                {
                                    port: 9224,
                                    identifier: 'dev.happier.app.publicdev',
                                    isDefault: true,
                                    name: 'Happier (dev)',
                                },
                            ],
                        }),
                    };
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
    assert.equal(result.resolvedAppIdentifier, 'com.happier.stack.activity-surfaces-qa');
    assert.deepEqual(attempts, [
        {
            ok: true,
            port: 9224,
            appIdentifier: 'com.happier.stack.activity-surfaces-qa',
            connectedIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
    ]);
    assert.equal(cliJsonCalls.filter((args) => args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9223').length, 3);
    assert.equal(cliJsonCalls.filter((args) => args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224').length >= 1, true);
});

test('tauri targeted driver-session start keeps scanning past a generic dev app when stack-owned app identifiers are required', async () => {
    const cliJsonCalls = [];
    const attempts = [];

    const result = await startTargetedDriverSession({
        candidatePorts: [9225, 9224],
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
        },
        requireStackOwnedIdentifier: true,
        runCliJson: async (args) => {
            cliJsonCalls.push(args);
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9225') {
                return {
                    text: JSON.stringify({
                        connected: true,
                        defaultPort: 9225,
                        apps: [
                            {
                                port: 9225,
                                identifier: 'dev.happier.app.publicdev',
                                isDefault: true,
                                name: 'Happier (dev)',
                            },
                        ],
                    }),
                };
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

    assert.equal(result.driverSessionPort, 9224);
    assert.equal(result.resolvedAppIdentifier, 'com.happier.stack.activity-surfaces-qa');
    assert.deepEqual(attempts, [{
        ok: true,
        port: 9224,
        appIdentifier: 'com.happier.stack.activity-surfaces-qa',
        connectedIdentifier: 'com.happier.stack.activity-surfaces-qa',
    }]);
    assert.equal(cliJsonCalls.some((args) => args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9225'), true);
    assert.equal(cliJsonCalls.some((args) => args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224'), true);
});

test('tauri targeted driver-session start escalates to a stack-scoped start when soft-preferred status probes only expose the generic app', async () => {
    const cliJsonCalls = [];
    const attempts = [];
    let status9224Calls = 0;

    const result = await startTargetedDriverSession({
        candidatePorts: [9223, 9224],
        statusPollAttempts: 3,
        statusPollDelayMs: 0,
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
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
                        ],
                    }),
                };
            }
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224') {
                status9224Calls += 1;
                if (status9224Calls <= 3) {
                    return {
                        text: JSON.stringify({
                            connected: true,
                            defaultPort: 9224,
                            apps: [
                                {
                                    port: 9224,
                                    identifier: 'dev.happier.app.publicdev',
                                    isDefault: true,
                                    name: 'Happier (dev)',
                                },
                            ],
                        }),
                    };
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
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9223') {
                return { text: 'Session started with app: Tauri App (localhost:9223) (localhost:9223) [DEFAULT]' };
            }
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224') {
                return { text: 'Session started with app: Tauri App (localhost:9224) (localhost:9224) [DEFAULT]' };
            }
            throw new Error(`Unexpected CLI JSON call: ${args.join(' ')}`);
        },
        appendAttempt: async (payload) => {
            attempts.push(payload);
        },
    });

    assert.equal(result.driverSessionPort, 9224);
    assert.equal(result.resolvedAppIdentifier, 'com.happier.stack.activity-surfaces-qa');
    assert.deepEqual(attempts, [
        {
            ok: true,
            port: 9224,
            appIdentifier: 'com.happier.stack.activity-surfaces-qa',
            connectedIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
    ]);
    assert.equal(cliJsonCalls.filter((args) => args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9223').length, 6);
    assert.equal(cliJsonCalls.filter((args) => args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224').length, 4);
    assert.equal(cliJsonCalls.some((args) => args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9223'), true);
    assert.equal(cliJsonCalls.some((args) => args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224'), true);
});

test('tauri targeted driver-session start skips the follow-up status poll when start reports that no Tauri app exists on the port', async () => {
    const cliJsonCalls = [];
    const attempts = [];
    let status9224Calls = 0;

    const result = await startTargetedDriverSession({
        candidatePorts: [9223, 9224],
        statusPollAttempts: 3,
        statusPollDelayMs: 0,
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        runCliJson: async (args) => {
            cliJsonCalls.push(args);
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9223') {
                return {
                    text: JSON.stringify({
                        connected: false,
                        app: null,
                        identifier: null,
                        host: null,
                        port: null,
                    }),
                };
            }
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224') {
                status9224Calls += 1;
                if (status9224Calls <= 3) {
                    return {
                        text: JSON.stringify({
                            connected: true,
                            defaultPort: 9224,
                            apps: [
                                {
                                    port: 9224,
                                    identifier: 'dev.happier.app.publicdev',
                                    isDefault: true,
                                    name: 'Happier (dev)',
                                },
                            ],
                        }),
                    };
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
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9223') {
                return {
                    text: 'Session start failed - no Tauri app found at localhost or localhost:9223',
                };
            }
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224') {
                return {
                    text: 'Session started with app: Happier (activity-surfaces-qa) (localhost:9224) [DEFAULT]',
                };
            }
            throw new Error(`Unexpected CLI JSON call: ${args.join(' ')}`);
        },
        appendAttempt: async (payload) => {
            attempts.push(payload);
        },
    });

    assert.equal(result.driverSessionPort, 9224);
    assert.equal(result.resolvedAppIdentifier, 'com.happier.stack.activity-surfaces-qa');
    assert.equal(attempts.at(-1)?.ok, true);
    assert.equal(cliJsonCalls.filter((args) => args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9223').length, 3);
    assert.equal(cliJsonCalls.filter((args) => args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224').length, 4);
    assert.equal(cliJsonCalls.some((args) => args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9223'), true);
    assert.equal(cliJsonCalls.some((args) => args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224'), true);
});

test('tauri targeted driver-session start reuses the connected app on the requested port before force-restarting when only the stack name is known', async () => {
    const cliJsonCalls = [];
    const attempts = [];

    const result = await startTargetedDriverSession({
        candidatePorts: [9223, 9224],
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
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
                                identifier: 'com.happier.stack.repo-dev-a1cc5e0671',
                                isDefault: true,
                                name: 'Happier (repo-dev-a1cc5e0671)',
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
    assert.equal(result.resolvedAppIdentifier, 'com.happier.stack.repo-dev-a1cc5e0671');
    assert.deepEqual(attempts, [
        {
            ok: true,
            port: 9223,
            appIdentifier: 'com.happier.stack.repo-dev-a1cc5e0671',
            connectedIdentifier: 'com.happier.stack.repo-dev-a1cc5e0671',
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
    assert.equal(result.resolvedAppIdentifier, 'com.happier.stack.activity-surfaces-qa');
    assert.equal(result.driverSessionStatusResponse.text.includes('activity-surfaces-qa'), true);
    assert.deepEqual(attempts, [
        {
            ok: false,
            port: 9225,
            reason: 'connected-different-app',
            connectedAppIdentifier: 'dev.happier.app.publicdev',
            connectedIdentifier: 'dev.happier.app.publicdev',
        },
        {
            ok: true,
            port: 9224,
            appIdentifier: 'com.happier.stack.activity-surfaces-qa',
            connectedIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
    ]);
    assert.deepEqual(cliJsonCalls, [
        ['driver-session', 'status', '--port', '9225'],
        ['driver-session', 'status', '--port', '9224'],
    ]);
});

test('tauri targeted driver-session start accepts the connected default app from the first status probe', async () => {
    const cliJsonCalls = [];
    const attempts = [];

    const result = await startTargetedDriverSession({
        candidatePorts: [9225, 9223, 9224],
        runCliJson: async (args) => {
            cliJsonCalls.push(args);
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9225') {
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

    assert.equal(result.driverSessionPort, 9225);
    assert.equal(result.resolvedAppIdentifier, 'com.happier.stack.activity-surfaces-qa');
    assert.deepEqual(attempts, [
        {
            ok: true,
            port: 9225,
            appIdentifier: 'com.happier.stack.activity-surfaces-qa',
            connectedIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
    ]);
    assert.deepEqual(cliJsonCalls, [
        ['driver-session', 'status', '--port', '9225'],
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
    assert.equal(result.resolvedAppIdentifier, 'com.happier.stack.activity-surfaces-qa');
    assert.equal(attempts.at(-1)?.ok, true);
    assert.deepEqual(cliJsonCalls, [
        ['driver-session', 'status', '--port', '9224'],
        ['driver-session', 'status', '--port', '9224'],
    ]);
});

test('tauri targeted driver-session start keeps polling after start when an explicit stack-owned app identifier is configured', async () => {
    const cliJsonCalls = [];
    const attempts = [];
    let status9224Calls = 0;

    const result = await startTargetedDriverSession({
        candidatePorts: [9224],
        statusPollAttempts: 3,
        statusPollDelayMs: 0,
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        runCliJson: async (args) => {
            cliJsonCalls.push(args);
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224') {
                status9224Calls += 1;
                if (status9224Calls <= 3) {
                    return {
                        text: JSON.stringify({
                            connected: true,
                            defaultPort: 9224,
                            apps: [
                                {
                                    port: 9224,
                                    identifier: 'dev.happier.app.publicdev',
                                    isDefault: true,
                                    name: 'Happier (dev)',
                                },
                            ],
                        }),
                    };
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
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224') {
                return { ok: true };
            }
            throw new Error(`Unexpected CLI JSON call: ${args.join(' ')}`);
        },
        appendAttempt: async (payload) => {
            attempts.push(payload);
        },
    });

    assert.equal(result.driverSessionPort, 9224);
    assert.equal(result.resolvedAppIdentifier, 'com.happier.stack.activity-surfaces-qa');
    assert.deepEqual(attempts, [
        {
            ok: false,
            port: 9224,
            reason: 'no-matching-app-identifier',
            connectedAppIdentifier: 'dev.happier.app.publicdev',
            connectedIdentifier: 'dev.happier.app.publicdev',
        },
        {
            ok: true,
            port: 9224,
            appIdentifier: 'com.happier.stack.activity-surfaces-qa',
            connectedIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
    ]);
    assert.equal(cliJsonCalls.filter((args) => args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224').length, 4);
    assert.equal(cliJsonCalls.some((args) => args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224'), true);
});

test('tauri targeted driver-session start keeps polling a soft-preferred stack target after start before falling back to generic status selection', async () => {
    const cliJsonCalls = [];
    const attempts = [];
    let status9224Calls = 0;

    const result = await startTargetedDriverSession({
        candidatePorts: [9224],
        statusPollAttempts: 3,
        statusPollDelayMs: 0,
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
        },
        runCliJson: async (args) => {
            cliJsonCalls.push(args);
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224') {
                status9224Calls += 1;
                if (status9224Calls <= 3) {
                    return {
                        text: JSON.stringify({
                            connected: true,
                            defaultPort: 9224,
                            apps: [
                                {
                                    port: 9224,
                                    identifier: 'dev.happier.app.publicdev',
                                    isDefault: true,
                                    name: 'Happier (dev)',
                                },
                            ],
                        }),
                    };
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
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224') {
                return { ok: true };
            }
            throw new Error(`Unexpected CLI JSON call: ${args.join(' ')}`);
        },
        appendAttempt: async (payload) => {
            attempts.push(payload);
        },
    });

    assert.equal(result.driverSessionPort, 9224);
    assert.equal(result.resolvedAppIdentifier, 'com.happier.stack.activity-surfaces-qa');
    assert.deepEqual(attempts, [
        {
            ok: true,
            port: 9224,
            appIdentifier: 'com.happier.stack.activity-surfaces-qa',
            connectedIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
    ]);
    assert.equal(cliJsonCalls.filter((args) => args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224').length, 4);
    assert.equal(cliJsonCalls.some((args) => args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224'), true);
});

test('tauri targeted driver-session start keeps polling the first soft-preferred candidate until the stack-owned app appears', async () => {
    const cliJsonCalls = [];
    const attempts = [];
    let status9224Calls = 0;

    const result = await startTargetedDriverSession({
        candidatePorts: [9224, 9223],
        statusPollAttempts: 3,
        statusPollDelayMs: 0,
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
        },
        runCliJson: async (args) => {
            cliJsonCalls.push(args);
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224') {
                status9224Calls += 1;
                if (status9224Calls < 3) {
                    return {
                        text: JSON.stringify({
                            connected: true,
                            defaultPort: 9224,
                            apps: [
                                {
                                    port: 9224,
                                    identifier: 'dev.happier.app.publicdev',
                                    isDefault: true,
                                    name: 'Happier (dev)',
                                },
                            ],
                        }),
                    };
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
            if (args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9223') {
                throw new Error('Unexpected scan of 9223 before 9224 became stack-owned');
            }
            if (args[0] === 'driver-session' && args[1] === 'start' && args[3] === '9224') {
                return { ok: true };
            }
            throw new Error(`Unexpected CLI JSON call: ${args.join(' ')}`);
        },
        appendAttempt: async (payload) => {
            attempts.push(payload);
        },
    });

    assert.equal(result.driverSessionPort, 9224);
    assert.equal(result.resolvedAppIdentifier, 'com.happier.stack.activity-surfaces-qa');
    assert.deepEqual(attempts, [
        {
            ok: true,
            port: 9224,
            appIdentifier: 'com.happier.stack.activity-surfaces-qa',
            connectedIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
    ]);
    assert.equal(cliJsonCalls.filter((args) => args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224').length, 3);
    assert.equal(cliJsonCalls.some((args) => args[0] === 'driver-session' && args[1] === 'start'), false);
});

test('tauri targeted driver-session start times out a stalled status probe and advances to the next candidate', async () => {
    const cliJsonCalls = [];
    const attempts = [];

    const resultPromise = startTargetedDriverSession({
        candidatePorts: [9225, 9224],
        attemptTimeoutMs: 1,
        statusPollAttempts: 1,
        statusPollDelayMs: 0,
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
    assert.equal(cliJsonCalls.some((args) => args[0] === 'driver-session' && args[1] === 'status' && args[3] === '9224'), true);
});
