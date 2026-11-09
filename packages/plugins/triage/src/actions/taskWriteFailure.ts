import { isPluginActionHandlerInvocationNotStartedAdvisory } from '@happier-dev/plugin-sdk/actions';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { TriageTaskWriteResultV1 } from '@happier-dev/triage-protocol/v1';

/** Translate only failures received from the host Action transport, which owns dispatch evidence. */
export function triageTaskWriteInvocationFailureV1(error: unknown): TriageTaskWriteResultV1 {
    if (!isPluginError(error)) return { kind: 'uncertain' };
    if (isPluginActionHandlerInvocationNotStartedAdvisory(error)) {
        return { kind: 'refused', reason: error.code };
    }
    return { kind: 'uncertain', failure: { class: 'unknown', code: error.code } };
}
