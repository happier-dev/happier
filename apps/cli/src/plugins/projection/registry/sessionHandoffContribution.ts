import type { SessionHandoffContribution } from './agentRuntimeContribution';

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readFunction<TFunction extends (...args: never[]) => unknown>(
    value: unknown,
): TFunction | null {
    return typeof value === 'function' ? value as TFunction : null;
}

/**
 * Session-handoff catalog contributions retain only metadata projection leaves.
 * Runtime operations are registered by the AgentRuntime itself so every plugin
 * receives its invocation services from the current runtime lease.
 */
export function readSessionHandoffContribution(value: unknown): SessionHandoffContribution | null {
    if (!isRecord(value)) return null;
    const agentBundleRecords = isRecord(value.agentBundleRecords) ? value.agentBundleRecords : null;
    const extract = readFunction<
        NonNullable<NonNullable<SessionHandoffContribution['agentBundleRecords']>['extract']>
    >(agentBundleRecords?.extract);
    const runtimeLocalMetadata = isRecord(value.runtimeLocalMetadata) ? value.runtimeLocalMetadata : null;
    const buildRuntimeLocalMetadata = readFunction<
        NonNullable<NonNullable<SessionHandoffContribution['runtimeLocalMetadata']>['build']>
    >(runtimeLocalMetadata?.build);
    const nativeSessionLog = isRecord(value.nativeSessionLog) ? value.nativeSessionLog : null;
    const resolveNativeSessionLogPath = readFunction<
        NonNullable<NonNullable<SessionHandoffContribution['nativeSessionLog']>['resolvePath']>
    >(nativeSessionLog?.resolvePath);
    if (!extract && !buildRuntimeLocalMetadata && !resolveNativeSessionLogPath) return null;
    return {
        ...(extract ? { agentBundleRecords: { extract } } : {}),
        ...(buildRuntimeLocalMetadata
            ? { runtimeLocalMetadata: { build: buildRuntimeLocalMetadata } }
            : {}),
        ...(resolveNativeSessionLogPath
            ? { nativeSessionLog: { resolvePath: resolveNativeSessionLogPath } }
            : {}),
    };
}
