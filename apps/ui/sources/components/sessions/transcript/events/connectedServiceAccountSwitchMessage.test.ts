import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { buildConnectedServiceAccountSwitchMessage } from './connectedServiceAccountSwitchMessage';

describe('buildConnectedServiceAccountSwitchMessage', () => {
    it('renders a group-driven switch using display labels without group-to-profile wording', () => {
        const message = buildConnectedServiceAccountSwitchMessage({
            event: {
                serviceId: 'openai-codex',
                groupId: 'codex-main',
                groupLabel: 'Happier',
                fromProfileId: 'work',
                toProfileId: 'backup',
                fromProfileLabel: 'team@happier.dev',
                toProfileLabel: 'leeroy.brun@gmail.com',
            },
            labelsByKey: undefined,
        });

        expect(message).toBe('Switched Codex group Happier from team@happier.dev to leeroy.brun@gmail.com');
        expect(message).not.toContain('from group');
        expect(message).not.toContain('to profile');
    });

    it('uses labels carried by the transcript event when settings labels are not hydrated', () => {
        const message = buildConnectedServiceAccountSwitchMessage({
            event: {
                serviceId: 'claude-subscription',
                groupId: 'team-pool',
                groupLabel: 'Team Pool',
                fromProfileId: 'batiplus',
                toProfileId: 'batiplus',
                fromProfileLabel: 'leeroy',
                toProfileLabel: 'leeroy',
            },
            labelsByKey: undefined,
        });

        expect(message).toBe('Switched Claude group Team Pool from leeroy to leeroy');
        expect(message).not.toContain('batiplus');
        expect(message).not.toContain('from group');
        expect(message).not.toContain('to profile');
    });

    it('falls back to group id for old grouped rows instead of the provider label', () => {
        const message = buildConnectedServiceAccountSwitchMessage({
            event: {
                serviceId: 'claude-subscription',
                groupId: 'team-pool',
                fromProfileId: 'batiplus',
                toProfileId: 'batiplus',
                fromProfileLabel: 'leeroy',
                toProfileLabel: 'leeroy',
            },
            labelsByKey: undefined,
        });

        expect(message).toBe('Switched Claude group team-pool from leeroy to leeroy');
        expect(message).not.toContain('Switched Claude group Claude');
    });

    it('describes both sides as profiles for a direct (non-group) switch', () => {
        const message = buildConnectedServiceAccountSwitchMessage({
            event: {
                serviceId: 'openai-codex',
                groupId: null,
                fromProfileId: 'work',
                toProfileId: 'backup',
            },
            labelsByKey: { 'openai-codex/work': 'Work', 'openai-codex/backup': 'Backup' },
        });

        expect(message).toBe('Switched Codex account from Work to Backup');
    });

    it('falls back to the native CLI-auth label when a switch side has no profile', () => {
        const message = buildConnectedServiceAccountSwitchMessage({
            event: {
                serviceId: 'openai-codex',
                groupId: 'team',
                fromProfileId: null,
                toProfileId: 'team',
            },
            labelsByKey: {},
        });

        expect(message).toContain(t('connectedServices.authChip.nativeLabel'));
        expect(message).not.toContain('from null');
    });

    it('falls back to the raw profile id only when no label is configured', () => {
        const message = buildConnectedServiceAccountSwitchMessage({
            event: {
                serviceId: 'openai-codex',
                groupId: null,
                fromProfileId: 'work',
                toProfileId: 'backup',
            },
            labelsByKey: undefined,
        });

        expect(message).toContain('work');
        expect(message).toContain('backup');
    });
});
