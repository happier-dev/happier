import { describe, expect, it } from 'vitest';

import {
    doesExecutionRunProfileMatchSelectedBackends,
    resolveExecutionRunLauncherProfileChoices,
} from './resolveExecutionRunLauncherProfileChoices';

describe('resolveExecutionRunLauncherProfileChoices', () => {
    it('projects CodeRabbit and DeepSec rows through compatible available Agents', () => {
        const choices = resolveExecutionRunLauncherProfileChoices({
            intent: 'review',
            profiles: [
                { id: 'review.coderabbit/review', intent: 'review', title: 'CodeRabbit', compatibleAgentIds: ['coderabbit'], generationId: 'g1', available: true, defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' } },
                { id: 'review.deepsec/review', intent: 'review', title: 'DeepSec Review', compatibleAgentIds: ['deepsec'], generationId: 'g1', available: true, defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' } },
                { id: 'review.deepsec/audit', intent: 'review', title: 'DeepSec Audit', compatibleAgentIds: ['deepsec'], generationId: 'g1', available: false, unavailableCode: 'missing_tool', defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' } },
            ],
            backendChoices: [
                { backendId: 'coderabbit', disabled: false },
                { backendId: 'deepsec', disabled: false },
            ],
        });

        expect(choices).toEqual([
            expect.objectContaining({ id: 'review.coderabbit/review', compatibleAgentId: 'coderabbit', disabled: false }),
            expect.objectContaining({ id: 'review.deepsec/review', compatibleAgentId: 'deepsec', disabled: false }),
            expect.objectContaining({ id: 'review.deepsec/audit', compatibleAgentId: 'deepsec', disabled: true }),
        ]);
    });

    it('disables a profile when no compatible Agent is currently available', () => {
        expect(resolveExecutionRunLauncherProfileChoices({
            intent: 'review',
            profiles: [{ id: 'review.deepsec/review', intent: 'review', title: 'DeepSec', compatibleAgentIds: ['deepsec'], generationId: 'g1', available: true, defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' } }],
            backendChoices: [{ backendId: 'deepsec', disabled: true }],
        })[0]).toMatchObject({ disabled: true, compatibleAgentId: null });
    });

    it('requires exactly one compatible selected Agent while a profile is selected', () => {
        const profile = { compatibleAgentIds: ['deepsec'] };
        expect(doesExecutionRunProfileMatchSelectedBackends(profile, ['deepsec'])).toBe(true);
        expect(doesExecutionRunProfileMatchSelectedBackends(profile, ['coderabbit'])).toBe(false);
        expect(doesExecutionRunProfileMatchSelectedBackends(profile, ['deepsec', 'coderabbit'])).toBe(false);
    });
});
