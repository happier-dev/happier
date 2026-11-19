export type ExecutionRunBackendStartContext = Readonly<{
  cwd?: string;
  capabilitySelection?: import('@happier-dev/protocol').SessionCapabilitySelectionV1;
  allowedTools?: import('@happier-dev/protocol/runtime/agentSessionV1').AgentSessionConfigurationSnapshotV1['allowedTools'];
  unlistedTools?: import('@happier-dev/protocol/runtime/agentSessionV1').AgentSessionConfigurationSnapshotV1['unlistedTools'];
  intentInput?: unknown;
  structuredInput?: import('@happier-dev/protocol').HappierStructuredInputV1;
  localInputId?: string;
  resultContract?: import('@happier-dev/protocol').ExecutionRunResultContractV1;
  retentionPolicy?: import('@happier-dev/protocol').ExecutionRunRetentionPolicy;
  intent?: import('@happier-dev/protocol').ExecutionRunIntent;
  /**
   * The accepted run's lifecycle class. It is carried here — beside the
   * retention policy it is always decided with — so runtime adapter selection
   * reads the actual lifecycle instead of inferring one from an intent name.
   */
  runClass?: import('@happier-dev/protocol').ExecutionRunClass;
  ioMode?: import('@happier-dev/protocol').ExecutionRunIoMode;
  profileId?: string;
  profileSourceCustody?: import('@happier-dev/protocol').PluginSourceCustodyV1;
  acpSessionModeId?: string;
  runtimeDescriptorV1?: import('@happier-dev/protocol').PortableRuntimeDescriptorV1;
  /**
   * Host-private projection of an already-normalized provider usage event.
   * The Execution Run controller supplies exact input correlation and durable
   * ordering; plugins never receive or implement this callback.
   */
  observeWorkflowUsage?: (input: Readonly<{
    turnId: string | null;
    observation: import('@/usage/usageObservation').UsageObservation;
  }>) => void;
}>;

export type ExecutionRunBackendIsolation = Readonly<{
  env?: Record<string, string>;
  unsetEnvKeys?: readonly string[];
  settingsPath?: string;
}>;
