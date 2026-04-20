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

export function resolveStackNameFromStackOwnedTauriIdentifier(identifier) {
    const normalizedIdentifier = readString(identifier);
    const prefix = 'com.happier.stack.';
    if (!normalizedIdentifier.startsWith(prefix)) {
        return '';
    }
    return normalizedIdentifier.slice(prefix.length).trim();
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

function isStackOwnedTauriIdentifier(identifier) {
    return readString(identifier).startsWith('com.happier.stack.');
}

function readDriverSessionResponseText(response) {
    const directText = readString(response?.text);
    if (directText) {
        return directText;
    }

    const content = Array.isArray(response?.content) ? response.content : [];
    for (const entry of content) {
        const entryText = readString(entry?.text);
        if (entryText) {
            return entryText;
        }
    }

    return '';
}

function isNoTauriAppFoundStartResponse(response) {
    return readDriverSessionResponseText(response).toLowerCase().includes('no tauri app found');
}

function shouldAcceptConnectedDriverSessionTarget(target) {
    if (!target || typeof target !== 'object') {
        return false;
    }

    return isStackOwnedTauriIdentifier(target.identifier);
}

function resolveDriverSessionAppIdentifier(target) {
    const identifier = readString(target?.identifier);
    if (identifier) {
        return identifier;
    }

    return normalizePositiveInteger(target?.port);
}

function resolveExactDriverSessionTargetByAppIdentifier(status, appIdentifier = null) {
    const requestedIdentifier = readString(appIdentifier);
    if (requestedIdentifier) {
        return resolvePreferredDriverSessionTarget(status, {
            preferredAppIdentifier: requestedIdentifier,
        });
    }

    const requestedPort = normalizePositiveInteger(appIdentifier);
    if (requestedPort != null) {
        return resolveExactDriverSessionTarget(status, requestedPort);
    }

    return null;
}

async function pollDriverSessionStatus(candidatePort, {
    runCliJson,
    attemptTimeoutMs,
    statusPollAttempts = 1,
    statusPollDelayMs = 0,
    preferredAppIdentifier = null,
    requireStackOwnedIdentifier = false,
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
                if (requireStackOwnedIdentifier && !isStackOwnedTauriIdentifier(matchedTarget.identifier)) {
                    lastConnectedAppIdentifier = resolveDriverSessionAppIdentifier(matchedTarget);
                    lastConnectedTarget = matchedTarget;
                    continue;
                }
                return {
                    matchedTarget,
                    parsedStatus: lastParsedStatus,
                    statusResponse,
                    connectedAppIdentifier: resolveDriverSessionAppIdentifier(matchedTarget),
                    connectedTarget: matchedTarget,
                    lastError: null,
                };
            }

            lastConnectedAppIdentifier = resolveConnectedAppIdentifierFromDriverStatus(lastParsedStatus);
            lastConnectedTarget = resolveExactDriverSessionTargetByAppIdentifier(lastParsedStatus, lastConnectedAppIdentifier);
            if (shouldAcceptConnectedDriverSessionTarget(lastConnectedTarget)) {
                return {
                    matchedTarget: lastConnectedTarget,
                    parsedStatus: lastParsedStatus,
                    statusResponse,
                    connectedAppIdentifier: lastConnectedAppIdentifier,
                    connectedTarget: lastConnectedTarget,
                    lastError: null,
                };
            }
            if (lastConnectedTarget?.port != null && lastConnectedTarget.port !== candidatePort) {
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
    return resolveDriverSessionAppIdentifier(resolveExactDriverSessionTarget(status));
}

export function resolvePreferredAppIdentifierFromDriverStatus(status, preferredPort = null) {
    const requestedPort = normalizePositiveInteger(preferredPort);
    if (requestedPort == null) {
        return resolveConnectedAppIdentifierFromDriverStatus(status);
    }

    return resolveDriverSessionAppIdentifier(resolveExactDriverSessionTarget(status, requestedPort));
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
    requireStackOwnedIdentifier = false,
    env = process.env,
}) {
    const explicitPreferredAppIdentifier = readString(env?.HAPPIER_STACK_TAURI_IDENTIFIER);
    const preferredAppIdentifier = explicitPreferredAppIdentifier || null;
    const softPreferredAppIdentifier = preferredAppIdentifier
        ? null
        : resolvePreferredStackTauriIdentifier(env) || null;
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
                    { timeoutMs: attemptTimeoutMs, env },
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
                    env,
                    preferredAppIdentifier,
                    requireStackOwnedIdentifier,
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
                        appIdentifier: resolveDriverSessionAppIdentifier(matchedTarget),
                        connectedIdentifier: matchedTarget.identifier ?? null,
                    });
                    return {
                        driverSessionPort: usedDriverSessionPort,
                        driverSessionResponse,
                        driverSessionStatusResponse,
                        resolvedAppIdentifier: resolveDriverSessionAppIdentifier(resolvedAppTarget),
                        resolvedAppTarget,
                    };
                }

                const staleAppIdentifier = connectedAppIdentifier ?? resolveConnectedAppIdentifierFromDriverStatus(parsedStatus);
                const staleTarget = connectedTarget ?? resolveExactDriverSessionTargetByAppIdentifier(parsedStatus, staleAppIdentifier);
                // eslint-disable-next-line no-await-in-loop
                const attempt = {
                    ok: false,
                    port: candidatePort,
                    reason: lastError && isTimeoutError(lastError)
                        ? 'timeout'
                        : lastError
                            ? 'error'
                    : staleTarget?.port != null && staleTarget.port !== candidatePort
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
                env,
                preferredAppIdentifier,
                requireStackOwnedIdentifier,
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
                    appIdentifier: resolveDriverSessionAppIdentifier(matchedTarget),
                    connectedIdentifier: matchedTarget.identifier ?? null,
                });
                return {
                    driverSessionPort: usedDriverSessionPort,
                    driverSessionResponse,
                    driverSessionStatusResponse,
                    resolvedAppIdentifier: resolveDriverSessionAppIdentifier(resolvedAppTarget),
                    resolvedAppTarget,
                };
            }

            const staleAppIdentifier = connectedAppIdentifier ?? resolveConnectedAppIdentifierFromDriverStatus(parsedStatus);
            const staleTarget = connectedTarget ?? resolveExactDriverSessionTargetByAppIdentifier(parsedStatus, staleAppIdentifier);
            // eslint-disable-next-line no-await-in-loop
            const attempt = {
                ok: false,
                port: candidatePort,
                reason: lastError && isTimeoutError(lastError)
                    ? 'timeout'
                    : lastError
                        ? 'error'
                        : staleTarget?.port != null && staleTarget.port !== candidatePort
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
                { timeoutMs: attemptTimeoutMs, env },
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
            if (isNoTauriAppFoundStartResponse(started)) {
                // eslint-disable-next-line no-await-in-loop
                await appendAttempt({
                    ok: false,
                    port: candidatePort,
                    reason: 'no-tauri-app-found',
                    connectedAppIdentifier: null,
                    connectedIdentifier: null,
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
                    appIdentifier: resolveDriverSessionAppIdentifier(matchedTarget),
                    connectedIdentifier: matchedTarget.identifier ?? null,
                });
                return {
                    driverSessionPort: usedDriverSessionPort,
                    driverSessionResponse,
                    driverSessionStatusResponse,
                    resolvedAppIdentifier: resolveDriverSessionAppIdentifier(resolvedAppTarget),
                    resolvedAppTarget,
                };
            }

            const staleAppIdentifier = connectedAppIdentifier ?? resolveConnectedAppIdentifierFromDriverStatus(parsedStatus);
            const staleTarget = connectedTarget ?? resolveExactDriverSessionTargetByAppIdentifier(parsedStatus, staleAppIdentifier);
            // eslint-disable-next-line no-await-in-loop
            const attempt = {
                ok: false,
                port: candidatePort,
                reason: lastError && isTimeoutError(lastError)
                    ? 'timeout'
                    : lastError
                        ? 'error'
                        : staleTarget?.port != null && staleTarget.port !== candidatePort
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

    if (softPreferredAppIdentifier) {
        for (const candidatePort of candidatePorts) {
            // eslint-disable-next-line no-await-in-loop
            const statusResult = await pollDriverSessionStatus(candidatePort, {
                runCliJson,
                attemptTimeoutMs,
                statusPollAttempts,
                statusPollDelayMs,
                env,
                preferredAppIdentifier: softPreferredAppIdentifier,
                requireStackOwnedIdentifier,
            });
            const { statusResponse, matchedTarget, connectedTarget } = statusResult;
            const softMatchedTarget = matchedTarget ?? null;

            if (!softMatchedTarget) {
                if (isStackOwnedTauriIdentifier(connectedTarget?.identifier)) {
                    // eslint-disable-next-line no-await-in-loop
                    await appendAttempt({
                        ok: false,
                        port: candidatePort,
                        reason: 'connected-different-stack-app',
                        connectedAppIdentifier: resolveDriverSessionAppIdentifier(connectedTarget),
                        connectedIdentifier: connectedTarget.identifier ?? null,
                    });
                }
                continue;
            }

            usedDriverSessionPort = candidatePort;
            driverSessionResponse = statusResponse;
            driverSessionStatusResponse = statusResponse;
            resolvedAppTarget = softMatchedTarget;
            // eslint-disable-next-line no-await-in-loop
            await appendAttempt({
                ok: true,
                port: candidatePort,
                appIdentifier: resolveDriverSessionAppIdentifier(softMatchedTarget),
                connectedIdentifier: softMatchedTarget.identifier ?? null,
            });
            return {
                driverSessionPort: usedDriverSessionPort,
                driverSessionResponse,
                driverSessionStatusResponse,
                resolvedAppIdentifier: resolveDriverSessionAppIdentifier(resolvedAppTarget),
                resolvedAppTarget,
            };
        }

        for (const candidatePort of candidatePorts) {
            // eslint-disable-next-line no-await-in-loop
            const started = await runCliJson(
                ['driver-session', 'start', '--port', String(candidatePort)],
                { timeoutMs: attemptTimeoutMs, env },
            ).catch((error) => ({ error }));
            if (started && 'error' in started) {
                continue;
            }
            if (isNoTauriAppFoundStartResponse(started)) {
                // eslint-disable-next-line no-await-in-loop
                await appendAttempt({
                    ok: false,
                    port: candidatePort,
                    reason: 'no-tauri-app-found',
                    connectedAppIdentifier: null,
                    connectedIdentifier: null,
                });
                continue;
            }

            // eslint-disable-next-line no-await-in-loop
            const statusResult = await pollDriverSessionStatus(candidatePort, {
                runCliJson,
                attemptTimeoutMs,
                statusPollAttempts,
                statusPollDelayMs,
                preferredAppIdentifier: softPreferredAppIdentifier,
                requireStackOwnedIdentifier,
            });
            const { statusResponse, matchedTarget, connectedTarget } = statusResult;
            const softMatchedTarget = matchedTarget ?? null;

            if (!softMatchedTarget) {
                if (isStackOwnedTauriIdentifier(connectedTarget?.identifier)) {
                    // eslint-disable-next-line no-await-in-loop
                    await appendAttempt({
                        ok: false,
                        port: candidatePort,
                        reason: 'connected-different-stack-app',
                        connectedAppIdentifier: resolveDriverSessionAppIdentifier(connectedTarget),
                        connectedIdentifier: connectedTarget.identifier ?? null,
                    });
                }
                continue;
            }

            usedDriverSessionPort = candidatePort;
            driverSessionResponse = started;
            driverSessionStatusResponse = statusResponse;
            resolvedAppTarget = softMatchedTarget;
            // eslint-disable-next-line no-await-in-loop
            await appendAttempt({
                ok: true,
                port: candidatePort,
                appIdentifier: resolveDriverSessionAppIdentifier(softMatchedTarget),
                connectedIdentifier: softMatchedTarget.identifier ?? null,
            });
            return {
                driverSessionPort: usedDriverSessionPort,
                driverSessionResponse,
                driverSessionStatusResponse,
                resolvedAppIdentifier: resolveDriverSessionAppIdentifier(resolvedAppTarget),
                resolvedAppTarget,
            };
        }

        throw new Error(
            `Unable to resolve the preferred stack-owned Tauri app identifier ${softPreferredAppIdentifier}. Tried ports: ${candidatePorts.join(', ')}`,
        );
    }

    for (const candidatePort of candidatePorts) {
        // eslint-disable-next-line no-await-in-loop
        const statusResult = await pollDriverSessionStatus(candidatePort, {
            runCliJson,
            attemptTimeoutMs,
            statusPollAttempts,
            statusPollDelayMs,
            env,
            requireStackOwnedIdentifier,
        });
        const { parsedStatus, statusResponse, matchedTarget, connectedAppIdentifier, connectedTarget, lastError } = statusResult;

        if (!matchedTarget) {
            const staleAppIdentifier = connectedAppIdentifier ?? resolveConnectedAppIdentifierFromDriverStatus(parsedStatus);
            const staleTarget = connectedTarget ?? resolveExactDriverSessionTargetByAppIdentifier(parsedStatus, staleAppIdentifier);
            // eslint-disable-next-line no-await-in-loop
            const attempt = {
                ok: false,
                port: candidatePort,
                reason: lastError && isTimeoutError(lastError)
                    ? 'timeout'
                    : lastError
                        ? 'error'
                            : staleTarget?.port != null && staleTarget.port !== candidatePort
                            ? 'connected-different-app'
                            : 'no-matching-app-identifier',
                connectedAppIdentifier: staleAppIdentifier ?? null,
                connectedIdentifier: staleTarget?.identifier ?? null,
            };
            if (lastError) {
                attempt.message = lastError instanceof Error ? lastError.message : String(lastError);
            }
            // eslint-disable-next-line no-await-in-loop
            await appendAttempt(attempt);
            continue;
        }

        usedDriverSessionPort = candidatePort;
        driverSessionResponse = statusResponse;
        driverSessionStatusResponse = statusResponse;
        resolvedAppTarget = matchedTarget;
        // eslint-disable-next-line no-await-in-loop
        await appendAttempt({
            ok: true,
            port: candidatePort,
            appIdentifier: resolveDriverSessionAppIdentifier(matchedTarget),
            connectedIdentifier: matchedTarget.identifier ?? null,
        });
        return {
            driverSessionPort: usedDriverSessionPort,
            driverSessionResponse,
            driverSessionStatusResponse,
            resolvedAppIdentifier: resolveDriverSessionAppIdentifier(resolvedAppTarget),
            resolvedAppTarget,
        };
    }

    for (const candidatePort of candidatePorts) {
        // eslint-disable-next-line no-await-in-loop
        await runCliJson(
            ['driver-session', 'stop', '--port', String(candidatePort)],
            { timeoutMs: attemptTimeoutMs, env },
        ).catch(() => {});

        try {
            // eslint-disable-next-line no-await-in-loop
            const started = await runCliJson(
                ['driver-session', 'start', '--port', String(candidatePort)],
                { timeoutMs: attemptTimeoutMs, env },
            );
            if (isNoTauriAppFoundStartResponse(started)) {
                // eslint-disable-next-line no-await-in-loop
                await appendAttempt({
                    ok: false,
                    port: candidatePort,
                    reason: 'no-tauri-app-found',
                    connectedAppIdentifier: null,
                    connectedIdentifier: null,
                });
                continue;
            }
            const statusResult = await pollDriverSessionStatus(candidatePort, {
                runCliJson,
                attemptTimeoutMs,
                statusPollAttempts,
                statusPollDelayMs,
                env,
                requireStackOwnedIdentifier,
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
                    appIdentifier: resolveDriverSessionAppIdentifier(matchedTarget),
                    connectedIdentifier: matchedTarget.identifier ?? null,
                });
                break;
            }

            const staleAppIdentifier = connectedAppIdentifier ?? resolveConnectedAppIdentifierFromDriverStatus(parsedStatus);
            const staleTarget = connectedTarget ?? resolveExactDriverSessionTargetByAppIdentifier(parsedStatus, staleAppIdentifier);
            // eslint-disable-next-line no-await-in-loop
            const attempt = {
                ok: false,
                port: candidatePort,
                reason: lastError && isTimeoutError(lastError)
                    ? 'timeout'
                    : lastError
                        ? 'error'
                            : staleTarget?.port != null && staleTarget.port !== candidatePort
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
        resolvedAppIdentifier: resolveDriverSessionAppIdentifier(resolvedAppTarget),
        resolvedAppTarget,
    };
}
