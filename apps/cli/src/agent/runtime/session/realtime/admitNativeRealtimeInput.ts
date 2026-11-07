import { AgentStartSessionCallerV1Schema } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import type { AgentSessionRealtimeConversation } from '@happier-dev/plugin-sdk/agents/runtime';
import { configuration } from '@/configuration';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, readCurrentRunnerAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import type { PluginRuntimeHookOperations } from '@/plugins/runtime/runtimeCore/plugin/sessionRuntimeHooks';
import { dispatchCurrentAgentRuntimeDaemonServiceRequest } from '../process/agentRuntimeDaemonServiceAuthorityClient';
import { nativeRealtimeInputAdmissionV1Equal, type NativeRealtimeInputAdmissionV1 } from '../process/agentRuntimeDaemonServiceTurnWitness';

/** The authenticated host Start owns this fact; native events and plugin code cannot mint it. */
export async function admitNativeRealtimeInput(input: Readonly<{
    runtime: Pick<PluginRuntimeHookOperations, 'admitAgentSessionRealtimeInput'>;
    conversation: AgentSessionRealtimeConversation;
    sessionId: string;
    starterDepth: number | undefined;
    admission: NativeRealtimeInputAdmissionV1;
    signal: AbortSignal;
}>): Promise<Readonly<{ dispose(): Promise<void> }>> {
    const path = process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
    // A person turn has cause depth zero, independently of this Session's starter depth.
    const caller = AgentStartSessionCallerV1Schema.safeParse({ kind: 'session', sessionId: input.sessionId,
        starterDepth: input.starterDepth, turnDepth: 0 });
    if (!path || !caller.success || input.signal.aborted || !input.runtime.admitAgentSessionRealtimeInput) {
        throw new Error('Native Realtime input admission unavailable');
    }
    const current = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, expectedSessionId: input.sessionId,
    });
    if (!current || input.signal.aborted) throw new Error('Native Realtime runner authority unavailable');
    const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, sessionId: input.sessionId, runner: current.runner, retainedAgent: current.retainedAgent };
    let native: ReturnType<NonNullable<PluginRuntimeHookOperations['admitAgentSessionRealtimeInput']>> = null;
    let withdrawal: Promise<void> | null = null;
    const dispose = (): Promise<void> => {
        // Withdraw the local reader and cancel in-flight tools synchronously,
        // before waiting for the daemon or any upstream stop/dispose operation.
        native?.signal.removeEventListener('abort', onAbort);
        native?.dispose();
        withdrawal ??= (async () => {
            const result = await dispatchCurrentAgentRuntimeDaemonServiceRequest({ authority, timeoutMs: null,
                createRequest: token => ({ v: 1, context: { token, sessionId: input.sessionId },
                    operation: { kind: 'native_realtime.input.retire', admission: input.admission } }),
            });
            if (!result.ok || result.result.kind !== 'native_realtime.input.retired') {
                throw new Error('Native Realtime input withdrawal unconfirmed');
            }
        })();
        return withdrawal;
    };
    const onAbort = () => { void dispose().catch(() => undefined); };
    try {
        const result = await dispatchCurrentAgentRuntimeDaemonServiceRequest({ authority, timeoutMs: null, signal: input.signal,
            createRequest: token => ({ v: 1, context: { token, sessionId: input.sessionId },
                operation: { kind: 'native_realtime.input.admit', admission: input.admission } }),
        });
        if (!result.ok || result.result.kind !== 'native_realtime.input.admission'
            || !nativeRealtimeInputAdmissionV1Equal(result.result.admission, input.admission) || input.signal.aborted) {
            throw new Error('Native Realtime input admission refused');
        }
        native = input.runtime.admitAgentSessionRealtimeInput({ admission: input.admission, conversation: input.conversation,
            agentStartCaller: caller.data, signal: input.signal });
        if (!native || native.signal.aborted) throw new Error('Native Realtime Session retired');
        native.signal.addEventListener('abort', onAbort, { once: true });
        if (native.signal.aborted) { await dispose(); throw new Error('Native Realtime Session retired'); }
        return Object.freeze({ dispose });
    } catch (error) {
        await dispose();
        throw error;
    }
}
