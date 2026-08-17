import { describe, expect, it, vi } from 'vitest';

import { t } from '@/text';

import { resolveAgentContinuationSubmitPresentation } from './agentContinuationSubmitPresentation';

const pickerIconScale = vi.hoisted(() => vi.fn((_agentId: string) => 1));

// The per-Agent optical correction is owned by the Agent registry and is the
// thing under test here — that this control reuses it rather than boxing every
// mark at one nominal size.
vi.mock('@/agents/registry/registryUi', () => ({
    getAgentPickerIconScale: (agentId: string) => pickerIconScale(agentId),
}));

vi.mock('@/agents/registry/registryCore', () => ({
    isAgentId: (value: unknown) => value !== 'not-in-this-build',
}));

describe('resolveAgentContinuationSubmitPresentation', () => {
    it('always names the switch in words, for every Agent', () => {
        // This is the control that commits the switch. A glyph reads as nothing
        // to a screen reader, so the accessible name is a sentence in every case.
        for (const agentId of ['claude', 'codex', 'kimi', 'auggie', 'customAcp', 'not-in-this-build']) {
            expect(resolveAgentContinuationSubmitPresentation({
                agentId,
                agentLabel: 'Target Agent',
            }).accessibilityLabel).toBe(
                t('session.agentContinuation.sendLabel', { agent: 'Target Agent' }),
            );
        }
    });

    it('draws every known Agent its own mark, with no per-Agent exception', () => {
        for (const agentId of ['claude', 'codex', 'kimi', 'kilo', 'auggie', 'customAcp']) {
            expect(resolveAgentContinuationSubmitPresentation({ agentId, agentLabel: 'X' }).markAgentId)
                .toBe(agentId);
        }
    });

    it('sizes the mark through the Agent registry, not a fixed box', () => {
        // A hardcoded size would pass a same-shape assertion, so the scale is
        // driven to values no nominal constant could produce.
        pickerIconScale.mockReturnValue(1.5);
        expect(resolveAgentContinuationSubmitPresentation({ agentId: 'kimi', agentLabel: 'Kimi' }).markSize)
            .toBe(27);
        expect(pickerIconScale).toHaveBeenLastCalledWith('kimi');

        pickerIconScale.mockReturnValue(0.8);
        expect(resolveAgentContinuationSubmitPresentation({ agentId: 'auggie', agentLabel: 'Auggie' }).markSize)
            .toBe(14);
    });

    it('has no mark to draw for an id this build does not know', () => {
        const presentation = resolveAgentContinuationSubmitPresentation({
            agentId: 'not-in-this-build',
            agentLabel: 'Unknown',
        });
        expect(presentation.markAgentId).toBeNull();
    });
});
