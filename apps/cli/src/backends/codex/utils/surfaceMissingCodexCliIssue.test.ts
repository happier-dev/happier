import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderCliNotFoundError } from '@/runtime/managedTools/requireProviderCliCommand';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';

import { surfaceMissingCodexCliIssue } from './surfaceMissingCodexCliIssue';

describe('surfaceMissingCodexCliIssue', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('surfaces a provider_cli_not_found session issue with remediation for a missing codex CLI', async () => {
        const session = createApiSessionClientFixture();
        const sendAgentMessage = vi.spyOn(session, 'sendAgentMessage');

        const surfaced = await surfaceMissingCodexCliIssue({
            session,
            error: new ProviderCliNotFoundError('codex'),
        });

        expect(surfaced).toBe(true);
        expect(sendAgentMessage).toHaveBeenCalledWith('codex', expect.objectContaining({
            type: 'turn_failed',
            issue: expect.objectContaining({
                code: 'provider_cli_not_found',
                source: 'dependency_failure',
            }),
        }));
    });

    it('leaves non-missing-CLI errors to their existing handling', async () => {
        const session = createApiSessionClientFixture();
        const sendAgentMessage = vi.spyOn(session, 'sendAgentMessage');

        const surfaced = await surfaceMissingCodexCliIssue({
            session,
            error: new Error('transient'),
        });

        expect(surfaced).toBe(false);
        expect(sendAgentMessage).not.toHaveBeenCalled();
    });
});
