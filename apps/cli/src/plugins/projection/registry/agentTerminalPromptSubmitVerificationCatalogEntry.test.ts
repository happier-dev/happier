import { describe, expect, it, vi } from 'vitest';

import type {
    AgentTerminalPromptSubmitVerificationPolicyV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
    projectAgentTerminalPromptSubmitVerificationCatalogEntry,
} from './agentCatalogEntryHooks';

describe('Agent terminal prompt-submit verification catalog projection', () => {
    it('projects Agent-native prompt recognition through the existing terminal-host catalog seam', async () => {
        let current = true;
        const terminalPromptSubmitVerification = Object.freeze({
            shouldVerifyAfterSubmit: vi.fn((promptText: string) => promptText.trim().length > 0),
            verifyBeforeSubmitStaging: vi.fn(({ promptText, screenText }) => screenText.includes(promptText)),
            verifyAfterSubmit: vi.fn(({ promptText, screenText }) => screenText.includes(promptText)),
        }) satisfies AgentTerminalPromptSubmitVerificationPolicyV1;

        const hooks = projectAgentTerminalPromptSubmitVerificationCatalogEntry({
            terminalPromptSubmitVerification,
            isCurrent: () => current,
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

        current = false;
        await expect(hooks.getTerminalPromptSubmitVerificationPolicy?.()).resolves.toBeNull();
        expect(policy?.shouldVerifyAfterSubmit('retained')).toBe(false);
        expect(policy?.verifyBeforeSubmitStaging?.({
            promptText: 'retained',
            screenText: 'retained',
        })).toBe(false);
        expect(policy?.verifyAfterSubmit({
            promptText: 'retained',
            screenText: 'retained',
        })).toBe(false);
        expect(terminalPromptSubmitVerification.shouldVerifyAfterSubmit).toHaveBeenCalledTimes(1);
        expect(terminalPromptSubmitVerification.verifyBeforeSubmitStaging).toHaveBeenCalledTimes(1);
        expect(terminalPromptSubmitVerification.verifyAfterSubmit).toHaveBeenCalledTimes(1);
    });
});
