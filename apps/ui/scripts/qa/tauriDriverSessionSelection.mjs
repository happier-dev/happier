import { setTimeout as delay } from 'node:timers/promises';

function normalizePositiveInteger(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function readString(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

export function resolvePreferredStackTauriIdentifier(env = process.env) {
    const explicitIdentifier = readString(env?.HAPPIER_STACK_TAURI_IDENTIFIER);
    if (explicitIdentifier) {
        return explicitIdentifier;
    }

    const stackName = readString(env?.HAPPIER_STACK_STACK);
    if (!stackName) {
        return '';
    }

    return `com.happier.stack.${stackName}`;
}

export function hasStackOwnedTauriRuntime(env = process.env) {
    if (resolvePreferredStackTauriIdentifier(env)) {
        return true;
    }

    const identifier = readString(env?.HAPPIER_STACK_TAURI_IDENTIFIER);
    return identifier.startsWith('com.happier.stack.');
}

export function resolveDefaultDriverSessionPort({ env = process.env } = {}) {
    const explicit = normalizePositiveInteger(
        env.HAPPIER_TAURI_MCP_APP_IDENTIFIER
            ?? env.HAPPIER_TAURI_MCP_PORT
            ?? env.HAPPIER_TAURI_APP_PORT,
    );
    if (explicit != null) {
        return explicit;
    }

    return hasStackOwnedTauriRuntime(env) ? 9223 : 9225;
}

function pushUniqueTarget(targets, seenPorts, candidate) {
    const port = normalizePositiveInteger(candidate?.port);
    if (port == null || seenPorts.has(port)) {
        return;
    }

    seenPorts.add(port);
    targets.push({
        ...candidate,
        port,
    });
}

export function resolvePreferredDriverSessionTarget(status, {
    preferredPort = null,
    preferredAppIdentifier = null,
} = {}) {
    const targets = [];
    const seenPorts = new Set();

    if (status && typeof status === 'object') {
        pushUniqueTarget(targets, seenPorts, {
            port: status.port,
            identifier: status.identifier ?? null,
            host: status.host ?? null,
            name: status.app ?? null,
            isDefault: status.port != null && status.defaultPort != null
                ? normalizePositiveInteger(status.port) === normalizePositiveInteger(status.defaultPort)
                : false,
        });

        const apps = Array.isArray(status.apps) ? status.apps : [];
        for (const app of apps) {
            pushUniqueTarget(targets, seenPorts, {
                port: app?.port,
                identifier: app?.identifier ?? null,
                host: app?.host ?? null,
                name: app?.name ?? null,
                isDefault: app?.isDefault === true,
            });
        }

        pushUniqueTarget(targets, seenPorts, {
            port: status.defaultPort,
            identifier: status.defaultIdentifier ?? null,
            host: status.host ?? null,
            name: status.defaultApp ?? null,
            isDefault: true,
        });
    }

    const requestedIdentifier = readString(preferredAppIdentifier);
    if (requestedIdentifier) {
        return targets.find((target) => target.identifier === requestedIdentifier) ?? null;
    }

    const requestedPort = normalizePositiveInteger(preferredPort);
    if (requestedPort != null) {
        return targets.find((target) => target.port === requestedPort) ?? null;
    }

    if (targets.length === 0) {
        return null;
    }

    const defaultTarget = targets.find((target) => target.isDefault === true);
    return defaultTarget ?? targets[0];
}

function isTimeoutError(error) {
    if (!error) {
        return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    return String(error.code ?? '').toUpperCase() === 'ETIMEDOUT'
        || /timed out|timeout/i.test(message);
}

async function pollDriverSessionStatus(candidatePort, {
    runCliJson,
    attemptTimeoutMs,
    statusPollAttempts = 1,
    statusPollDelayMs = 0,
    preferredAppIdentifier = null,
    env = process.env,
}) {
    const totalPollAttempts = Math.max(1, Math.floor(statusPollAttempts));
    const pollDelayMs = Math.max(0, Math.floor(statusPollDelayMs));
    let lastStatusResponse = null;
    let lastParsedStatus = null;
    let lastConnectedAppIdentifier = null;
    let lastConnectedTarget = null;
    let lastError = null;

    for (let attempt = 0; attempt < totalPollAttempts; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const statusResponse = await runCliJson(
                ['driver-session', 'status', '--port', String(candidatePort)],
                { timeoutMs: attemptTimeoutMs, env },
            );
            lastStatusResponse = statusResponse;
            lastParsedStatus = tryParseDriverSessionStatus(statusResponse);
            const matchedTarget = resolvePreferredDriverSessionTarget(lastParsedStatus, {
                preferredPort: candidatePort,
                preferredAppIdentifier,
            });
            if (matchedTarget) {
                return {
                    matchedTarget,
                    parsedStatus: lastParsedStatus,
                    statusResponse,
                    connectedAppIdentifier: matchedTarget.port,
                    connectedTarget: matchedTarget,
                    lastError: null,
                };
            }

            lastConnectedAppIdentifier = resolveConnectedAppIdentifierFromDriverStatus(lastParsedStatus);
            lastConnectedTarget = resolveExactDriverSessionTarget(lastParsedStatus, lastConnectedAppIdentifier);
            if (lastConnectedAppIdentifier != null && lastConnectedAppIdentifier !== candidatePort) {
                return {
                    matchedTarget: null,
                    parsedStatus: lastParsedStatus,
                    statusResponse,
                    connectedAppIdentifier: lastConnectedAppIdentifier,
                    connectedTarget: lastConnectedTarget,
                    lastError: null,
                };
            }
        } catch (error) {
            lastError = error;
            break;
        }

        if (attempt < totalPollAttempts - 1 && pollDelayMs > 0) {
            // eslint-disable-next-line no-await-in-loop
            await delay(pollDelayMs);
        }
    }

    return {
        matchedTarget: null,
        parsedStatus: lastParsedStatus,
        statusResponse: lastStatusResponse,
        connectedAppIdentifier: lastConnectedAppIdentifier,
        connectedTarget: lastConnectedTarget,
        lastError,
    };
}

export function resolveCandidateDriverSessionPorts({ preferredPort, env = process.env } = {}) {
    const ports = [];
    const seen = new Set();

    function push(value) {
        const port = normalizePositiveInteger(value);
        if (port == null || seen.has(port)) return;
        seen.add(port);
        ports.push(port);
    }

    const preferred = normalizePositiveInteger(preferredPort ?? resolveDefaultDriverSessionPort({ env }));
    if (preferred) {
        push(preferred);
        push(9223);
        if (preferred > 9223) {
            push(preferred - 1);
        }
        if (preferred < 9227) {
            push(preferred + 1);
        }
        if (preferred < 9226) {
            push(preferred + 2);
        }
    }

    // Include known defaults used in our repo scripts and the upstream CLI default.
    push(9225);
    push(9226);
    push(9227);
    push(9223);

    return ports;
}

export function tryParseDriverSessionStatus(response) {
    const raw = readString(response?.text, '');
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

export function resolveExactDriverSessionTarget(status, preferredPort = null) {
    const targets = [];
    const seenPorts = new Set();

    if (status && typeof status === 'object') {
        pushUniqueTarget(targets, seenPorts, {
            port: status.port,
            identifier: status.identifier ?? null,
            host: status.host ?? null,
            name: status.app ?? null,
            isDefault: status.port != null && status.defaultPort != null
                ? normalizePositiveInteger(status.port) === normalizePositiveInteger(status.defaultPort)
                : false,
        });

        const apps = Array.isArray(status.apps) ? status.apps : [];
        for (const app of apps) {
            pushUniqueTarget(targets, seenPorts, {
                port: app?.port,
                identifier: app?.identifier ?? null,
                host: app?.host ?? null,
                name: app?.name ?? null,
                isDefault: app?.isDefault === true,
            });
        }

        pushUniqueTarget(targets, seenPorts, {
            port: status.defaultPort,
            identifier: status.defaultIdentifier ?? null,
            host: status.host ?? null,
            name: status.defaultApp ?? null,
            isDefault: true,
        });
    }

    const requestedPort = normalizePositiveInteger(preferredPort);
    if (requestedPort != null) {
        return targets.find((target) => target.port === requestedPort) ?? null;
    }

    if (targets.length === 0) {
        return null;
    }

    const defaultTarget = targets.find((target) => target.isDefault === true);
    return defaultTarget ?? targets[0];
}

export function resolveConnectedAppIdentifierFromDriverStatus(status) {
    return resolveExactDriverSessionTarget(status)?.port ?? null;
}

export function resolvePreferredAppIdentifierFromDriverStatus(status, preferredPort = null) {
    const requestedPort = normalizePositiveInteger(preferredPort);
    if (requestedPort == null) {
        return resolveConnectedAppIdentifierFromDriverStatus(status);
    }

    return resolveExactDriverSessionTarget(status, requestedPort)?.port ?? null;
}

export function doesDriverSessionStatusMatchRequestedPort(status, preferredPort = null) {
    const requestedPort = normalizePositiveInteger(preferredPort);
    if (requestedPort == null) {
        return false;
    }

    return resolveExactDriverSessionTarget(status, requestedPort) != null;
}

export async function startTargetedDriverSession({
    candidatePorts,
    runCliJson,
    appendAttempt,
    attemptTimeoutMs = 8_000,
    statusPollAttempts = 12,
    statusPollDelayMs = 250,
    env = process.env,
}) {
    const explicitPreferredAppIdentifier = readString(env?.HAPPIER_STACK_TAURI_IDENTIFIER);
    const preferredAppIdentifier = resolvePreferredStackTauriIdentifier(env) || null;
    // Resolve stack-owned sessions from the live status first so we do not
    // reattach to a stale repo-dev session on the same driver port.
    const shouldPreferStartFirst = false;
    let usedDriverSessionPort = null;
    let driverSessionResponse = null;
    let driverSessionStatusResponse = null;
    let resolvedAppTarget = null;

    if (preferredAppIdentifier) {
        for (const candidatePort of candidatePorts) {
            if (shouldPreferStartFirst) {
                // eslint-disable-next-line no-await-in-loop
                const started = await runCliJson(
                    ['driver-session', 'start', '--port', String(candidatePort)],
                    { timeoutMs: attemptTimeoutMs },
                ).catch((error) => ({ error }));
                if (started && 'error' in started) {
                    // eslint-disable-next-line no-await-in-loop
                    await appendAttempt({
                        ok: false,
                        port: candidatePort,
                        reason: isTimeoutError(started.error) ? 'timeout' : 'error',
                        message: started.error instanceof Error ? started.error.message : String(started.error),
                    });
                    continue;
                }

                // eslint-disable-next-line no-await-in-loop
                const statusResult = await pollDriverSessionStatus(candidatePort, {
                    runCliJson,
                    attemptTimeoutMs,
                    statusPollAttempts,
                    statusPollDelayMs,
                    preferredAppIdentifier,
                });
                const { parsedStatus, statusResponse, matchedTarget, connectedAppIdentifier, connectedTarget, lastError } = statusResult;

                if (matchedTarget) {
                    usedDriverSessionPort = candidatePort;
                    driverSessionResponse = started;
                    driverSessionStatusResponse = statusResponse;
                    resolvedAppTarget = matchedTarget;
                    // eslint-disable-next-line no-await-in-loop
                    await appendAttempt({
                        ok: true,
                        port: candidatePort,
                        appIdentifier: matchedTarget.port,
                        connectedIdentifier: matchedTarget.identifier ?? null,
                    });
                    return {
                        driverSessionPort: usedDriverSessionPort,
                        driverSessionResponse,
                        driverSessionStatusResponse,
                        resolvedAppIdentifier: resolvedAppTarget.port,
                        resolvedAppTarget,
                    };
                }

                const staleAppIdentifier = connectedAppIdentifier ?? resolveConnectedAppIdentifierFromDriverStatus(parsedStatus);
                const staleTarget = connectedTarget ?? resolveExactDriverSessionTarget(parsedStatus, staleAppIdentifier);
                // eslint-disable-next-line no-await-in-loop
                const attempt = {
                    ok: false,
                    port: candidatePort,
                    reason: lastError && isTimeoutError(lastError)
                        ? 'timeout'
                        : lastError
                            ? 'error'
                            : staleAppIdentifier && staleAppIdentifier !== candidatePort
                                ? 'connected-different-app'
                                : 'no-matching-app-identifier',
                    connectedAppIdentifier: staleAppIdentifier ?? null,
                    connectedIdentifier: staleTarget?.identifier ?? null,
                };
                if (lastError) {
                    attempt.message = lastError instanceof Error ? lastError.message : String(lastError);
                }
                await appendAttempt(attempt);
                continue;
            }

            // eslint-disable-next-line no-await-in-loop
            const statusResult = await pollDriverSessionStatus(candidatePort, {
                runCliJson,
                attemptTimeoutMs,
                statusPollAttempts,
                statusPollDelayMs,
                preferredAppIdentifier,
            });
            const { parsedStatus, statusResponse, matchedTarget, connectedAppIdentifier, connectedTarget, lastError } = statusResult;

            if (matchedTarget) {
                usedDriverSessionPort = candidatePort;
                driverSessionResponse = statusResponse;
                driverSessionStatusResponse = statusResponse;
                resolvedAppTarget = matchedTarget;
                // eslint-disable-next-line no-await-in-loop
                await appendAttempt({
                    ok: true,
                    port: candidatePort,
                    appIdentifier: matchedTarget.port,
                    connectedIdentifier: matchedTarget.identifier ?? null,
                });
                return {
                    driverSessionPort: usedDriverSessionPort,
                    driverSessionResponse,
                    driverSessionStatusResponse,
                    resolvedAppIdentifier: resolvedAppTarget.port,
                    resolvedAppTarget,
                };
            }

            const staleAppIdentifier = connectedAppIdentifier ?? resolveConnectedAppIdentifierFromDriverStatus(parsedStatus);
            const staleTarget = connectedTarget ?? resolveExactDriverSessionTarget(parsedStatus, staleAppIdentifier);
            // eslint-disable-next-line no-await-in-loop
            const attempt = {
                ok: false,
                port: candidatePort,
                reason: lastError && isTimeoutError(lastError)
                    ? 'timeout'
                    : lastError
                        ? 'error'
                        : staleAppIdentifier && staleAppIdentifier !== candidatePort
                            ? 'connected-different-app'
                            : 'no-matching-app-identifier',
                connectedAppIdentifier: staleAppIdentifier ?? null,
                connectedIdentifier: staleTarget?.identifier ?? null,
            };
            if (lastError) {
                attempt.message = lastError instanceof Error ? lastError.message : String(lastError);
            }
            await appendAttempt(attempt);
        }

        for (const candidatePort of candidatePorts) {
            // eslint-disable-next-line no-await-in-loop
            const started = await runCliJson(
                ['driver-session', 'start', '--port', String(candidatePort)],
                { timeoutMs: attemptTimeoutMs },
            ).catch((error) => ({ error }));
            if (started && 'error' in started) {
                // eslint-disable-next-line no-await-in-loop
                await appendAttempt({
                    ok: false,
                    port: candidatePort,
                    reason: isTimeoutError(started.error) ? 'timeout' : 'error',
                    message: started.error instanceof Error ? started.error.message : String(started.error),
                });
                continue;
            }

            // eslint-disable-next-line no-await-in-loop
            const statusResult = await pollDriverSessionStatus(candidatePort, {
                runCliJson,
                attemptTimeoutMs,
                statusPollAttempts,
                statusPollDelayMs,
                preferredAppIdentifier,
            });
            const { parsedStatus, statusResponse, matchedTarget, connectedAppIdentifier, connectedTarget, lastError } = statusResult;

            if (matchedTarget) {
                usedDriverSessionPort = candidatePort;
                driverSessionResponse = started;
                driverSessionStatusResponse = statusResponse;
                resolvedAppTarget = matchedTarget;
                // eslint-disable-next-line no-await-in-loop
                await appendAttempt({
                    ok: true,
                    port: candidatePort,
                    appIdentifier: matchedTarget.port,
                    connectedIdentifier: matchedTarget.identifier ?? null,
                });
                return {
                    driverSessionPort: usedDriverSessionPort,
                    driverSessionResponse,
                    driverSessionStatusResponse,
                    resolvedAppIdentifier: resolvedAppTarget.port,
                    resolvedAppTarget,
                };
            }

            const staleAppIdentifier = connectedAppIdentifier ?? resolveConnectedAppIdentifierFromDriverStatus(parsedStatus);
            const staleTarget = connectedTarget ?? resolveExactDriverSessionTarget(parsedStatus, staleAppIdentifier);
            // eslint-disable-next-line no-await-in-loop
            const attempt = {
                ok: false,
                port: candidatePort,
                reason: lastError && isTimeoutError(lastError)
                    ? 'timeout'
                    : lastError
                        ? 'error'
                        : staleAppIdentifier && staleAppIdentifier !== candidatePort
                            ? 'connected-different-app'
                            : 'no-matching-app-identifier',
                connectedAppIdentifier: staleAppIdentifier ?? null,
                connectedIdentifier: staleTarget?.identifier ?? null,
            };
            if (lastError) {
                attempt.message = lastError instanceof Error ? lastError.message : String(lastError);
            }
            await appendAttempt(attempt);
        }

        throw new Error(`Unable to resolve a connected Tauri app identifier from driver-session status. Tried ports: ${candidatePorts.join(', ')}`);
    }

    for (const candidatePort of candidatePorts) {
        // eslint-disable-next-line no-await-in-loop
        await runCliJson(
            ['driver-session', 'stop', '--port', String(candidatePort)],
            { timeoutMs: attemptTimeoutMs },
        ).catch(() => {});

        try {
            // eslint-disable-next-line no-await-in-loop
            const started = await runCliJson(
                ['driver-session', 'start', '--port', String(candidatePort)],
                { timeoutMs: attemptTimeoutMs },
            );
            const statusResult = await pollDriverSessionStatus(candidatePort, {
                runCliJson,
                attemptTimeoutMs,
                statusPollAttempts,
                statusPollDelayMs,
            });
            const { parsedStatus, statusResponse, matchedTarget, connectedAppIdentifier, connectedTarget, lastError } = statusResult;

            if (matchedTarget) {
                usedDriverSessionPort = candidatePort;
                driverSessionResponse = started;
                driverSessionStatusResponse = statusResponse;
                resolvedAppTarget = matchedTarget;
                // eslint-disable-next-line no-await-in-loop
                await appendAttempt({
                    ok: true,
                    port: candidatePort,
                    appIdentifier: matchedTarget.port,
                    connectedIdentifier: matchedTarget.identifier ?? null,
                });
                break;
            }

            const staleAppIdentifier = connectedAppIdentifier ?? resolveConnectedAppIdentifierFromDriverStatus(parsedStatus);
            const staleTarget = connectedTarget ?? resolveExactDriverSessionTarget(parsedStatus, staleAppIdentifier);
            // eslint-disable-next-line no-await-in-loop
            const attempt = {
                ok: false,
                port: candidatePort,
                reason: lastError && isTimeoutError(lastError)
                    ? 'timeout'
                    : lastError
                        ? 'error'
                        : staleAppIdentifier && staleAppIdentifier !== candidatePort
                            ? 'connected-different-app'
                            : 'no-matching-app-identifier',
                connectedAppIdentifier: staleAppIdentifier ?? null,
                connectedIdentifier: staleTarget?.identifier ?? null,
            };
            if (lastError) {
                attempt.message = lastError instanceof Error ? lastError.message : String(lastError);
            }
            await appendAttempt(attempt);
        } catch (error) {
            // eslint-disable-next-line no-await-in-loop
            await appendAttempt({
                ok: false,
                port: candidatePort,
                reason: isTimeoutError(error) ? 'timeout' : 'error',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    if (!usedDriverSessionPort || !driverSessionResponse || !driverSessionStatusResponse || !resolvedAppTarget) {
        throw new Error(`Unable to resolve a connected Tauri app identifier from driver-session status. Tried ports: ${candidatePorts.join(', ')}`);
    }

    return {
        driverSessionPort: usedDriverSessionPort,
        driverSessionResponse,
        driverSessionStatusResponse,
        resolvedAppIdentifier: resolvedAppTarget.port,
        resolvedAppTarget,
    };
}
