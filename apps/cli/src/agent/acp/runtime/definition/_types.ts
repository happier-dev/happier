import type {
  AcpAuthSpecV1,
  AcpBackendSpecV1,
  AcpBootstrapV1,
  AcpCapabilityFlagsV1,
  AcpMcpInputPolicyV1,
  AcpMessageMetaHooksV1,
  AcpPermissionOptionSelectionV1,
  AcpPermissionModeArgvSpecV1,
  AcpStderrRulesV1,
  AcpTier2ArgvBuilderV1,
  AcpTier2EnvBuilderV1,
  AcpTier2PermissionDecisionV1,
  AcpTier2PreflightV1,
  AcpTimeoutsV1,
  AcpToolNameInferenceV1,
  AcpToolNameResolverV1,
  AcpTransportSpecV1,
  ExecRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

export type AcpRuntimeDefinitionSourceV1 =
  | Readonly<{
      kind: 'built_in';
      pluginId?: never;
      legacyCarrier?: never;
    }>
  | Readonly<{
      kind: 'account_configured';
      pluginId?: never;
      legacyCarrier?: 'customAcp';
    }>
  | Readonly<{
      kind: 'plugin_contributed';
      pluginId?: string;
      legacyCarrier?: never;
    }>;

export type AcpRuntimeDefinitionV1 = Readonly<{
  backendId: string;
  source: AcpRuntimeDefinitionSourceV1;
  identity: Readonly<{
    agentId?: string;
    backendId: string;
  }>;
  engine: Readonly<{
    kind: 'acp';
  }>;
  ux: Readonly<{
    name?: string;
    title: string;
    description?: string;
    defaultMode?: string;
    defaultModel?: string;
  }>;
  transport: AcpTransportSpecV1;
  launchEnv: Readonly<Record<string, string>>;
  capabilities: AcpCapabilityFlagsV1;
  timeouts?: AcpTimeoutsV1;
  auth?: AcpAuthSpecV1;
  fsEnabled?: boolean;
  transportLifecycle?: AcpBackendSpecV1['transportLifecycle'];
  permissionModeArgv?: AcpPermissionModeArgvSpecV1;
  sessionIdHeaderName?: string;
  toolNameInference?: AcpToolNameInferenceV1;
  stderrRules?: AcpStderrRulesV1;
  permissionOptionSelection?: AcpPermissionOptionSelectionV1;
  bootstrap?: AcpBootstrapV1;
  messageMeta?: AcpMessageMetaHooksV1;
  mcp: AcpMcpInputPolicyV1;
  callbacks: Readonly<{
    argvBuilder?: AcpTier2ArgvBuilderV1;
    envBuilder?: AcpTier2EnvBuilderV1;
    preflight?: AcpTier2PreflightV1;
    permissionDecision?: AcpTier2PermissionDecisionV1;
    toolNameResolver?: AcpToolNameResolverV1;
  }>;
}>;

export type AcpRuntimeDefinitionInitV1 = Readonly<{
  backendId: string;
  source: AcpRuntimeDefinitionSourceV1;
  identity?: Readonly<{
    agentId?: string;
    backendId?: string;
  }>;
  ux: AcpRuntimeDefinitionV1['ux'];
  transport: AcpTransportSpecV1;
  launchEnv?: Readonly<Record<string, string>>;
  capabilities?: AcpCapabilityFlagsV1;
  timeouts?: AcpTimeoutsV1;
  auth?: AcpAuthSpecV1;
  fsEnabled?: boolean;
  transportLifecycle?: AcpBackendSpecV1['transportLifecycle'];
  permissionModeArgv?: AcpPermissionModeArgvSpecV1;
  sessionIdHeaderName?: string;
  toolNameInference?: AcpToolNameInferenceV1;
  stderrRules?: AcpStderrRulesV1;
  permissionOptionSelection?: AcpPermissionOptionSelectionV1;
  bootstrap?: AcpBootstrapV1;
  messageMeta?: AcpMessageMetaHooksV1;
  mcp?: AcpMcpInputPolicyV1;
  callbacks?: AcpRuntimeDefinitionV1['callbacks'];
}>;

export type AcpRuntimeDefinitionBridgeV1 = Readonly<{
  exec: Pick<ExecRuntimeServiceV1, 'systemTools'>;
  createDefinition(params: Readonly<{
    cwd: string;
    env?: Readonly<Record<string, string | undefined>>;
  }>): AcpRuntimeDefinitionV1;
}>;
