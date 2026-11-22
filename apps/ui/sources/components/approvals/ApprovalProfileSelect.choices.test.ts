import { describe, expect, it } from 'vitest';

import {
    APPROVAL_PROFILE_ACCOUNT_OPTION_ID,
    APPROVAL_PROFILE_INHERIT_OPTION_ID,
    approvalProfileChipLabel,
    approvalProfileChoiceId,
    approvalProfileChoiceValue,
    buildApprovalProfileChoices,
} from './ApprovalProfileSelect';

const careful = { id: 'custom:careful', name: 'Careful agent' };
const deploy = { id: 'custom:deploy', name: 'Deploy only' };
const profiles = [careful, deploy];

describe('approval profile picker resolution', () => {
    it('offers Account settings and identifies the current Machine profile among saved profiles', () => {
        const choices = buildApprovalProfileChoices('session', profiles, 'p', { profile: careful });
        expect(choices.map(choice => choice.id)).toEqual([APPROVAL_PROFILE_ACCOUNT_OPTION_ID, careful.id, deploy.id]);
        expect(choices[1]?.title).toMatch(/Careful agent/);
        expect(approvalProfileChoiceValue(choices[1]!.id)).toBe(careful.id);
    });

    it('names Account settings for explicit null before and after the Machine is known', () => {
        for (const machineDefault of [null, { profile: careful }]) {
            const selected = buildApprovalProfileChoices('session', profiles, 'p', machineDefault, undefined,
                approvalProfileChoiceId('session', null)).find(choice => choice.checked);
            expect(selected?.title).toMatch(/accountSettings|Account settings/);
            expect(approvalProfileChoiceValue(selected!.id)).toBeNull();
        }
    });

    // WF-ACCEPT-1118B item 9: the chip's menu showed no check, so its rows did not say which one was chosen.
    it('marks the current choice, and only it, as checked', () => {
        const choices = buildApprovalProfileChoices('session', profiles, 'p', { profile: careful }, undefined, deploy.id);
        expect(choices.map(choice => [choice.id, choice.checked === true])).toEqual([
            [APPROVAL_PROFILE_ACCOUNT_OPTION_ID, false], [careful.id, false], [deploy.id, true],
        ]);
    });

    it('offers distinct choices to inherit draft defaults or explicitly use Account settings', () => {
        const choices = buildApprovalProfileChoices('draft', profiles, 'p', { profile: careful });
        expect(choices.slice(0, 2).map(choice => choice.id)).toEqual([
            APPROVAL_PROFILE_INHERIT_OPTION_ID, APPROVAL_PROFILE_ACCOUNT_OPTION_ID,
        ]);
        expect(approvalProfileChoiceId('draft', undefined)).toBe(APPROVAL_PROFILE_INHERIT_OPTION_ID);
        expect(approvalProfileChoiceValue(choices[0]!.id)).toBeUndefined();
        expect(approvalProfileChoiceId('draft', null)).toBe(APPROVAL_PROFILE_ACCOUNT_OPTION_ID);
        expect(approvalProfileChoiceValue(choices[1]!.id)).toBeNull();
    });

    it('offers a Machine "Account settings" first, stored as null', () => {
        const choices = buildApprovalProfileChoices('machine', profiles, 'm');
        expect(choices.map(choice => choice.id)).toEqual([APPROVAL_PROFILE_ACCOUNT_OPTION_ID, careful.id, deploy.id]);
        expect(approvalProfileChoiceId('machine', null)).toBe(APPROVAL_PROFILE_ACCOUNT_OPTION_ID);
        expect(approvalProfileChoiceValue(APPROVAL_PROFILE_ACCOUNT_OPTION_ID)).toBeNull();
    });

    it('labels the composer chip with what applies: the Machine profile, the chosen one, or a deleted one', () => {
        expect(approvalProfileChipLabel({ value: undefined, profiles, machineDefault: { profile: careful }, ready: true }))
            .toEqual({ label: expect.stringMatching(/Careful agent/), chosen: true });
        expect(approvalProfileChipLabel({ value: null, profiles, machineDefault: { profile: careful }, ready: true }))
            .toEqual({ label: expect.stringMatching(/accountSettings|Account settings/), chosen: true });
        expect(approvalProfileChipLabel({ value: undefined, profiles, machineDefault: { profile: null }, ready: true }))
            .toEqual({ label: expect.stringMatching(/guided\.profile\.title|Approval profile/), chosen: false });
        expect(approvalProfileChipLabel({ value: deploy.id, profiles, machineDefault: null, ready: true }).label).toBe('Deploy only');
        expect(approvalProfileChipLabel({ value: 'custom:gone', profiles, machineDefault: null, ready: true }).label)
            .toMatch(/deletedName|Deleted profile/);
    });
});
