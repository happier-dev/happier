import { describe, expect, it } from 'vitest';

import {
    completeActiveProviderSetupStep,
    createProviderSetupQueueState,
    failActiveProviderSetupStep,
    markActiveProviderSetupStepFailed,
    skipActiveProviderSetupStep,
} from './providerSetupQueue';

describe('providerSetupQueue', () => {
    it('starts with the selected providers in a stable sequential queue', () => {
        expect(createProviderSetupQueueState(['codex', 'claude', 'gemini'])).toEqual({
            activeProviderId: 'codex',
            completedProviderIds: [],
            failedProviderIds: [],
            pendingProviderIds: ['claude', 'gemini'],
        });
    });

    it('advances to the next provider after completing the active setup step', () => {
        const initial = createProviderSetupQueueState(['codex', 'claude']);

        expect(completeActiveProviderSetupStep(initial)).toEqual({
            activeProviderId: 'claude',
            completedProviderIds: ['codex'],
            failedProviderIds: [],
            pendingProviderIds: [],
        });
    });

    it('can skip a blocked provider without breaking the remaining queue order', () => {
        const initial = createProviderSetupQueueState(['codex', 'claude', 'gemini']);

        expect(skipActiveProviderSetupStep(initial)).toEqual({
            activeProviderId: 'claude',
            completedProviderIds: [],
            failedProviderIds: [],
            pendingProviderIds: ['gemini'],
            skippedProviderIds: ['codex'],
        });
    });

    it('records a failed provider while keeping the remaining queue order', () => {
        const initial = createProviderSetupQueueState(['codex', 'claude', 'gemini']);

        expect(failActiveProviderSetupStep(initial)).toEqual({
            activeProviderId: 'claude',
            completedProviderIds: [],
            failedProviderIds: ['codex'],
            pendingProviderIds: ['gemini'],
        });
    });

    it('can mark the active provider as failed without advancing the queue (so the user can decide to skip)', () => {
        const initial = createProviderSetupQueueState(['codex', 'claude']);

        expect(markActiveProviderSetupStepFailed(initial)).toEqual({
            activeProviderId: 'codex',
            completedProviderIds: [],
            failedProviderIds: ['codex'],
            pendingProviderIds: ['claude'],
        });
    });
});
