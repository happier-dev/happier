import { describe, expect, it } from 'vitest';

import { claudeAuthStateSharingDescriptor } from './stateSharing.js';

describe('claudeAuthStateSharingDescriptor', () => {
    it('preserves isolated auth and shared project-state policy for Claude Code', () => {
        expect(claudeAuthStateSharingDescriptor).toMatchObject({
            providerId: 'claude',
            providerSupportStatus: 'supported',
            config: {
                supported: true,
                modes: ['linked', 'copied', 'isolated'],
            },
            state: {
                supported: true,
                modes: ['isolated', 'shared'],
                sharedStatePrivacyRiskAcknowledgementRequired: true,
                symlinkUnavailableDegradePolicy: 'block_continuity',
            },
            authIsolation: {
                mode: 'materialized_home',
                secretEntries: expect.arrayContaining([
                    'CLAUDE_CODE_OAUTH_TOKEN',
                    'CLAUDE_CODE_SETUP_TOKEN',
                    'ANTHROPIC_API_KEY',
                    '.credentials.json',
                ]),
            },
        });
    });
});
