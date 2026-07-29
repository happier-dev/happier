import { describe, expect, it } from 'vitest';

import {
    completeActiveAgentSetupStep,
    createAgentSetupQueueState,
    createAgentSetupQueueStateFromInstallSummary,
    failActiveAgentSetupStep,
    markActiveAgentSetupStepFailed,
    skipActiveAgentSetupStep,
} from './agentSetupQueue';

describe('agentSetupQueue', () => {
    it('starts with the selected providers in a stable sequential queue', () => {
        expect(createAgentSetupQueueState(['codex', 'claude', 'gemini'])).toEqual({
            activeProviderId: 'codex',
            completedProviderIds: [],
            failedAgentIds: [],
            pendingProviderIds: ['claude', 'gemini'],
        });
    });

    it('advances to the next provider after completing the active setup step', () => {
        const initial = createAgentSetupQueueState(['codex', 'claude']);

        expect(completeActiveAgentSetupStep(initial)).toEqual({
            activeProviderId: 'claude',
            completedProviderIds: ['codex'],
            failedAgentIds: [],
            pendingProviderIds: [],
        });
    });

    it('can skip a blocked provider without breaking the remaining queue order', () => {
        const initial = createAgentSetupQueueState(['codex', 'claude', 'gemini']);

        expect(skipActiveAgentSetupStep(initial)).toEqual({
            activeProviderId: 'claude',
            completedProviderIds: [],
            failedAgentIds: [],
            pendingProviderIds: ['gemini'],
            skippedProviderIds: ['codex'],
        });
    });

    it('records a failed provider while keeping the remaining queue order', () => {
        const initial = createAgentSetupQueueState(['codex', 'claude', 'gemini']);

        expect(failActiveAgentSetupStep(initial)).toEqual({
            activeProviderId: 'claude',
            completedProviderIds: [],
            failedAgentIds: ['codex'],
            pendingProviderIds: ['gemini'],
        });
    });

    it('can mark the active provider as failed without advancing the queue (so the user can decide to skip)', () => {
        const initial = createAgentSetupQueueState(['codex', 'claude']);

        expect(markActiveAgentSetupStepFailed(initial)).toEqual({
            activeProviderId: 'codex',
            completedProviderIds: [],
            failedAgentIds: ['codex'],
            pendingProviderIds: ['claude'],
        });
    });

    it('preserves failed providers when seeding the queue from an install summary', () => {
        expect(createAgentSetupQueueStateFromInstallSummary({
            selectedAgentIds: ['codex', 'claude', 'gemini'],
            installedAgentIds: ['codex', 'gemini'],
            failedAgentIds: ['claude'],
        })).toEqual({
            activeProviderId: 'codex',
            completedProviderIds: [],
            failedAgentIds: ['claude'],
            pendingProviderIds: ['gemini'],
        });
    });
});
