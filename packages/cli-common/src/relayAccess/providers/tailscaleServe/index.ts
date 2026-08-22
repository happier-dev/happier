import {
    createRelayAccessDiagnostic,
} from '../../diagnostics.js';
import type { RelayAccessProvider } from '../../types.js';
import {
    resolveTailscaleRelayAccessCommandParams,
    resolveTailscaleRelayAccessDeadline,
} from '../tailscale/commandParams.js';

import {
    classifyTailscaleServeRootSlot,
    extractTailscaleServeHttpsUrl,
    tailscaleServeHttpsUrlForInternalServerUrlFromStatus,
    runTailscaleServeDisable,
    runTailscaleServeEnable,
    runTailscaleServeStatus,
    runTailscaleStatusJson,
} from '../../../tailscale/index.js';

import { relayAccessProviderDescriptorsById } from '../../catalog.js';

const descriptor = relayAccessProviderDescriptorsById.tailscaleServe;

export const tailscaleServeRelayAccessProvider: RelayAccessProvider = {
    descriptor,
    configure: async ({ config, ctx, timeoutMs, deadline, signal }) => {
        if (config.providerId !== 'tailscaleServe') {
            return { state: 'unknown' };
        }

        const upstreamUrl = String(ctx.upstreamUrl ?? '').trim();
        if (!upstreamUrl) {
            return {
                state: 'error',
                details: {
                    reason: 'missing_upstream_url',
                },
            };
        }

        try {
            const commandDeadline = resolveTailscaleRelayAccessDeadline({ timeoutMs, deadline, signal });
            const commandParams = resolveTailscaleRelayAccessCommandParams(ctx, {
                timeoutMs,
                deadline: commandDeadline,
                signal,
            });
            const serveStatus = await runTailscaleServeStatus(
                commandParams,
                {
                    ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
                    ...(ctx.resolveCommandOnPath ? { resolveCommandOnPath: ctx.resolveCommandOnPath } : {}),
                },
            );
            const rootSlot = classifyTailscaleServeRootSlot(serveStatus, upstreamUrl);
            if (rootSlot.kind === 'conflict') {
                return {
                    state: 'error',
                    details: {
                        reason: 'tailscale_root_slot_conflict',
                        exposure: rootSlot.exposure,
                        shareUrl: rootSlot.httpsUrl,
                    },
                };
            }
            if (rootSlot.kind === 'exact') {
                return rootSlot.httpsUrl
                    ? { state: 'enabled', shareUrl: rootSlot.httpsUrl }
                    : { state: 'unknown' };
            }
            const res = await runTailscaleServeEnable(
                {
                    ...commandParams,
                    upstreamUrl,
                },
                {
                    ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
                    ...(ctx.resolveCommandOnPath ? { resolveCommandOnPath: ctx.resolveCommandOnPath } : {}),
                },
            );

            if (res.approvalUrl) {
                return {
                    state: 'needs_auth',
                    details: {
                        reason: 'tailscale_serve_approval_required',
                        approvalUrl: res.approvalUrl,
                    },
                };
            }

            if (res.httpsUrl) {
                return {
                    state: 'enabled',
                    shareUrl: res.httpsUrl,
                };
            }
        } catch (error) {
            return {
                state: 'error',
                details: createRelayAccessDiagnostic({
                    providerId: 'tailscaleServe',
                    phase: 'tailscale.serve.enable',
                    error,
                }),
            };
        }

        return { state: 'unknown' };
    },
    disable: async ({ config, ctx, timeoutMs, deadline, signal }) => {
        if (config.providerId !== 'tailscaleServe') {
            return;
        }
        const commandDeadline = resolveTailscaleRelayAccessDeadline({ timeoutMs, deadline, signal });
        await runTailscaleServeDisable(
            resolveTailscaleRelayAccessCommandParams(ctx, { timeoutMs, deadline: commandDeadline, signal }),
            {
                ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
                ...(ctx.resolveCommandOnPath ? { resolveCommandOnPath: ctx.resolveCommandOnPath } : {}),
            },
        ).catch(() => undefined);
    },
    status: async ({ config, ctx, timeoutMs, deadline, signal }) => {
        if (config?.providerId !== 'tailscaleServe') {
            return { state: 'unknown' };
        }

        const commandDeadline = resolveTailscaleRelayAccessDeadline({ timeoutMs, deadline, signal });
        let snapshot: Awaited<ReturnType<typeof runTailscaleStatusJson>>;
        try {
            snapshot = await runTailscaleStatusJson(
                resolveTailscaleRelayAccessCommandParams(ctx, { timeoutMs, deadline: commandDeadline, signal }),
                {
                    ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
                    ...(ctx.resolveCommandOnPath ? { resolveCommandOnPath: ctx.resolveCommandOnPath } : {}),
                },
            );
        } catch (error) {
            return {
                state: 'error',
                details: createRelayAccessDiagnostic({
                    providerId: 'tailscaleServe',
                    phase: 'tailscale.status',
                    error,
                }),
            };
        }

        // Signed in is not the same as usable. Serve/funnel config survives
        // `tailscale down`, so the configured HTTPS URL keeps printing while
        // the backend is stopped — reporting that as enabled tells the user a
        // relay is reachable from their other devices when nothing is
        // listening. Only a running backend may produce a shareUrl.
        if (!snapshot.running) {
            if (snapshot.daemonReachable && !snapshot.loggedIn) {
                return {
                    state: 'needs_auth',
                    details: {
                        backendState: snapshot.backendState,
                        authUrl: snapshot.authUrl,
                    },
                };
            }
            return {
                state: 'disabled',
                details: {
                    backendState: snapshot.backendState,
                    daemonReachable: snapshot.daemonReachable,
                    reason: 'tailscale_not_running',
                },
            };
        }

        let serveStatus: string;
        try {
            serveStatus = await runTailscaleServeStatus(
                resolveTailscaleRelayAccessCommandParams(ctx, { timeoutMs, deadline: commandDeadline, signal }),
                {
                    ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
                    ...(ctx.resolveCommandOnPath ? { resolveCommandOnPath: ctx.resolveCommandOnPath } : {}),
                },
            );
        } catch (error) {
            return {
                state: 'error',
                details: createRelayAccessDiagnostic({
                    providerId: 'tailscaleServe',
                    phase: 'tailscale.serve.status',
                    error,
                }),
            };
        }

        const shareUrl = tailscaleServeHttpsUrlForInternalServerUrlFromStatus(
            serveStatus,
            String(ctx.upstreamUrl ?? '').trim(),
        );
        if (!shareUrl) {
            return { state: 'disabled' };
        }

        return {
            state: 'enabled',
            shareUrl,
        };
    },
};
