import type { RpcHandlerContext } from '@/api/rpc/types';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserExistingProfile } from '@/daemon/browser/control/types';
import type { RuntimeActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol/browser/recording/v1';

import { buildActionExecutorContextForRpc } from './_actionDispatchAdapter';

type BrowserTarget = Readonly<{ browserSessionId: string }>;

/** Raw Browser contracts retain their shapes and consume the control owner's custody decision. */
export function createBrowserRawRequestAdmission(
    resolveControl: (() => BrowserDaemonControlRoutes | null | undefined) | undefined,
    context: RpcHandlerContext | undefined,
) {
    const control = resolveControl?.();
    const actionContext = buildActionExecutorContextForRpc(context ?? {});
    const failureFor = (target: BrowserTarget, existingProfile?: BrowserExistingProfile) => control?.getCommandAccessFailure?.({
        commandId: 'browser-rpc', browserSessionId: target.browserSessionId,
        ...(existingProfile ? { existingProfile } : {}),
    }, actionContext);
    const requireTarget = (target: BrowserTarget): void => {
        const failure = failureFor(target);
        if (failure) throw new RpcError(failure.error.message, failure.error.code);
    };
    return {
        requireTarget,
        requireContext(routes: BrowserContextRoutes, actionId: RuntimeActionIdV1, input: unknown): void {
            if (!routes.resolveAccessTargets && input && typeof input === 'object' && 'browserSessionId' in input
                && typeof input.browserSessionId === 'string') requireTarget({ browserSessionId: input.browserSessionId });
            for (const target of routes.resolveAccessTargets?.(actionId, input) ?? []) {
                const failure = failureFor(target, target.existingProfile);
                if (failure) throw new RpcError(failure.error.message, failure.error.code);
            }
        },
        allowsTarget: (target: BrowserTarget): boolean => !failureFor(target),
        allowsRecording: (recording: BrowserRecordingSessionV1): boolean => !failureFor(recording, recording),
        async requireRecording(routes: BrowserRecordingRoutes, recordingId: string) {
            // The lifecycle owner is the canonical recording→view lookup. Missing IDs retain
            // their existing not-found result; a caller never supplies the stored target.
            const recording = await routes.getRecordingStatus({ recordingId });
            const failure = recording ? failureFor(recording, recording) : undefined;
            if (failure) throw new RpcError(failure.error.message, failure.error.code);
            return recording;
        },
    };
}
