import { describe, expect, it } from 'vitest';

import type {
    AgentTerminalPromptSubmitVerificationPolicyV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
    projectAgentTerminalPromptSubmitVerificationCatalogEntry,
} from './agentCatalogEntryHooks';

describe('Agent terminal prompt-submit verification catalog projection', () => {
    it('projects Agent-native prompt recognition through the existing terminal-host catalog seam', async () => {
        const terminalPromptSubmitVerification = Object.freeze({
            shouldVerifyAfterSubmit: (promptText: string) => promptText.trim().length > 0,
            verifyBeforeSubmitStaging: ({ promptText, screenText }) => screenText.includes(promptText),
            verifyAfterSubmit: ({ promptText, screenText }) => screenText.includes(promptText),
        }) satisfies AgentTerminalPromptSubmitVerificationPolicyV1;

        const hooks = projectAgentTerminalPromptSubmitVerificationCatalogEntry({
            terminalPromptSubmitVerification,
        });
        const policy = await hooks.getTerminalPromptSubmitVerificationPolicy?.();

        expect(policy?.shouldVerifyAfterSubmit('continue')).toBe(true);
        expect(policy?.verifyBeforeSubmitStaging?.({
            promptText: 'continue',
            screenText: 'continue',
        })).toBe(true);
        expect(policy?.verifyAfterSubmit({
            promptText: 'continue',
            screenText: 'continue',
        })).toBe(true);
    });
});
