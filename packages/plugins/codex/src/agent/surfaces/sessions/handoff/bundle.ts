import type {
  ExternalSessionsSource,
  RuntimeDescriptorV1,
  SessionHandoffCodexAffinity,
  SessionHandoffResumePlan,
} from '@happier-dev/protocol';

export type CodexSessionHandoffBundle = Readonly<{
  providerId: 'codex';
  remoteSessionId: string;
  affinity?: SessionHandoffCodexAffinity;
  files: readonly Readonly<{ relativePath: string; contentBase64: string }>[];
}>;

export type ImportedCodexSessionHandoffBundle = Readonly<{
  remoteSessionId: string;
  externalSource: ExternalSessionsSource;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  resume: SessionHandoffResumePlan;
}>;
