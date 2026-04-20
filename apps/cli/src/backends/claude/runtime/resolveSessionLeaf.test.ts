import { describe, expect, it, vi } from 'vitest';

import { resolveClaudeRuntimeSessionLeaf } from './resolveSessionLeaf';

describe('resolveClaudeRuntimeSessionLeaf', () => {
    it('materializes a terminal Claude session leaf by default', () => {
        const settings = { claudeRemoteAgentSdkEnabled: true };
        const buildOutgoingMessageMetaExtras = vi.fn(() => ({
            claudeRemoteAgentSdkEnabled: 'from-enricher',
        }));

        const leaf = resolveClaudeRuntimeSessionLeaf({
            credentials: { token: 't' },
            startedBy: 'terminal',
            accountSettingsContext: { settings },
            providerMessageMetaEnricher: {
                buildOutgoingMessageMetaExtras,
            },
        });

        expect(leaf).toEqual({
            kind: 'claudeTerminalSessionRuntimeLeaf',
            credentials: { token: 't' },
            startOptions: expect.objectContaining({
                startedBy: 'terminal',
                startingMode: 'terminal',
                accountSettings: settings,
                claudeRemoteMetaDefaults: {
                    claudeRemoteAgentSdkEnabled: 'from-enricher',
                },
            }),
        });
        expect(buildOutgoingMessageMetaExtras).toHaveBeenCalledWith(settings);
    });

    it('normalizes the legacy local alias to terminal mode', () => {
        const leaf = resolveClaudeRuntimeSessionLeaf({
            credentials: { token: 't' },
            startedBy: 'terminal',
            startingMode: 'local',
        });

        expect(leaf).toEqual({
            kind: 'claudeTerminalSessionRuntimeLeaf',
            credentials: { token: 't' },
            startOptions: expect.objectContaining({
                startedBy: 'terminal',
                startingMode: 'terminal',
            }),
        });
    });

    it('materializes a remote Claude session leaf when starting in remote mode', () => {
        const leaf = resolveClaudeRuntimeSessionLeaf({
            credentials: { token: 't' },
            startedBy: 'daemon',
            startingMode: 'remote',
        });

        expect(leaf).toEqual({
            kind: 'claudeRemoteSessionRuntimeLeaf',
            credentials: { token: 't' },
            startOptions: expect.objectContaining({
                startedBy: 'daemon',
                startingMode: 'remote',
            }),
        });
    });
});
