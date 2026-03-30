import type {
  AgentRuntimeDescriptorV1,
  DirectSessionsSource,
  SessionHandoffCodexAffinity,
  SessionHandoffCodexBackendMode,
} from '@happier-dev/protocol';

export type HandoffProviderId = 'claude' | 'codex' | 'opencode';

export type HandoffResumePlan = Readonly<{
  directory: string;
  agent: HandoffProviderId;
  resume: string;
  environmentVariables?: Record<string, string>;
  transcriptStorage: 'direct' | 'persisted';
  approvedNewDirectoryCreation: true;
  codexBackendMode?: SessionHandoffCodexBackendMode;
}>; 

export type ClaudeSessionBundle = Readonly<{
  providerId: 'claude';
  remoteSessionId: string;
  transcriptBase64: string;
}>;

export type CodexSessionBundle = Readonly<{
  providerId: 'codex';
  remoteSessionId: string;
  affinity?: SessionHandoffCodexAffinity;
  files: readonly Readonly<{ relativePath: string; contentBase64: string }>[];
}>;

export type OpenCodeSessionBundle = Readonly<{
  providerId: 'opencode';
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
  agentRuntimeDescriptorV1?: AgentRuntimeDescriptorV1;
  resume: HandoffResumePlan;
}>;
