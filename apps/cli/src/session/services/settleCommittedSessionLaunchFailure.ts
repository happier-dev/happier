import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { deliverSessionTurnMutation } from '@/api/session/client/transport/mutations/deliverSessionTurnMutation';
import { sanitizeConnectedServiceDiagnosticString } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';

/** Settle a known pre-runner refusal on its already committed Session. */
export async function settleCommittedSessionLaunchFailure(args: Readonly<{
  token: string;
  sessionId: string;
  failure: Parameters<typeof projectSessionSpawnFailure>[0];
  authorizeRequest?: Parameters<typeof deliverSessionTurnMutation>[0]['resolveAuthorizationHeaders'];
}>): Promise<void> {
  const failure = projectSessionSpawnFailure(args.failure);
  const launchError = 'launchError' in failure ? failure.launchError : undefined;
  const failureCause = {
    ...(launchError?.failureCause ?? { phase: 'client_start' as const, failureReason: 'unknown' as const }),
    providerErrorCode: sanitizeConnectedServiceDiagnosticString(launchError?.code ?? args.failure.errorCode),
  };
  const lifecycle = createSessionTurnLifecycle({ session: {
    sessionId: args.sessionId,
    enqueueSessionTurnMutation: async mutation => {
      const delivery = await deliverSessionTurnMutation({ token: args.token, socket: null, mutation,
        ...(args.authorizeRequest ? { resolveAuthorizationHeaders: args.authorizeRequest } : {}),
      });
      if (!delivery.delivered) throw new Error(delivery.reason);
    },
  } });
  try {
    await lifecycle.failTurn({ allocateWhenIdle: true,
      issue: classifyPrimarySessionRuntimeIssue({ cause: failureCause.failureReason === 'authentication_required' ? 'auth_error'
        : failureCause.failureReason === 'usage_limit' ? 'usage_limit' : 'session_error',
        ...(typeof args.failure.agentId === 'string' ? { provider: args.failure.agentId } : {}),
        error: { code: launchError?.code ?? args.failure.errorCode, severity: 'error',
          failureCause,
        },
      }),
    });
  } finally { lifecycle.dispose(); }
}
