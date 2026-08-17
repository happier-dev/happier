import {
    DaemonPluginReactNativeCrashReportRequestV1Schema,
    DaemonPluginReactNativeCrashReportResponseV1Schema,
    type DaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonPluginReactNativeCrashReportV1,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type ReactNativeCrashReportInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    report: DaemonPluginReactNativeCrashReportV1;
}>;

type ReactNativeCrashReportRequestFailureReason =
    | 'unavailable'
    | 'request_failed'
    | 'invalid_response'
    | 'invalid_request'
    | 'binding_token_mismatch'
    | 'failure_occurrence_conflict'
    | 'state_write_failed';

export type ReactNativeCrashReportResult =
    | Readonly<{
        ok: true;
        token: DaemonPluginReactNativeCrashBindingTokenV1;
        disabled: boolean;
    }>
    | Readonly<{
        ok: false;
        reason: ReactNativeCrashReportRequestFailureReason;
    }>;

/**
 * The daemon owns reconciliation, thresholding, disablement, and reset. This
 * transport only forwards one exact report/recovery request and exposes the
 * daemon's authoritative token state to the host consumer.
 */
export async function submitReactNativeCrashReportViaMachineRpc(
    input: ReactNativeCrashReportInput,
): Promise<ReactNativeCrashReportResult> {
    let payload: ReturnType<typeof DaemonPluginReactNativeCrashReportRequestV1Schema.parse>;
    try {
        payload = DaemonPluginReactNativeCrashReportRequestV1Schema.parse({
            protocolVersion: 1,
            machineId: input.machineId,
            report: input.report,
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
            return {
                ok: true,
                token: parsed.data.token,
                disabled: parsed.data.disabled,
            };
        }
        return { ok: false, reason: parsed.data.code };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}
