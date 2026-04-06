import type { RelayAccessProvider } from '../../types.js';

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
    configure: async ({ config, ctx }) => {
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
            const res = await runTailscaleServeEnable(
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
                details: {
                    reason: 'tailscale_serve_enable_failed',
                    message: error instanceof Error ? error.message : String(error),
                },
            };
        }

        return { state: 'unknown' };
    },
    disable: async ({ config, ctx }) => {
        if (config.providerId !== 'tailscaleServe') {
            return;
        }
        await runTailscaleServeDisable(
            { env: ctx.env },
            {
                ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
                ...(ctx.resolveCommandOnPath ? { resolveCommandOnPath: ctx.resolveCommandOnPath } : {}),
            },
        ).catch(() => undefined);
    },
    status: async ({ config, ctx }) => {
        if (config?.providerId !== 'tailscaleServe') {
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

        let serveStatus: string;
        try {
            serveStatus = await runTailscaleServeStatus(
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
                    reason: 'tailscale_serve_status_failed',
                    message: error instanceof Error ? error.message : String(error),
                },
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
