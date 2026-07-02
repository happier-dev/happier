type ClaudeAuthStateSharingDescriptor = {
    providerId: 'claude';
    providerSupportStatus: 'supported';
    config: {
        supported: true;
        modes: readonly ['linked', 'copied', 'isolated'];
        entries: ReadonlyArray<{
            path: string;
            mode: 'linked_or_copied';
        }>;
    };
    state: {
        supported: true;
        modes: readonly ['isolated', 'shared'];
        entries: ReadonlyArray<{
            path: string;
            mode: 'linked';
        }>;
        sharedStatePrivacyRiskAcknowledgementRequired: true;
        symlinkUnavailableDegradePolicy: 'block_continuity';
    };
    authIsolation: {
        mode: 'materialized_home';
        secretEntries: readonly string[];
    };
};

export const claudeAuthStateSharingDescriptor: ClaudeAuthStateSharingDescriptor = {
    providerId: 'claude',
    providerSupportStatus: 'supported',
    config: {
        supported: true,
        modes: ['linked', 'copied', 'isolated'],
        entries: [
            { path: 'settings.json', mode: 'linked_or_copied' },
            { path: 'settings.local.json', mode: 'linked_or_copied' },
            { path: 'agents', mode: 'linked_or_copied' },
            { path: 'commands', mode: 'linked_or_copied' },
            { path: 'hooks', mode: 'linked_or_copied' },
            { path: 'plugins', mode: 'linked_or_copied' },
            { path: 'rules', mode: 'linked_or_copied' },
            { path: 'skills', mode: 'linked_or_copied' },
        ],
    },
    state: {
        supported: true,
        modes: ['isolated', 'shared'],
        entries: [
            { path: 'projects', mode: 'linked' },
        ],
        sharedStatePrivacyRiskAcknowledgementRequired: true,
        symlinkUnavailableDegradePolicy: 'block_continuity',
    },
    authIsolation: {
        mode: 'materialized_home',
        secretEntries: [
            'CLAUDE_CODE_OAUTH_TOKEN',
            'CLAUDE_CODE_SETUP_TOKEN',
            'CLAUDE_API_KEY',
            'ANTHROPIC_API_KEY',
            '.claude.json',
            '.credentials.json',
            'credentials.json',
            'auth.json',
            'accounts',
        ],
    },
};
