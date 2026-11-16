import type { IrohNodeMachineHttpObservation } from '@happier-dev/iroh-native/node';
import {
  PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER,
  PROVIDER_BROKER_APPLICATION_LIMIT_METRIC_HEADER,
  PROVIDER_BROKER_APPLICATION_LIMIT_REMAINING_HEADER,
  PROVIDER_BROKER_APPLICATION_LIMIT_RESETS_AT_HEADER,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { SessionRuntimeTeamCredentialDenialDetailsV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { TeamCredentialUsageLimitDenialV1Schema } from '@happier-dev/protocol/teams/credentials/usageV1';
import type { SessionBrokerApplicationOutcomeRecorder } from './providerBrokerApplicationFailure';

/** The target's existing refusal writer owns these headers. Native forwards
 * only their metadata; Provider content and credentials never enter this path. */
export const SESSION_BROKER_OBSERVED_RESPONSE_HEADERS = [
  PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER,
  PROVIDER_BROKER_APPLICATION_LIMIT_METRIC_HEADER,
  PROVIDER_BROKER_APPLICATION_LIMIT_REMAINING_HEADER,
  PROVIDER_BROKER_APPLICATION_LIMIT_RESETS_AT_HEADER,
] as const;

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
    const reasonCode = event.headers[PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER];
    const usageLimit = reasonCode === 'team_credential_usage_limit' ? TeamCredentialUsageLimitDenialV1Schema.safeParse({
      metric: event.headers[PROVIDER_BROKER_APPLICATION_LIMIT_METRIC_HEADER],
      remaining: event.headers[PROVIDER_BROKER_APPLICATION_LIMIT_REMAINING_HEADER],
      resetsAtUtc: event.headers[PROVIDER_BROKER_APPLICATION_LIMIT_RESETS_AT_HEADER],
    }) : null;
    const denial = event.status >= 400 ? SessionRuntimeTeamCredentialDenialDetailsV1Schema.safeParse({
      v: 1, resourceId: input.resourceId, reasonCode,
      ...(usageLimit?.success ? { usageLimit: usageLimit.data } : {}),
    }) : null;
    recordOutcome(denial?.success ? denial.data : null);
  };
}
