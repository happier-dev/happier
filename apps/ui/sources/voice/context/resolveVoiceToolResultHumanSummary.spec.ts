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
        });

        expect(summary).toContain('<path_redacted>');
        expect(summary).not.toContain('runVoiceAgentTurnWithTools.ts');
    });
});
