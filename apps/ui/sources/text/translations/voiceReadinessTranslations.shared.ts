

export type VoiceReadinessCopy = {
  ready: string;
  permissionAnnouncement: (params: { summary: string }) => string;
  userActionAnnouncement: (params: { question: string }) => string;
  userActionFallback: string;
  requestedTool: string;
  provider_unselected: string;
  contribution_unavailable: string;
  role_unsupported: string;
  platform_unsupported: string;
  settings_unsupported_version: string;
  settings_unknown: string;
  settings_needs_migration: string;
  settings_invalid: string;
  settings_missing_required_setting: (params: { service: string }) => string;
  provider_mode_unknown: string;
  server_feature_disabled: string;
  server_feature_installing: string;
  server_feature_incompatible: string;
  server_feature_unknown: string;
  execution_machine_missing: string;
  execution_machine_installing: string;
  execution_machine_incompatible: string;
  execution_machine_unknown: string;
  daemon_unreachable: string;
  daemon_relay_disabled: string;
  daemon_relay_capped: string;
  credential_missing: string;
  credential_approval_required: string;
  credential_installing: string;
  credential_incompatible: string;
  credential_unknown: string;
  endpoint_missing: string;
  endpoint_installing: string;
  endpoint_incompatible: string;
  endpoint_unknown: string;
  runtime_missing: string;
  runtime_installing: string;
  runtime_incompatible: string;
  runtime_unknown: string;
  model_missing: string;
  model_installing: string;
  model_incompatible: string;
  model_unknown: string;
  device_stt_unavailable: string;
  device_stt_availability_unknown: string;
  /** One short status for a choice in a list (a gallery tile); the full reason stays on the card. */
  short: {
    needsSetup: string;
    needsKey: string;
    needsApproval: string;
    offOnServer: string;
    needsComputer: string;
    needsAddress: string;
    needsModel: string;
    installing: string;
    notInstalled: string;
    unavailableHere: string;
    needsUpdate: string;
    cantCheck: string;
  };
  actions: {
    select_provider: string;
    open_provider_settings: string;
    select_execution_machine: string;
    configure_credential: string;
    review_credential_access: string;
    configure_endpoint: string;
    install_model: string;
    switch_provider: string;
  };
};



export function defineVoiceReadinessTranslation(readiness: VoiceReadinessCopy) {
  return { readiness };
}


export const voiceReadinessTranslationsEnglish = { en: defineVoiceReadinessTranslation({
    ready: 'Ready for Voice.',
    permissionAnnouncement: ({ summary }) => `The coding session needs permission for ${summary}. Review it in the session UI to approve or deny.`,
    userActionAnnouncement: ({ question }) => `The coding session needs your input. ${question}`,
    userActionFallback: 'The coding session needs your input. Answer the question so I can continue.',
    requestedTool: 'the requested tool',
    provider_unselected: 'Choose a Voice provider.',
    contribution_unavailable: 'This Voice provider is no longer available.',
    role_unsupported: 'This provider does not support the selected Voice mode.',
    platform_unsupported: 'This Voice provider is not available on this platform.',
    settings_unsupported_version: 'Update this provider before using it with Voice.',
    settings_unknown: 'Provider settings could not be checked.',
    settings_needs_migration: 'Review this provider’s updated settings.',
    settings_invalid: 'Review the invalid provider settings.',
    settings_missing_required_setting: ({ service }) => `Finish setting up ${service} to start.`,
    provider_mode_unknown: 'Choose a supported mode for this provider.',
    server_feature_disabled: 'This service is off on this server.',
    server_feature_installing: 'Voice support is being prepared by the server.',
    server_feature_incompatible: 'The server is incompatible with this Voice provider.',
    server_feature_unknown: 'Server support for this Voice provider could not be checked.',
    execution_machine_missing: 'Choose a computer that can run this service.',
    execution_machine_installing: 'The selected Voice execution machine is still being prepared.',
    execution_machine_incompatible: 'The selected machine is incompatible with this Voice provider.',
    execution_machine_unknown: 'The Voice execution machine could not be checked.',
    daemon_unreachable: 'The selected machine has no available route for Voice audio.',
    daemon_relay_disabled: 'The selected machine needs the Voice audio relay, but relay use is disabled.',
    daemon_relay_capped: 'Voice audio relay capacity is currently unavailable for the selected machine.',
    credential_missing: 'Add this service’s key or connect its account to start.',
    credential_approval_required: 'Review credential access before using this Voice provider.',
    credential_installing: 'The provider credential is still being prepared.',
    credential_incompatible: 'The selected credential is incompatible with this Voice provider.',
    credential_unknown: 'The provider credential could not be checked.',
    endpoint_missing: 'Add the address of the service to start.',
    endpoint_installing: 'The Voice provider endpoint is still being prepared.',
    endpoint_incompatible: 'The configured endpoint is incompatible with this Voice provider.',
    endpoint_unknown: 'The Voice provider endpoint could not be checked.',
    runtime_missing: 'Install what this service needs to run.',
    runtime_installing: 'The Voice provider runtime is still being installed.',
    runtime_incompatible: 'The installed runtime is incompatible with this Voice provider.',
    runtime_unknown: 'The Voice provider runtime could not be checked.',
    model_missing: 'Install or choose a speech model to start.',
    model_installing: 'The selected Voice model is still being installed.',
    model_incompatible: 'The selected model is incompatible with this Voice provider.',
    model_unknown: 'The Voice provider model could not be checked.',
    device_stt_unavailable: 'Speech recognition is not available on this device.',
    device_stt_availability_unknown: 'Speech recognition availability is still being checked.',
    short: {
      needsSetup: 'Needs setup',
      needsKey: 'Needs a key',
      needsApproval: 'Needs your approval',
      offOnServer: 'Off on this server',
      needsComputer: 'Needs a computer',
      needsAddress: 'Needs an address',
      needsModel: 'Needs a model',
      installing: 'Installing',
      notInstalled: 'Not installed',
      unavailableHere: 'Not available here',
      needsUpdate: 'Needs an update',
      cantCheck: 'Not checked yet',
    },
    actions: {
      select_provider: 'Choose a provider',
      open_provider_settings: "Finish setup",
      select_execution_machine: 'Choose a machine',
      configure_credential: 'Add credentials',
      review_credential_access: 'Review credential access',
      configure_endpoint: 'Configure endpoint',
      install_model: 'Install a model',
      switch_provider: 'Choose another provider',
    },
  }) } as const;