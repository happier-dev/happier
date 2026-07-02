import {
    createRelayAccessDiagnostic,
} from '../../diagnostics.js';
import type { RelayAccessProvider } from '../../types.js';
import {
    resolveTailscaleRelayAccessCommandParams,
    resolveTailscaleRelayAccessDeadline,
} from '../tailscale/commandParams.js';

import {
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
            const res = await runTailscaleServeEnable(
                {
                    ...resolveTailscaleRelayAccessCommandParams(ctx, { timeoutMs, deadline: commandDeadline, signal }),
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

        if (!snapshot.loggedIn) {
            return {
                state: 'needs_auth',
                details: {
                    backendState: snapshot.backendState,
                    authUrl: snapshot.authUrl,
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
