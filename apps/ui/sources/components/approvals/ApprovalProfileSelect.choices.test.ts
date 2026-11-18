import { describe, expect, it } from 'vitest';

import {
    APPROVAL_PROFILE_ACCOUNT_OPTION_ID,
    APPROVAL_PROFILE_MACHINE_DEFAULT_OPTION_ID,
    approvalProfileChipLabel,
    approvalProfileChoiceId,
    approvalProfileChoiceValue,
    buildApprovalProfileChoices,
} from './ApprovalProfileSelect';

const careful = { id: 'custom:careful', name: 'Careful agent' };
const deploy = { id: 'custom:deploy', name: 'Deploy only' };
const profiles = [careful, deploy];

// OWNER 2026-11-15 (approval-profiles redesign): a Session picks "Machine default (X)" or one of the person's saved
// profiles; built-ins are gone. No profile of its own (null or absent) follows the Machine, then the Account.
describe('approval profile picker resolution', () => {
    it('offers the Machine default, named by the profile it resolves to, then the saved profiles and nothing built in', () => {
        const choices = buildApprovalProfileChoices('session', profiles, 'p', { profile: careful });
        expect(choices.map(choice => choice.id)).toEqual([APPROVAL_PROFILE_MACHINE_DEFAULT_OPTION_ID, careful.id, deploy.id]);
        expect(choices[0]?.title).toMatch(/Careful agent/);
        expect(choices.some(choice => choice.id.startsWith('builtin:'))).toBe(false);
    });

    it('names the Account settings when the Machine has no profile, and only "Machine default" before a Machine is known', () => {
        expect(buildApprovalProfileChoices('session', profiles, 'p', { profile: null })[0]?.title)
            .toMatch(/accountSettings|Account settings/);
        expect(buildApprovalProfileChoices('session', profiles, 'p', null)[0]?.title)
            .toMatch(/^(workflows\.triggers\.guided\.profile\.machineDefault|Machine default)$/);
    });

    // WF-ACCEPT-1118B item 9: the chip's menu showed no check, so its rows did not say which one was chosen.
    it('marks the current choice, and only it, as checked', () => {
        const choices = buildApprovalProfileChoices('session', profiles, 'p', { profile: careful }, undefined, deploy.id);
        expect(choices.map(choice => [choice.id, choice.checked === true])).toEqual([
            [APPROVAL_PROFILE_MACHINE_DEFAULT_OPTION_ID, false], [careful.id, false], [deploy.id, true],
        ]);
    });

    it('reads a Session without its own profile as the Machine default, and writes that choice back as null', () => {
        expect(approvalProfileChoiceId('session', undefined)).toBe(APPROVAL_PROFILE_MACHINE_DEFAULT_OPTION_ID);
        expect(approvalProfileChoiceId('session', null)).toBe(APPROVAL_PROFILE_MACHINE_DEFAULT_OPTION_ID);
        expect(approvalProfileChoiceId('session', careful.id)).toBe(careful.id);
        expect(approvalProfileChoiceValue(APPROVAL_PROFILE_MACHINE_DEFAULT_OPTION_ID)).toBeNull();
        expect(approvalProfileChoiceValue(deploy.id)).toBe(deploy.id);
    });

    it('offers a Machine "Account settings" first, stored as null', () => {
        const choices = buildApprovalProfileChoices('machine', profiles, 'm');
        expect(choices.map(choice => choice.id)).toEqual([APPROVAL_PROFILE_ACCOUNT_OPTION_ID, careful.id, deploy.id]);
        expect(approvalProfileChoiceId('machine', null)).toBe(APPROVAL_PROFILE_ACCOUNT_OPTION_ID);
        expect(approvalProfileChoiceValue(APPROVAL_PROFILE_ACCOUNT_OPTION_ID)).toBeNull();
    });

    it('labels the composer chip with what applies: the Machine profile, the chosen one, or a deleted one', () => {
        expect(approvalProfileChipLabel({ value: null, profiles, machineDefault: { profile: careful }, ready: true }))
            .toEqual({ label: expect.stringMatching(/Careful agent/), chosen: true });
        expect(approvalProfileChipLabel({ value: undefined, profiles, machineDefault: { profile: null }, ready: true }))
            .toEqual({ label: expect.stringMatching(/guided\.profile\.title|Approval profile/), chosen: false });
        expect(approvalProfileChipLabel({ value: deploy.id, profiles, machineDefault: null, ready: true }).label).toBe('Deploy only');
        expect(approvalProfileChipLabel({ value: 'custom:gone', profiles, machineDefault: null, ready: true }).label)
            .toMatch(/deletedName|Deleted profile/);
    });
});
