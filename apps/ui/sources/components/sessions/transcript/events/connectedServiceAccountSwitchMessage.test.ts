import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { buildConnectedServiceAccountSwitchMessage } from './connectedServiceAccountSwitchMessage';

describe('buildConnectedServiceAccountSwitchMessage', () => {
    it('renders a group-driven switch using display labels and selection kinds (not raw profile ids)', () => {
        const message = buildConnectedServiceAccountSwitchMessage({
            event: {
                serviceId: 'claude-subscription',
                groupId: 'team-pool',
                fromProfileId: 'batiplus',
                toProfileId: 'batiplus',
            },
            labelsByKey: { 'claude-subscription/batiplus': 'leeroy' },
        });

        // Regression: a group(active=batiplus,label=leeroy)->profile(batiplus) switch must not surface
        // the raw profile id on either endpoint, so it must never read "batiplus to batiplus".
        expect(message).not.toContain('batiplus');
        expect(message).toContain('leeroy');
        expect(message).toContain(t('message.connectedServiceSwitchGroupEndpoint', { group: 'Claude', profile: 'leeroy' }));
        expect(message).toContain(t('message.connectedServiceSwitchProfileEndpoint', { profile: 'leeroy' }));
    });

    it('uses labels carried by the transcript event when settings labels are not hydrated', () => {
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

        expect(message).not.toContain('batiplus');
        expect(message).toContain(t('message.connectedServiceSwitchGroupEndpoint', { group: 'Claude', profile: 'leeroy' }));
        expect(message).toContain(t('message.connectedServiceSwitchProfileEndpoint', { profile: 'leeroy' }));
    });

    it('describes both endpoints as profiles for a direct (non-group) switch', () => {
        const message = buildConnectedServiceAccountSwitchMessage({
            event: {
                serviceId: 'openai-codex',
                groupId: null,
                fromProfileId: 'work',
                toProfileId: 'backup',
            },
            labelsByKey: { 'openai-codex/work': 'Work', 'openai-codex/backup': 'Backup' },
        });

        expect(message).toContain(t('message.connectedServiceSwitchProfileEndpoint', { profile: 'Work' }));
        expect(message).toContain(t('message.connectedServiceSwitchProfileEndpoint', { profile: 'Backup' }));
    });

    it('falls back to the native CLI-auth label when an endpoint profile is missing', () => {
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
