import { describe, expect, it, vi } from 'vitest';

import { buildAgentSetupWizardPrimaryOverride } from './resolveAgentSetupWizardPrimaryOverride';

describe('buildAgentSetupWizardPrimaryOverride', () => {
    it('uses Start label in selection phase', async () => {
        const start = vi.fn(async () => undefined);
        const labels = { start: 'Start', continue: 'Continue', done: 'Done' };

        const override = buildAgentSetupWizardPrimaryOverride({
            phase: 'select',
            canStart: true,
            hasPendingProviders: false,
            start,
            continueQueue: vi.fn(),
            finish: vi.fn(),
            labels,
        });

        expect(override.label).toBe(labels.start);
        expect(override.disabled).toBe(false);
        await override.onPress();
        expect(start).toHaveBeenCalledTimes(1);
    });

    it('disables Start when cannot start', async () => {
        const start = vi.fn(async () => undefined);
        const labels = { start: 'Start', continue: 'Continue', done: 'Done' };

        const override = buildAgentSetupWizardPrimaryOverride({
            phase: 'select',
            canStart: false,
            hasPendingProviders: false,
            start,
            continueQueue: vi.fn(),
            finish: vi.fn(),
            labels,
        });

        expect(override.disabled).toBe(true);
        await override.onPress();
        expect(start).toHaveBeenCalledTimes(0);
    });

    it('uses Continue/Done in queue phase depending on pending providers', async () => {
        const continueQueue = vi.fn();
        const finish = vi.fn();
        const labels = { start: 'Start', continue: 'Continue', done: 'Done' };

        const continueOverride = buildAgentSetupWizardPrimaryOverride({
            phase: 'queue',
            canStart: true,
            hasPendingProviders: true,
            start: vi.fn(async () => undefined),
            continueQueue,
            finish,
            labels,
        });

        expect(continueOverride.label).toBe(labels.continue);
        await continueOverride.onPress();
        expect(continueQueue).toHaveBeenCalledTimes(1);
        expect(finish).toHaveBeenCalledTimes(0);

        const doneOverride = buildAgentSetupWizardPrimaryOverride({
            phase: 'queue',
            canStart: true,
            hasPendingProviders: false,
            start: vi.fn(async () => undefined),
            continueQueue,
            finish,
            labels,
        });

        expect(doneOverride.label).toBe(labels.done);
        await doneOverride.onPress();
        expect(continueQueue).toHaveBeenCalledTimes(2);
        expect(finish).toHaveBeenCalledTimes(0);
    });

    it('calls onRequestAdvance on finish when provided', async () => {
        const onRequestAdvance = vi.fn();
        const finish = vi.fn();
        const labels = { start: 'Start', continue: 'Continue', done: 'Done' };

        const override = buildAgentSetupWizardPrimaryOverride({
            phase: 'complete',
            canStart: true,
            hasPendingProviders: false,
            start: vi.fn(async () => undefined),
            continueQueue: vi.fn(),
            finish,
            onRequestAdvance,
            labels,
        });

        expect(override.label).toBe(labels.done);
        await override.onPress();
        expect(finish).toHaveBeenCalledTimes(1);
        expect(onRequestAdvance).toHaveBeenCalledTimes(1);
    });
});
