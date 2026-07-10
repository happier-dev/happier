import type {
  ExternalSessionsSource,
  RuntimeDescriptorV1,
  SessionHandoffResumePlan,
} from '@happier-dev/protocol';

export type HandoffProviderId = SessionHandoffResumePlan['agent'];

export type HandoffResumePlan = SessionHandoffResumePlan;

export type SessionHandoffAgentBundle = Readonly<{
  agentId: string;
} & Record<string, unknown>>;

export type ImportedSessionHandoffBundle = Readonly<{
  remoteSessionId: string;
  directSource: ExternalSessionsSource;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  resume: HandoffResumePlan;
}>;
