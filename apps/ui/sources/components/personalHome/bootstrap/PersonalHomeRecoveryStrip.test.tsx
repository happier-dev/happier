import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { PersonalHomeRecoveryStrip } from './PersonalHomeRecoveryStrip';

describe('PersonalHomeRecoveryStrip', () => {
    it('discloses sanitized controller detail without an active task or external callback', async () => {
        const screen = await renderScreen(
            <PersonalHomeRecoveryStrip
                kind="computer"
                onRetry={() => {}}
                detail={{
                    code: 'daemon_setup_failed',
                    message: 'token=should-not-render seed=abcdef0123456789abcdef0123456789',
                    retryable: true,
                }}
            />,
        );

        expect(screen.findByTestId('personal-home-recovery-details')).not.toBeNull();
        expect(screen.findHostByTestId('personal-home-recovery-details')?.props.accessibilityRole).toBe('button');
        expect(screen.findHostByTestId('personal-home-recovery-details')?.props.accessibilityState).toMatchObject({ expanded: false });
        await screen.pressByTestIdAsync('personal-home-recovery-details');
        expect(screen.findHostByTestId('personal-home-recovery-details')?.props.accessibilityState).toMatchObject({ expanded: true });
        expect(screen.findByTestId('personal-home-recovery-details-panel')).not.toBeNull();
        expect(screen.findAllHostsByTestId('personal-home-diagnostic-code')).toHaveLength(1);
        expect(screen.root.findAll((node) => typeof node.props.children === 'string' && node.props.children.includes('should-not-render'))).toHaveLength(0);
        expect(screen.root.findAll((node) => typeof node.props.children === 'string' && node.props.children.includes('abcdef0123456789abcdef0123456789'))).toHaveLength(0);
    });

    // U9: an account mismatch is explained in the shared localized sentence naming both accounts,
    // with its one repair, instead of "Agent setup needs attention" plus raw English in Details.
    it('names this computer\'s other account in the strip and offers its one repair', async () => {
        const screen = await renderScreen(
            <PersonalHomeRecoveryStrip
                kind="computer"
                onRetry={() => {}}
                detail={{
                    code: 'daemon_account_mismatch',
                    message: 'The daemon on this computer is signed in to a different account (robin).',
                    retryable: true,
                    thisComputer: {
                        status: 'daemon_account_mismatch',
                        homeLabel: 'http://127.0.0.1:3012',
                        daemonHomeLabel: 'http://127.0.0.1:3012',
                        appAccountLabel: 'Leeroy',
                        daemonAccountLabel: 'robin',
                    },
                }}
            />,
        );

        const text = screen.getTextContent();
        expect(text).toContain('robin');
        expect(text).toContain('Leeroy');
        expect(text).toContain('127.0.0.1:3012');
        // The one repair names its consequence instead of a bare Retry.
        expect(text).toContain('Switch to Leeroy');
        expect(text).not.toContain('Agent setup');
    });
});
