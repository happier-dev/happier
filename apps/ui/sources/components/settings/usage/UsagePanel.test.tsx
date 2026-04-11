import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const authState = vi.hoisted(() => ({
    credentials: { token: 'test-token', secret: 'test-secret' },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: authState.credentials, isAuthenticated: true }),
}));

vi.mock('@/sync/api/account/apiUsage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/account/apiUsage')>();
    return {
        ...actual,
        getUsageForPeriod: vi.fn(async () => []),
    };
});

vi.mock('@/components/settings/usage/UsageAnalyticsDashboard', () => ({
    UsageAnalyticsDashboard: (props: Record<string, unknown>) => React.createElement('UsageAnalyticsDashboard', props),
}));

describe('UsagePanel', () => {
    it('renders a session drilldown frame when scoped to a specific session', async () => {
        const { UsagePanel } = await import('./UsagePanel');
        const screen = await renderScreen(
            <UsagePanel sessionId="session-123" />,
        );

        expect(screen.findByTestId('usage-session-drilldown')).toBeTruthy();
        expect(screen.getTextContent()).toContain('session-123');
    });
});
