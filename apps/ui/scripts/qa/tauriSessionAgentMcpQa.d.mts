export type SessionAgentMcpQaConfig = Readonly<{
  appIdentifier: string;
  route: string;
  qualifiedAgentId: string;
  pluginId: string;
  agentLocalId: string;
  prompt: string;
  cancelPrompt: string;
  assistantText: string;
  reasoningText: string;
  selectorTimeoutMs: number;
  confirmationTimeoutMs: number;
  assistantTimeoutMs: number;
  scriptTimeoutMs: number;
  selectors: Readonly<{
    wizardOption: string;
    agentChip: string;
    chipPickerOption: string;
    newSessionComposerInput: string;
    newSessionComposerSend: string;
    sessionComposerInput: string;
    sessionComposerSend: string;
    permissionAllow: string;
    abort: string;
    forgetTrustAction: string;
  }>;
}>;

export declare function runSessionAgentMcpQa(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  config: SessionAgentMcpQaConfig;
}>): Promise<Readonly<{ artifactRoot: string }>>;

export declare function buildTestIdentifierSelector(testId: string): string;
export declare function buildNavigationScript(route: string): string;
export declare function buildPresenceProbeScript(params: Readonly<{ selector: string }>): string;
export declare function buildTextPresenceProbeScript(params: Readonly<{ text: string }>): string;
export declare function buildTextCountProbeScript(params: Readonly<{ text: string }>): string;
export declare function buildSetTextareaValueScript(params: Readonly<{ selector: string; value: string }>): string;
export declare function buildComposerEnabledProbeScript(params: Readonly<{ selector: string }>): string;
export declare function unwrapWebviewScriptValue(value: unknown): unknown;
