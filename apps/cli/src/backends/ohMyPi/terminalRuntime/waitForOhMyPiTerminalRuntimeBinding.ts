import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import type { LocalHostedDirectTranscriptBinding } from '@/agent/terminalRuntime/directTranscriptBinding';

import {
    readOhMyPiTerminalRuntimeBreadcrumb,
    type ResolveOhMyPiTerminalRuntimeBreadcrumbParams,
} from './readOhMyPiTerminalRuntimeBreadcrumb';

type WaitForOhMyPiTerminalRuntimeBindingParams = ResolveOhMyPiTerminalRuntimeBreadcrumbParams & Readonly<{
    timeoutMs?: number;
    pollIntervalMs?: number;
}>;

function resolveTimeoutMs(params: WaitForOhMyPiTerminalRuntimeBindingParams): number {
    const raw = Number.parseInt(
        String(params.timeoutMs ?? params.env?.HAPPIER_OH_MY_PI_TERMINAL_RUNTIME_BIND_TIMEOUT_MS ?? ''),
        10,
    );
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 5_000;
    return Math.max(50, Math.min(60_000, configured));
}

function resolvePollIntervalMs(params: WaitForOhMyPiTerminalRuntimeBindingParams): number {
    const raw = Number.parseInt(
        String(params.pollIntervalMs ?? params.env?.HAPPIER_OH_MY_PI_TERMINAL_RUNTIME_BIND_POLL_INTERVAL_MS ?? ''),
        10,
    );
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 100;
    return Math.max(10, Math.min(5_000, configured));
}

async function waitForFile(filePath: string, timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
        try {
            await access(filePath, constants.F_OK);
            return true;
        } catch {
            // Keep polling until the deadline expires.
        }

        if (Date.now() >= deadline) {
            break;
        }

        await delay(pollIntervalMs);
    }

    return false;
}

export async function waitForOhMyPiTerminalRuntimeBinding(
    params: WaitForOhMyPiTerminalRuntimeBindingParams,
): Promise<LocalHostedDirectTranscriptBinding | undefined> {
    const breadcrumb = readOhMyPiTerminalRuntimeBreadcrumb(params);
    if (!breadcrumb) {
        return undefined;
    }

    const didMaterialize = await waitForFile(
        breadcrumb.sessionFilePath,
        resolveTimeoutMs(params),
        resolvePollIntervalMs(params),
    );
    if (!didMaterialize) {
        return undefined;
    }

    return {
        providerId: 'ohMyPi',
        source: {
            kind: 'ohMyPiAgentDir',
            agentDir: breadcrumb.agentDir,
        },
        remoteSessionId: breadcrumb.remoteSessionId,
        env: breadcrumb.env,
    };
}
