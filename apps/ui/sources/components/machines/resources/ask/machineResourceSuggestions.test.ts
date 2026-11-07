import { describe, expect, it } from 'vitest';

import { WEEKLY_STORAGE_REVIEW_PROMPT } from '@/components/automations/storage/weeklyStorageReviewTemplate';
import { t } from '@/text';
import { deriveMachineResourceSuggestions, type MachineResourceSuggestionFacts } from './machineResourceSuggestions';

const machine = { serverId: 'home-1', machineId: 'machine-1', name: 'Studio', directory: '/Users/studio' };
const calm: MachineResourceSuggestionFacts = { machine, online: true, memoryPressure: 'calm', calm: true };

describe('machine resource suggestions', () => {
    it('uses current pressure, disk severity and left-behind facts for the three slots', () => {
        const suggestions = deriveMachineResourceSuggestions({ ...calm, calm: false, memoryPressure: 'critical',
            disk: { availableBytes: 0, totalBytes: 100_000_000_000, tone: 'crit' }, leftBehindCount: 7,
            guardEnabled: false, happierStorageBytes: 10_000_000_000, automationsEnabled: true });
        expect(suggestions.map((suggestion) => suggestion.kind)).toEqual(['memory', 'disk', 'leftBehind']);
        expect(suggestions.every((suggestion) => suggestion.machine === machine)).toBe(true);
        expect(suggestions.every((suggestion) => suggestion.fill.placement?.machineId === machine.machineId)).toBe(true);
        expect(suggestions[1]!.reason).toContain('0');
        expect(suggestions[2]!.reason).toContain('7');
    });

    it('uses owner severity rather than inventing a low-disk threshold, and keeps unknowns unknown', () => {
        const suggestions = deriveMachineResourceSuggestions({ machine, online: true,
            memoryPressure: 'not_reported', disk: { availableBytes: 0, totalBytes: 100, tone: 'calm' } });
        expect(suggestions.map((suggestion) => suggestion.kind)).toEqual(['overview', 'storage', 'processes']);
        expect(suggestions.every((suggestion) => suggestion.reason.includes('calm'))).toBe(false);
        expect(deriveMachineResourceSuggestions({ ...calm, disk: { availableBytes: 90, totalBytes: 100, tone: 'warn' } })[0]!.kind).toBe('disk');
    });

    it('offers Guard and Happier’s measured share with a weekly Automation intent only when supported', () => {
        const facts = { ...calm, guardEnabled: false, happierStorageBytes: 12_000_000_000, automationsEnabled: true };
        const suggestions = deriveMachineResourceSuggestions(facts);
        expect(suggestions.map((suggestion) => suggestion.kind)).toEqual(['guard', 'storage', 'weeklyReview']);
        expect(suggestions[1]!.reason).toContain('12');
        expect(suggestions[2]).toMatchObject({ intent: 'automation', fill: { text: WEEKLY_STORAGE_REVIEW_PROMPT, placement: null } });
        expect(deriveMachineResourceSuggestions({ ...facts, automationsEnabled: false }).some((suggestion) => suggestion.intent === 'automation')).toBe(false);
    });

    it('offers three last-report prompts offline without targeting the unreachable machine', () => {
        const suggestions = deriveMachineResourceSuggestions({ ...calm, online: false,
            hasLastReport: true, happierStorageBytes: 0,
            memoryPressure: 'critical', leftBehindCount: 3, guardEnabled: false, automationsEnabled: true });
        expect(suggestions.map((suggestion) => suggestion.kind)).toEqual(['lastReport', 'lastStorageReport', 'notifyWhenBack']);
        expect(suggestions.every((suggestion) => suggestion.fill.placement === null && !suggestion.intent)).toBe(true);
        expect(suggestions.every((suggestion) => suggestion.fill.text.includes(machine.name))).toBe(true);
        expect(suggestions.find(suggestion => suggestion.kind === 'notifyWhenBack')!.fill.text)
            .toContain(t('machineResources.askSuggestions.prompts.notifyWhenBackConsent', { machine: machine.name }));
        // The block says once that the machine is offline; its tiles do not repeat that cause three times.
        expect(suggestions.map((suggestion) => suggestion.reason)).toEqual(['', '', '']);
    });

    it('keeps suggestion identity machine-qualified and fills only text and placement', () => {
        const first = deriveMachineResourceSuggestions(calm);
        expect(deriveMachineResourceSuggestions({ ...calm, machine: { ...machine } }, first)).toBe(first);
        const second = deriveMachineResourceSuggestions({ ...calm, machine: { ...machine, serverId: 'other-home' } });
        expect(first.map((suggestion) => suggestion.id)).not.toEqual(second.map((suggestion) => suggestion.id));
        expect(first.every((suggestion) => Object.keys(suggestion.fill).sort().join(',') === 'placement,text')).toBe(true);
        for (const patch of [{ serverId: 'other-home' }, { machineId: 'other-machine' }, { name: 'Laptop' }, { directory: '/other' }]) {
            const facts = { ...calm, machine: { ...machine, ...patch } };
            const current = deriveMachineResourceSuggestions(facts);
            expect(deriveMachineResourceSuggestions(facts, first)).toEqual(current);
            expect(deriveMachineResourceSuggestions(facts, first)).not.toBe(first);
        }
        expect(deriveMachineResourceSuggestions({ ...calm, online: false }, first).every(suggestion => suggestion.fill.placement === null)).toBe(true);
    });

    it('offers no last-report prompt offline until that report has actually been observed', () => {
        expect(deriveMachineResourceSuggestions({ ...calm, online: false, hasLastReport: false })
            .map(suggestion => suggestion.kind)).toEqual(['notifyWhenBack']);
    });

    it('asks about the tab’s own subject on Setup and Security, never about resources there', () => {
        const pressed = { ...calm, calm: false, memoryPressure: 'critical' as const, guardEnabled: false, happierStorageBytes: 10_000_000_000 };
        const setup = deriveMachineResourceSuggestions({ ...pressed, subject: 'setup' });
        expect(setup.map(suggestion => suggestion.kind)).toEqual(['setupDocker', 'setupReview', 'setupHarden']);
        const security = deriveMachineResourceSuggestions({ ...pressed, subject: 'security' });
        expect(security.map(suggestion => suggestion.kind)).toEqual(['securityAccess', 'securityNetwork', 'securityUpdates']);
        expect([...setup, ...security].every(suggestion => suggestion.fill.placement?.machineId === machine.machineId)).toBe(true);
        // Resource tabs keep resource prompts.
        expect(deriveMachineResourceSuggestions({ ...pressed, subject: 'resources' })[0]!.kind).toBe('memory');
    });
});
