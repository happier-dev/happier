import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import type { Profile } from '@/sync/domains/profiles/profile';
import { installBugReportHooksCommonModuleMocks } from './bugReportHooksTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installBugReportHooksCommonModuleMocks();

describe('useBugReportReporterGithubUsername', () => {
    it('does not crash when profile is null', async () => {
        const { useBugReportReporterGithubUsername } = await import('./useBugReportReporterGithubUsername');

        function TestComponent(props: { profile: Profile | null }) {
            // Cast is intentional: this test asserts runtime resilience for null profiles even if types drift.
            const { reporterGithubUsername } = useBugReportReporterGithubUsername(props.profile as unknown as Profile);
            return React.createElement('Text', { value: reporterGithubUsername });
        }

        await expect(renderScreen(<TestComponent profile={null} />)).resolves.toBeDefined();
    });

    it('defaults to @login when github provider is linked', async () => {
        const { useBugReportReporterGithubUsername } = await import('./useBugReportReporterGithubUsername');

        const profile = {
            id: 'p1',
            timestamp: 0,
            firstName: null,
            lastName: null,
            username: null,
            avatar: null,
            linkedProviders: [{ id: 'github', login: 'octocat', avatarUrl: null, displayName: null }],
            connectedServices: [],
        } as unknown as Profile; // Fixture satisfies runtime shape; protocol schema may evolve.

        function TestComponent(props: { profile: Profile | null }) {
            const { reporterGithubUsername } = useBugReportReporterGithubUsername(props.profile as unknown as Profile);
            return React.createElement('Text', { value: reporterGithubUsername });
        }

        const screen = await renderScreen(<TestComponent profile={profile} />);
        for (let i = 0; i < 10; i += 1) {
            await flushHookEffects({ cycles: 1, turns: 1 });
            const text = screen.findByType('Text' as any);
            if (text.props.value === '@octocat') break;
        }
        expect(screen.findByType('Text' as any).props.value).toBe('@octocat');
    });
});
