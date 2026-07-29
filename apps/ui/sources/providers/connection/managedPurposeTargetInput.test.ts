import { describe, expect, it } from 'vitest';

import {
    formatManagedPurposeTargetInput,
    parseManagedPurposeTargetInput,
} from './managedPurposeTargetInput';

const service = {
    pluginId: 'happier.connected-account.openai',
    localId: 'openai',
};

describe('managedPurposeTargetInput', () => {
    it('parses only account or group logical identity for the declared service', () => {
        expect(parseManagedPurposeTargetInput({
            input: ' account:work ',
            service,
        })).toEqual({
            kind: 'account',
            account: { service, accountId: 'work' },
        });
        expect(parseManagedPurposeTargetInput({
            input: 'group:team',
            service,
        })).toEqual({ kind: 'group', service, groupId: 'team' });
        expect(parseManagedPurposeTargetInput({
            input: 'account:tenant:work',
            service,
        })).toEqual({
            kind: 'account',
            account: { service, accountId: 'tenant:work' },
        });

        for (const input of [
            '',
            'work',
            'profile:work',
            'group:',
            'group:team:generation:4',
        ]) {
            expect(parseManagedPurposeTargetInput({ input, service }))
                .toBeNull();
        }
    });

    it('formats only the persisted logical identity without active-member facts', () => {
        expect(formatManagedPurposeTargetInput({
            kind: 'group',
            service,
            groupId: 'team',
        })).toBe('group:team');
        expect(formatManagedPurposeTargetInput({
            kind: 'account',
            account: { service, accountId: 'work' },
        })).toBe('account:work');
    });
});
