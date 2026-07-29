import { describe, expect, it } from 'vitest';

import { resolveVoiceToolResultHumanSummary } from './resolveVoiceToolResultHumanSummary';

describe('resolveVoiceToolResultHumanSummary', () => {
    it('mentions when more sessions are available after the current page', () => {
        const summary = resolveVoiceToolResultHumanSummary({
            toolName: 'listSessions',
            toolInput: {},
            toolResult: {
                ok: true,
                sessions: [
                    { id: 'sess_alpha', title: 'Voice Target Alpha' },
                    { id: 'sess_beta', title: 'Voice Tracked Beta' },
                ],
                nextCursor: 'cursor:next',
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        expect(summary).toContain('Voice Target Alpha');
        expect(summary).toContain('Voice Tracked Beta');
        expect(summary).toContain('There are more sessions available');
        expect(summary).not.toContain('sess_alpha');
        expect(summary).not.toContain('sess_beta');
    });

    it('keeps duplicate session titles distinguishable with human-readable location labels', () => {
        const summary = resolveVoiceToolResultHumanSummary({
            toolName: 'listSessions',
            toolInput: {},
            toolResult: {
                ok: true,
                sessions: [
                    { id: 'sess_a', title: 'leeroy', serverName: 'Leeroys-MBP', locationLabel: '~' },
                    { id: 'sess_b', title: 'leeroy', serverName: 'Leeroys-MacBook-Pro.local', locationLabel: 'voice-agent' },
                ],
                nextCursor: null,
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        expect(summary).toContain('leeroy on Leeroys-MBP');
        expect(summary).toContain('leeroy on Leeroys-MacBook-Pro.local');
        expect(summary).not.toContain('sess_a');
        expect(summary).not.toContain('sess_b');
    });

    it('prefers recent path labels over raw ids', () => {
        const summary = resolveVoiceToolResultHumanSummary({
            toolName: 'listRecentPaths',
            toolInput: {},
            toolResult: {
                ok: true,
                items: [
                    { label: 'Payments workspace' },
                    { label: 'Mobile workspace' },
                ],
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        expect(summary).toContain('Payments workspace');
        expect(summary).toContain('Mobile workspace');
    });

    it('keeps duplicate path names distinguishable with path tails', () => {
        const summary = resolveVoiceToolResultHumanSummary({
            toolName: 'listRecentPaths',
            toolInput: {},
            toolResult: {
                ok: true,
                items: [
                    { label: 'apps/leeroy — A host' },
                    { label: 'docs/leeroy — A host' },
                ],
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        expect(summary).toContain('apps/leeroy — A host');
        expect(summary).toContain('docs/leeroy — A host');
    });

    it('prefers backend and model labels over raw ids', () => {
        const backendSummary = resolveVoiceToolResultHumanSummary({
            toolName: 'listAgentBackends',
            toolInput: {},
            toolResult: {
                ok: true,
                items: [
                    { agentId: 'claude_internal', label: 'Claude Sonnet' },
                    { agentId: 'codex_internal', label: 'Codex GPT-5' },
                ],
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        const modelSummary = resolveVoiceToolResultHumanSummary({
            toolName: 'listAgentModels',
            toolInput: { agentId: 'claude_internal' },
            toolResult: {
                ok: true,
                items: [
                    { modelId: 'model_alpha', label: 'Sonnet 4.5' },
                    { modelId: 'model_beta', label: 'Haiku 4.5' },
                ],
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        expect(backendSummary).toContain('Claude Sonnet');
        expect(backendSummary).toContain('Codex GPT-5');
        expect(backendSummary).not.toContain('claude_internal');
        expect(backendSummary).not.toContain('codex_internal');

        expect(modelSummary).toContain('Sonnet 4.5');
        expect(modelSummary).toContain('Haiku 4.5');
        expect(modelSummary).not.toContain('model_alpha');
        expect(modelSummary).not.toContain('model_beta');
    });

    it('uses configured ACP backend ids instead of generic customAcp in model summaries', () => {
        const modelSummary = resolveVoiceToolResultHumanSummary({
            toolName: 'listAgentModels',
            toolInput: { backendTargetKey: 'acpBackend:review-bot' },
            toolResult: {
                ok: true,
                agentId: 'customAcp',
                items: [
                    { modelId: 'model_alpha', label: 'Review Alpha' },
                    { modelId: 'model_beta', label: 'Review Beta' },
                ],
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        expect(modelSummary).toContain('Available Review bot models');
        expect(modelSummary).not.toContain('custom Acp');
    });

    it('uses canonical V2 backend target keys instead of generic customAcp in model summaries', () => {
        const modelSummary = resolveVoiceToolResultHumanSummary({
            toolName: 'listAgentModels',
            toolInput: { backendTargetKey: 'backend:review-bot:configured:review-bot' },
            toolResult: {
                ok: true,
                agentId: 'customAcp',
                items: [
                    { modelId: 'model_alpha', label: 'Review Alpha' },
                    { modelId: 'model_beta', label: 'Review Beta' },
                ],
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        expect(modelSummary).toContain('Available Review bot models');
        expect(modelSummary).not.toContain('custom Acp');
    });

    it('prefers server labels over raw ids', () => {
        const summary = resolveVoiceToolResultHumanSummary({
            toolName: 'listServers',
            toolInput: {},
            toolResult: {
                ok: true,
                items: [
                    { serverId: 'server-a', label: 'Primary Server' },
                    { serverId: 'server-b', label: 'Review Server' },
                ],
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        expect(summary).toContain('Primary Server');
        expect(summary).toContain('Review Server');
        expect(summary).not.toContain('server-a');
        expect(summary).not.toContain('server-b');
    });

    it('keeps generic server fallback labels human-friendly and id-free', () => {
        const summary = resolveVoiceToolResultHumanSummary({
            toolName: 'listServers',
            toolInput: {},
            toolResult: {
                ok: true,
                items: [
                    { serverId: 'server-a', label: 'Current server' },
                    { serverId: 'server-b', label: 'Connected server 1' },
                    { serverId: 'server-c', label: 'Connected server 2' },
                ],
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        expect(summary).toContain('Current server');
        expect(summary).toContain('Connected server 1');
        expect(summary).toContain('Connected server 2');
        expect(summary).not.toContain('server-a');
        expect(summary).not.toContain('server-b');
        expect(summary).not.toContain('server-c');
    });

    it('prefers session titles over ids for session-selection actions', () => {
        const openedSummary = resolveVoiceToolResultHumanSummary({
            toolName: 'openSession',
            toolInput: {},
            toolResult: {
                ok: true,
                sessionId: 'sess_123',
                session: {
                    id: 'sess_123',
                    title: 'Payments bugfix',
                    serverName: 'Server B',
                },
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        const trackedSummary = resolveVoiceToolResultHumanSummary({
            toolName: 'setTrackedSessions',
            toolInput: {},
            toolResult: {
                ok: true,
                sessionIds: ['sess_123', 'sess_456'],
                sessions: [
                    { id: 'sess_123', title: 'Payments bugfix' },
                    { id: 'sess_456', title: 'Mobile release' },
                ],
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        expect(openedSummary).toContain('Payments bugfix');
        expect(openedSummary).toContain('Server B');
        expect(openedSummary).not.toContain('sess_123');

        expect(trackedSummary).toContain('Payments bugfix');
        expect(trackedSummary).toContain('Mobile release');
        expect(trackedSummary).not.toContain('sess_123');
        expect(trackedSummary).not.toContain('sess_456');
    });

    it('redacts repo-relative location labels when shareFilePaths is false', () => {
        const summary = resolveVoiceToolResultHumanSummary({
            toolName: 'listSessions',
            toolInput: {},
            toolResult: {
                ok: true,
                sessions: [
                    { id: 'sess_a', title: 'Payments bugfix', serverName: 'Server A', locationLabel: 'apps/ui/sources/voice' },
                    { id: 'sess_b', title: 'Payments bugfix', serverName: 'Server B', locationLabel: 'docs/voice' },
                ],
            },
            shareFilePaths: false,
            shareSessionSummary: true,
        });

        expect(summary).toContain('Payments bugfix');
        expect(summary).toContain('<path_redacted>');
        expect(summary).not.toContain('apps/ui/sources/voice');
    });

    it('redacts recent path labels when shareFilePaths is false', () => {
        const summary = resolveVoiceToolResultHumanSummary({
            toolName: 'listRecentPaths',
            toolInput: {},
            toolResult: {
                ok: true,
                items: [
                    { label: 'apps/ui/sources/voice/runVoiceAgentTurnWithTools.ts' },
                ],
            },
            shareFilePaths: false,
            shareSessionSummary: true,
        });

        expect(summary).toContain('<path_redacted>');
        expect(summary).not.toContain('runVoiceAgentTurnWithTools.ts');
    });

    it.each([undefined, null, 'true', 1, {}, []])(
        'fails closed for omitted or malformed shareFilePaths=%p',
        (shareFilePaths) => {
            const params: Record<string, unknown> = {
                toolName: 'listRecentPaths',
                toolInput: {},
                toolResult: {
                    items: [{ label: '/Users/alice/Company/PrivateProject/README.md' }],
                },
                shareSessionSummary: true,
            };
            if (shareFilePaths !== undefined) {
                params.shareFilePaths = shareFilePaths;
            }

            const summary = Reflect.apply(resolveVoiceToolResultHumanSummary, undefined, [params]);
            expect(summary).toContain('<path_redacted>');
            expect(summary).not.toContain('/Users/alice/Company/PrivateProject/README.md');
        },
    );

    it('suppresses session summary titles in listSessions when shareSessionSummary is false', () => {
        const summary = resolveVoiceToolResultHumanSummary({
            toolName: 'listSessions',
            toolInput: {},
            toolResult: {
                ok: true,
                sessions: [
                    { id: 'sess_a', title: 'Refactor the payments billing flow', serverName: 'Server A' },
                    { id: 'sess_b', title: 'Investigate the flaky auth test', serverName: 'Server B' },
                ],
                nextCursor: null,
            },
            shareFilePaths: true,
            shareSessionSummary: false,
        });

        expect(summary ?? '').not.toContain('Refactor the payments billing flow');
        expect(summary ?? '').not.toContain('Investigate the flaky auth test');
    });

    it('suppresses the opened session summary title when shareSessionSummary is false', () => {
        const summary = resolveVoiceToolResultHumanSummary({
            toolName: 'openSession',
            toolInput: {},
            toolResult: {
                ok: true,
                sessionId: 'sess_123',
                session: {
                    id: 'sess_123',
                    title: 'Secret roadmap planning',
                    serverName: 'Server B',
                },
            },
            shareFilePaths: true,
            shareSessionSummary: false,
        });

        expect(summary ?? '').not.toContain('Secret roadmap planning');
    });

    it.each([undefined, null, false, 'true', 1, {}, []])(
        'fails closed for disabled, omitted, or malformed shareSessionSummary=%p across every session-summary path',
        (shareSessionSummary) => {
            const invokeFromUntypedBoundary = (params: unknown): string | null => (
                Reflect.apply(resolveVoiceToolResultHumanSummary, undefined, [params])
            );
            const cases = [
                {
                    toolName: 'listSessions',
                    toolResult: { sessions: [{ title: 'Private list title' }] },
                },
                {
                    toolName: 'openSession',
                    toolResult: { session: { title: 'Private open title' } },
                },
                {
                    toolName: 'setPrimaryActionSession',
                    toolResult: { session: { title: 'Private reference title' } },
                },
                {
                    toolName: 'spawnSession',
                    toolResult: {
                        session: { title: 'Private spawned title' },
                        target: { label: 'Allowed target label' },
                    },
                },
                {
                    toolName: 'listSessions',
                    toolResult: { summary: 'Private explicit summary' },
                },
            ] as const;

            for (const testCase of cases) {
                const params: Record<string, unknown> = {
                    ...testCase,
                    toolInput: {},
                    shareFilePaths: true,
                };
                if (shareSessionSummary !== undefined) {
                    params.shareSessionSummary = shareSessionSummary;
                }
                const summary = invokeFromUntypedBoundary(params);
                expect(summary ?? '').not.toContain('Private');
            }
        },
    );

    it('surfaces session titles and explicit summaries only when shareSessionSummary is literally true', () => {
        const sessionSummary = resolveVoiceToolResultHumanSummary({
            toolName: 'listSessions',
            toolInput: {},
            toolResult: {
                ok: true,
                sessions: [{ id: 'sess_a', title: 'Payments bugfix' }],
                nextCursor: null,
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });
        const explicitSummary = resolveVoiceToolResultHumanSummary({
            toolName: 'listSessions',
            toolInput: {},
            toolResult: { summary: 'Done working on the payments session' },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        expect(sessionSummary).toContain('Payments bugfix');
        expect(explicitSummary).toBe('Done working on the payments session');
    });

    it('gates an explicit result.summary on shareSessionSummary, not just shareFilePaths (X-L1)', () => {
        const summary = resolveVoiceToolResultHumanSummary({
            toolName: 'listSessions',
            toolInput: {},
            toolResult: {
                ok: true,
                summary: 'Working on the secret roadmap planning session',
            },
            shareFilePaths: true,
            shareSessionSummary: false,
        });

        expect(summary).toBeNull();
    });

    it('still surfaces an explicit result.summary when shareSessionSummary is enabled', () => {
        const summary = resolveVoiceToolResultHumanSummary({
            toolName: 'listSessions',
            toolInput: {},
            toolResult: {
                ok: true,
                summary: 'Done working on the payments session',
            },
            shareFilePaths: true,
            shareSessionSummary: true,
        });

        expect(summary).toBe('Done working on the payments session');
    });
});
