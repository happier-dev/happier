import {
    DaemonPluginReactNativeCrashReportRequestV1Schema,
    DaemonPluginReactNativeCrashReportResponseV1Schema,
    type DaemonPluginReactNativeCrashReportReasonV1,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import type { PluginReactNativeBundleCacheIdentity } from './reactNativeRuntime';

export type ReactNativeCrashDisableReportInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    surfaceId: string;
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
    disabledReason: DaemonPluginReactNativeCrashReportReasonV1;
    crashCount: number;
    startupFailureCount: number;
    observedAtMs?: number;
    diagnostics?: readonly string[];
}>;

export type ReactNativeCrashDisableReportResult =
    | Readonly<{ ok: true; disabled: true }>
    | Readonly<{
        ok: false;
        reason:
            | 'unavailable'
            | 'request_failed'
            | 'invalid_response'
            | 'invalid_request'
            | 'projection_identity_mismatch'
            | 'state_write_failed';
    }>;

export async function reportReactNativeCrashDisableViaMachineRpc(
    input: ReactNativeCrashDisableReportInput,
): Promise<ReactNativeCrashDisableReportResult> {
    let payload: ReturnType<typeof DaemonPluginReactNativeCrashReportRequestV1Schema.parse>;
    try {
        payload = DaemonPluginReactNativeCrashReportRequestV1Schema.parse({
            protocolVersion: 1,
            machineId: input.machineId,
            report: {
                surfaceId: input.surfaceId,
                cacheIdentity: input.cacheIdentity,
                disabledReason: input.disabledReason,
                crashCount: input.crashCount,
                startupFailureCount: input.startupFailureCount,
                ...(input.observedAtMs !== undefined ? { observedAtMs: input.observedAtMs } : {}),
                ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
            },
        });
    } catch {
        return { ok: false, reason: 'invalid_request' };
    }

    try {
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId ?? undefined,
            method: RPC_METHODS.DAEMON_PLUGIN_UI_REACT_NATIVE_CRASH_REPORT_SUBMIT,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonPluginReactNativeCrashReportResponseV1Schema.safeParse(raw);
        if (!parsed.success) {
            return { ok: false, reason: 'invalid_response' };
        }
        if (parsed.data.ok) {
            return { ok: true, disabled: true };
        }
        return { ok: false, reason: parsed.data.code };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}
