import type {
  DirectSessionsSource,
  RuntimeDescriptorV1,
  SessionHandoffResumePlan,
  SessionHandoffCodexAffinity,
} from '@happier-dev/protocol';

export type HandoffProviderId = SessionHandoffResumePlan['agent'];

export const SESSION_HANDOFF_PROVIDER_BUNDLE_IDS_V1 = Object.freeze({
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
} as const);
export type SessionHandoffProviderBundleId = (typeof SESSION_HANDOFF_PROVIDER_BUNDLE_IDS_V1)[keyof typeof SESSION_HANDOFF_PROVIDER_BUNDLE_IDS_V1];

export type HandoffResumePlan = SessionHandoffResumePlan;

export type ClaudeSessionBundle = Readonly<{
  providerId: typeof SESSION_HANDOFF_PROVIDER_BUNDLE_IDS_V1.claude;
  remoteSessionId: string;
  transcriptBase64: string;
}>;

export type CodexSessionBundle = Readonly<{
  providerId: typeof SESSION_HANDOFF_PROVIDER_BUNDLE_IDS_V1.codex;
  remoteSessionId: string;
  affinity?: SessionHandoffCodexAffinity;
  files: readonly Readonly<{ relativePath: string; contentBase64: string }>[];
}>;

export type OpenCodeSessionBundle = Readonly<{
  providerId: typeof SESSION_HANDOFF_PROVIDER_BUNDLE_IDS_V1.opencode;
  remoteSessionId: string;
  exportJsonBase64: string;
  affinity: Readonly<{
    backendMode: 'server' | 'acp' | null;
    serverBaseUrl: string | null;
    serverBaseUrlExplicit: boolean;
  }>;
}>;

export type SessionHandoffProviderBundle = ClaudeSessionBundle | CodexSessionBundle | OpenCodeSessionBundle;

export type ImportedSessionHandoffBundle = Readonly<{
  remoteSessionId: string;
  directSource: DirectSessionsSource;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  resume: HandoffResumePlan;
}>;
