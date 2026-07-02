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
    runTailscaleFunnelEnable,
    runTailscaleFunnelReset,
    runTailscaleFunnelStatus,
    runTailscaleStatusJson,
} from '../../../tailscale/index.js';

import { relayAccessProviderDescriptorsById } from '../../catalog.js';

const descriptor = relayAccessProviderDescriptorsById.tailscaleFunnel;

export const tailscaleFunnelRelayAccessProvider: RelayAccessProvider = {
    descriptor,
    configure: async ({ config, ctx, timeoutMs, deadline, signal }) => {
        if (config.providerId !== 'tailscaleFunnel') {
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
            const res = await runTailscaleFunnelEnable(
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
                        reason: 'tailscale_funnel_approval_required',
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
                    providerId: 'tailscaleFunnel',
                    phase: 'tailscale.funnel.enable',
                    error,
                }),
            };
        }

        return { state: 'unknown' };
    },
    disable: async ({ config, ctx, timeoutMs, deadline, signal }) => {
        if (config.providerId !== 'tailscaleFunnel') {
            return;
        }
        const commandDeadline = resolveTailscaleRelayAccessDeadline({ timeoutMs, deadline, signal });
        await runTailscaleFunnelReset(
            resolveTailscaleRelayAccessCommandParams(ctx, { timeoutMs, deadline: commandDeadline, signal }),
            {
                ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
                ...(ctx.resolveCommandOnPath ? { resolveCommandOnPath: ctx.resolveCommandOnPath } : {}),
            },
        ).catch(() => undefined);
    },
    status: async ({ config, ctx, timeoutMs, deadline, signal }) => {
        if (config?.providerId !== 'tailscaleFunnel') {
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
                    providerId: 'tailscaleFunnel',
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

        let funnelStatus: string;
        try {
            funnelStatus = await runTailscaleFunnelStatus(
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
                    providerId: 'tailscaleFunnel',
                    phase: 'tailscale.funnel.status',
                    error,
                }),
            };
        }

        const shareUrl = tailscaleServeHttpsUrlForInternalServerUrlFromStatus(
            funnelStatus,
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
