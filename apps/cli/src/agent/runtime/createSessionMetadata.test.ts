import { describe, expect, it } from 'vitest';

import { createSessionMetadata } from './createSessionMetadata';

describe('createSessionMetadata', () => {
    it('does not seed legacy messageQueueV1 metadata', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-1',
            startedBy: 'terminal',
        });

        expect((metadata as any).messageQueueV1).toBeUndefined();
    });

    it('seeds acpSessionModeOverrideV1 when agentModeId is provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'opencode',
            machineId: 'machine-1',
            startedBy: 'terminal',
            agentModeId: 'plan',
            agentModeUpdatedAt: 123,
        } as any);

        expect((metadata as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 123, modeId: 'plan' });
        expect((metadata as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 123, modeId: 'plan' });
    });

    it('seeds modelOverrideV1 when modelId is provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'terminal',
            modelId: 'gpt-5-codex-high',
            modelUpdatedAt: 123,
        } as any);

        expect((metadata as any).modelOverrideV1).toEqual({ v: 1, updatedAt: 123, modelId: 'gpt-5-codex-high' });
    });

    it('seeds sessionConfigOptionOverridesV1 from the daemon-provided environment override', () => {
        const previous = process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON;
        process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = JSON.stringify({
            v: 1,
            updatedAt: 123,
            overrides: {
                speed: { updatedAt: 123, value: 'fast' },
            },
        });

        try {
            const { metadata } = createSessionMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            } as any);

            expect((metadata as any).sessionConfigOptionOverridesV1).toEqual({
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            });
            expect((metadata as any).acpConfigOptionOverridesV1).toEqual({
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            });
            expect(process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON).toBeUndefined();
        } finally {
            if (previous === undefined) {
                delete process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON;
            } else {
                process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = previous;
            }
        }
    });

    it('ignores non-string config option values when seeding daemon-provided overrides', () => {
        const previous = process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON;
        process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = JSON.stringify({
            v: 1,
            updatedAt: 123,
            overrides: {
                speed: { updatedAt: 123, value: 'fast' },
                telemetry: { updatedAt: 124, value: true },
            },
        });

        try {
            const { metadata } = createSessionMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            } as any);

            expect((metadata as any).sessionConfigOptionOverridesV1).toEqual({
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            });
            expect((metadata as any).acpConfigOptionOverridesV1).toEqual({
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            });
        } finally {
            if (previous === undefined) {
                delete process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON;
            } else {
                process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = previous;
            }
        }
    });

    it('seeds sessionLogPath for developer log discovery', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-1',
            startedBy: 'terminal',
        } as any);

        expect(typeof (metadata as any).sessionLogPath).toBe('string');
        expect((metadata as any).sessionLogPath).toContain('/logs/');
        expect((metadata as any).sessionLogPath).toContain('.log');
    });

    it('seeds mcpSelectionV1 from the daemon-provided environment override', () => {
        const previous = process.env.HAPPIER_SESSION_MCP_SELECTION_JSON;
        process.env.HAPPIER_SESSION_MCP_SELECTION_JSON = JSON.stringify({
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['server-a'],
            forceExcludeServerIds: ['server-b'],
        });

        try {
            const { metadata } = createSessionMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            } as any);

            expect((metadata as any).mcpSelectionV1).toEqual({
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['server-a'],
                forceExcludeServerIds: ['server-b'],
            });
            expect(process.env.HAPPIER_SESSION_MCP_SELECTION_JSON).toBeUndefined();
        } finally {
            if (previous === undefined) {
                delete process.env.HAPPIER_SESSION_MCP_SELECTION_JSON;
            } else {
                process.env.HAPPIER_SESSION_MCP_SELECTION_JSON = previous;
            }
        }
    });

    it('seeds acpTransportV1 when acpProviderId is provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'opencode',
            machineId: 'machine-1',
            startedBy: 'terminal',
            acpProviderId: 'opencode',
        } as any);

        expect((metadata as any).acpTransportV1).toEqual({
            v: 1,
            provider: 'opencode',
        });
    });

    it('preserves arbitrary configured ACP flavor ids', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'acp:custom-kiro',
            machineId: 'machine-1',
            startedBy: 'terminal',
        } as any);

        expect(metadata.flavor).toBe('acp:custom-kiro');
    });

    it('uses the explicit directory for the session path when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'terminal',
            directory: '/tmp/happier-explicit-directory',
        } as any);

        expect(metadata.path).toBe('/tmp/happier-explicit-directory');
    });
});
