

export type McpSettingsCopy = { [K in keyof typeof en]: (typeof en)[K] };



export const en = {
    purpose: 'Tool servers your agents can call in sessions. Add a server once, then choose where it applies.',
    add: 'Add MCP server',
    addConfigure: 'Configure a server',
    addConfigureDescription: 'Enter its command or address',
    addImportJson: 'Paste a JSON config',
    addImportJsonDescription: 'From a README or another app',
    addOwnCategory: 'Add your own',
    addPresetCategory: 'Quick install',
    addFromMachine: 'Import from this machine',
    addFromMachineDescription: 'Servers other agents already use',
    searchPlaceholder: 'Search servers',
    toolsGroup: 'Tools',
    unbound: 'Not used anywhere yet',
    newServer: 'New MCP server',
    serverPurpose: 'A tool server your agents can call. Choose where it applies below.',
    addByTitle: 'Add by',
    serverSection: 'Server',
    serverSectionDescription: 'How the server is named in sessions and in this list.',
    connectionSection: 'Connection',
    connectionSectionDescription: 'How Happier starts or reaches the server.',
    envDescription: 'Values passed to the server. Use a Saved Secret for keys.',
    headersDescription: 'Sent with every request. Use a Saved Secret for tokens.',
    addRule: 'Add rule',
    discardDraft: 'Discard',
    landingTitle: 'Give your agents more tools',
    landingDescription: 'MCP servers add tools such as a browser, docs lookup or GitHub. Configure one, paste a config, or start from a preset.',
    onMachineTitle: 'Found on this machine',
    onMachinePurpose: 'MCP servers that other agents already configure on this machine. Import one to use it from Happier.',
    onMachineSearchSection: 'Where to look',
    onMachineSearchDescription: 'Agent configs in your home folder, plus a project folder if you choose one.',
    onMachineFoundSection: 'Servers',
    onMachineFoundDescription: 'Importing copies the server into Happier; the original config is not changed.',
    previewTitle: 'What sessions get',
    previewPurpose: 'Check which MCP servers a session receives for an agent and a folder, and what happens when one cannot start.',
    previewContextSection: 'Session',
    previewContextDescription: 'The agent and folder a new session would start with.',
    failurePolicyTitle: 'When a server cannot start',
    failurePolicyDescription: 'For example, when a Saved Secret it needs is missing.',
    failurePolicySkip: 'Skip it',
    failurePolicyStop: 'Stop the session',
    failureSection: 'Reliability',
    failureSectionDescription: 'Applies to every MCP server in every session.',
    previewNothingTitle: 'Nothing would be delivered',
    previewNothingDescription: 'No MCP server applies to this agent and folder. Add a server or a rule that covers them.',
    check: 'Check',
    scan: 'Scan',
};


export const mcpSettingsTranslationsEnglish = { en } as const;