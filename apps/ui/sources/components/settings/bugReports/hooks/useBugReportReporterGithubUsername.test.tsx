import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { Profile } from '@/sync/domains/profiles/profile';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Minimal RN mocks for hook tests.
vi.mock('react-native', () => ({
    Text: 'Text',
}));

describe('useBugReportReporterGithubUsername', () => {
    it('does not crash when profile is null', async () => {
        const { useBugReportReporterGithubUsername } = await import('./useBugReportReporterGithubUsername');

        function TestComponent(props: { profile: Profile | null }) {
            // Cast is intentional: this test asserts runtime resilience for null profiles even if types drift.
            const { reporterGithubUsername } = useBugReportReporterGithubUsername(props.profile as unknown as Profile);
            return React.createElement('Text', { value: reporterGithubUsername });
        }

        await act(async () => {
            expect(() => renderer.create(<TestComponent profile={null} />)).not.toThrow();
        });
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

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<TestComponent profile={profile} />);
        });
        for (let i = 0; i < 10; i += 1) {
            await act(async () => {
                await Promise.resolve();
            });
            const text = tree!.root.findByType('Text' as any);
            if (text.props.value === '@octocat') break;
        }
        expect(tree!.root.findByType('Text' as any).props.value).toBe('@octocat');
    });
});
