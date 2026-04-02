import type { RelayAccessProvider } from '../../types.js';

import {
    extractTailscaleServeHttpsUrl,
    runTailscaleFunnelEnable,
    runTailscaleFunnelReset,
    runTailscaleFunnelStatus,
    runTailscaleStatusJson,
} from '../../../tailscale/index.js';

import { relayAccessProviderDescriptorsById } from '../../catalog.js';

const descriptor = relayAccessProviderDescriptorsById.tailscaleFunnel;

export const tailscaleFunnelRelayAccessProvider: RelayAccessProvider = {
    descriptor,
    configure: async ({ config, ctx }) => {
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
            const res = await runTailscaleFunnelEnable(
                { env: ctx.env, upstreamUrl },
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
                details: {
                    reason: 'tailscale_funnel_enable_failed',
                    message: error instanceof Error ? error.message : String(error),
                },
            };
        }

        return { state: 'unknown' };
    },
    disable: async ({ config, ctx }) => {
        if (config.providerId !== 'tailscaleFunnel') {
            return;
        }
        await runTailscaleFunnelReset(
            { env: ctx.env },
            {
                ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
                ...(ctx.resolveCommandOnPath ? { resolveCommandOnPath: ctx.resolveCommandOnPath } : {}),
            },
        ).catch(() => undefined);
    },
    status: async ({ config, ctx }) => {
        if (config?.providerId !== 'tailscaleFunnel') {
            return { state: 'unknown' };
        }

        let snapshot: Awaited<ReturnType<typeof runTailscaleStatusJson>>;
        try {
            snapshot = await runTailscaleStatusJson(
                { env: ctx.env },
                {
                    ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
                    ...(ctx.resolveCommandOnPath ? { resolveCommandOnPath: ctx.resolveCommandOnPath } : {}),
                },
            );
        } catch (error) {
            return {
                state: 'error',
                details: {
                    reason: 'tailscale_status_failed',
                    message: error instanceof Error ? error.message : String(error),
                },
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
                { env: ctx.env },
                {
                    ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
                    ...(ctx.resolveCommandOnPath ? { resolveCommandOnPath: ctx.resolveCommandOnPath } : {}),
                },
            );
        } catch (error) {
            return {
                state: 'error',
                details: {
                    reason: 'tailscale_funnel_status_failed',
                    message: error instanceof Error ? error.message : String(error),
                },
            };
        }

        const shareUrl = extractTailscaleServeHttpsUrl(funnelStatus);
        if (!shareUrl) {
            return { state: 'disabled' };
        }

        return {
            state: 'enabled',
            shareUrl,
        };
    },
};
