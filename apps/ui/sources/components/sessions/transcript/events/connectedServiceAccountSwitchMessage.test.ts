import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import { presentConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';

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

        expect(message).toBe('Switched ChatGPT group Happier from team@happier.dev to leeroy.brun@gmail.com');
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

        expect(message).toBe('Switched Claude subscription group Team Pool from leeroy to leeroy');
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

        expect(message).toBe('Switched Claude subscription group team-pool from leeroy to leeroy');
        expect(message).not.toContain('group Claude');
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

        expect(message).toBe('Switched ChatGPT account from Work to Backup');
    });

    it('describes a Session-owned sign-in without inventing a historical account', () => {
        const message = buildConnectedServiceAccountSwitchMessage({
            event: {
                serviceId: 'openai-codex',
                groupId: 'team',
                fromProfileId: null,
                toProfileId: 'team',
            },
            labelsByKey: {},
        });

        expect(message).toContain(t('connectedServices.authModal.nativeAuthTitle'));
        expect(message).not.toContain(t('connectedServices.authChip.nativeLabel'));
        expect(message).not.toContain('from null');
    });

    it('uses canonical numbered account fallbacks without exposing routing ids', () => {
        const message = buildConnectedServiceAccountSwitchMessage({
            event: {
                serviceId: 'openai-codex',
                groupId: null,
                fromProfileId: 'work',
                toProfileId: 'backup',
                fromProfileLabel: 'work',
                toProfileLabel: 'backup',
            },
            labelsByKey: undefined,
        });

        expect(message).toContain('ChatGPT account');
        expect(message).not.toContain('work');
        expect(message).not.toContain('backup');
    });

    it.each([false, true])('presents both exact accounts together with privacy-aware collision identity: hidden=%s', (hidden) => {
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const message = buildConnectedServiceAccountSwitchMessage({
            event: { serviceId: 'openai-codex', groupId: null, fromProfileId: 'work', toProfileId: 'backup' },
            labelsByKey: undefined,
            accounts: [
                { ref: { service, accountId: 'work' }, displayName: 'Same name', providerIdentity: { email: 'work@example.com' } },
                { ref: { service, accountId: 'backup' }, displayName: 'Same name', providerIdentity: { email: 'personal@example.com' } },
            ],
            presentIdentity: input => presentConnectedAccountIdentity({ hidden, label: input.label ?? null,
                email: input.email ?? null, accountId: input.accountId ?? null, labelKind: input.labelKind }),
        });
        expect(message).toBe(hidden
            ? 'Switched ChatGPT account from Same name · wo•••@e•••.com to Same name · pe•••@e•••.com'
            : 'Switched ChatGPT account from Same name · work@example.com to Same name · personal@example.com');
        if (hidden) expect(message).not.toContain('@example.com');
    });

    it.each([false, true])('uses same-service accounts outside the switch as collision context: hidden=%s', (hidden) => {
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const accounts = [
            { ref: { service, accountId: 'work' }, displayName: 'Same name', providerIdentity: { email: 'work@example.com' } },
            { ref: { service, accountId: 'personal' }, displayName: 'Same name', providerIdentity: { email: 'personal@example.com' } },
            { ref: { service, accountId: 'other' }, displayName: 'Happier', providerIdentity: { email: 'other@example.com' } },
        ];
        for (const [fromProfileId, toProfileId] of [['work', 'other'], ['other', 'work']] as const) {
            const message = buildConnectedServiceAccountSwitchMessage({
                event: { serviceId: 'openai-codex', groupId: null, fromProfileId, toProfileId },
                labelsByKey: undefined,
                accounts,
                presentIdentity: input => presentConnectedAccountIdentity({ hidden, label: input.label ?? null,
                    email: input.email ?? null, accountId: input.accountId ?? null, labelKind: input.labelKind }),
            });
            const accountName = hidden ? 'Same name · wo•••@e•••.com' : 'Same name · work@example.com';
            expect(message).toContain(fromProfileId === 'work' ? `from ${accountName} to Happier` : `from Happier to ${accountName}`);
            expect(message).not.toContain(hidden ? 'pe•••@e•••.com' : 'personal@example.com');
        }
    });

    it('excludes other services from the switch collision context', () => {
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const message = buildConnectedServiceAccountSwitchMessage({
            event: { serviceId: 'openai-codex', groupId: null, fromProfileId: null, toProfileId: 'work' },
            labelsByKey: undefined,
            accounts: [
                { ref: { service, accountId: 'work' }, displayName: 'Same name', providerIdentity: { email: 'work@example.com' } },
                { ref: { service: { pluginId: 'another.plugin', localId: 'another-service' }, accountId: 'work' },
                    displayName: 'Same name', providerIdentity: { email: 'other@example.com' } },
            ],
        });
        expect(message).toContain('to Same name');
        expect(message).not.toContain('@example.com');
    });
});
