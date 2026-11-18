import type { IrohNodeMachineHttpObservation } from '@happier-dev/iroh-native/node';
import { SessionRuntimeTeamCredentialDenialDetailsV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { PROVIDER_BROKER_APPLICATION_CONTROL_HEADERS, readTrustedProviderBrokerApplicationFailure, type SessionBrokerApplicationOutcomeRecorder } from './providerBrokerApplicationFailure';

/** The target's existing refusal writer owns these headers. Native forwards
 * only their metadata; Provider content and credentials never enter this path. */
export const SESSION_BROKER_OBSERVED_RESPONSE_HEADERS = PROVIDER_BROKER_APPLICATION_CONTROL_HEADERS;

export function createSessionBrokerHttpObserver(input: Readonly<{
  resourceId: string;
  beginRequest(): SessionBrokerApplicationOutcomeRecorder | undefined;
}>): (event: IrohNodeMachineHttpObservation) => Promise<void> {
  const connections = new Map<string, Map<string, SessionBrokerApplicationOutcomeRecorder>>();
  return async event => {
    if (event.kind === 'closed') { connections.delete(event.connectionId); return; }
    if (event.kind === 'request') {
      const recorder = input.beginRequest();
      if (recorder) {
        let requests = connections.get(event.connectionId);
        if (!requests) { requests = new Map(); connections.set(event.connectionId, requests); }
        requests.set(event.requestId, recorder);
      }
      return;
    }
    const requests = connections.get(event.connectionId);
    const recordOutcome = requests?.get(event.requestId);
    requests?.delete(event.requestId);
    if (requests?.size === 0) connections.delete(event.connectionId);
    if (!recordOutcome) return;
    const failure = readTrustedProviderBrokerApplicationFailure(event.status, event.headers);
    const denial = failure ? SessionRuntimeTeamCredentialDenialDetailsV1Schema.safeParse({
      v: 1, resourceId: input.resourceId, reasonCode: failure.reasonCode,
      ...(failure.usageLimit ? { usageLimit: failure.usageLimit } : {}),
    }) : null;
    recordOutcome(denial?.success ? denial.data : null);
  };
}
