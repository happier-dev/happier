import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectedAccountDescriptorProjectionState } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => params
            ? `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`
            : key,
    });
});

const SERVICE = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' } as const;
const SERVICE_KEY = 'happier.agent.claude/claude-subscription';

function group(policy: Record<string, unknown>) {
    return {
        ref: { service: SERVICE, groupId: 'work' },
        displayName: 'Work pool',
        policy: ConnectedServiceAuthGroupPolicyV1Schema.parse(policy),
        activeConnectedAccountId: 'personal',
    } as never;
}

async function build(bindings: Record<string, unknown>, options: Readonly<{ groups?: never[]; viewModel?: never }> = {}) {
    const { buildUsagePopoverSession } = await import('./SessionUsagePopoverContent');
    const { buildUsageSummary } = await import('@/components/hub/usage/useUsageSummary');
    return buildUsagePopoverSession({
        metadata: { connectedServices: { v: 2, bindingsByServiceId: bindings } },
        agentId: 'claude',
        viewModel: options.viewModel ?? null,
        groups: options.groups ?? [],
        usage: buildUsageSummary({ live: null, saved: null, accountsWithoutUsage: [] }),
        present: (input) => ({ label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null }),
        resetAction: null,
    });
}

describe('buildUsagePopoverSession', () => {
    // The popover's module graph is large; load it once up front so no single test pays for it.
    beforeAll(async () => {
        await import('./SessionUsagePopoverContent');
        await import('@/components/hub/usage/useUsageSummary');
    }, 600_000);

    beforeEach(() => {
        installConnectedAccountDescriptorProjection({
            scopeKey: 'session-usage-popover-test', status: 'ready', descriptors: [], conflicts: [], errorReason: null,
        } satisfies ConnectedAccountDescriptorProjectionState);
    });

    it('scopes to the account the session\'s binding names, and says what its pool does when it runs out', async () => {
        const session = await build(
            { [SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'lab' } },
            { groups: [group({ strategy: 'priority', autoSwitch: true })] },
        );
        expect(session.accountKey).toBe('happier.agent.claude%2Fclaude-subscription/lab');
        expect(session.scopeLine).toContain('sidebarFooter.usageSessionThroughPool(');
        expect(session.scopeLine).toContain('pool=Work pool');
        // Without a name or an email the account reads as its service's account, never its raw id.
        expect(session.nextMove).toMatch(/^sidebarFooter\.usageNextInOrder\(account=connectedServicesCollection\.accountLabel\(/);
        expect(session.nextMove).not.toContain('account=lab');
    });

    it('names the pool\'s rule, never a member: most left, or it stays until you switch', async () => {
        const binding = { [SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'lab' } };
        expect((await build(binding, { groups: [group({ strategy: 'least_limited', autoSwitch: true })] })).nextMove)
            .toMatch(/^sidebarFooter\.usageNextMostLeft\(account=connectedServicesCollection\.accountLabel\(/);
        expect((await build(binding, { groups: [group({ strategy: 'least_limited', autoSwitch: false })] })).nextMove)
            .toMatch(/^sidebarFooter\.usageNextStays\(pool=Work pool,account=connectedServicesCollection\.accountLabel\(/);
        expect((await build(binding, { groups: [group({
            strategy: 'priority', autoSwitch: true,
            switchOn: { usageLimit: false, authExpired: true, accountChanged: true, refreshFailure: true },
        })] })).nextMove).toMatch(/^sidebarFooter\.usageNextStays\(pool=Work pool,account=connectedServicesCollection\.accountLabel\(/);
    });

    it('does not take the pool\'s current account for the session\'s when the binding does not name one', async () => {
        const session = await build(
            { [SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work' } },
            { groups: [group({ strategy: 'priority', autoSwitch: true })] },
        );
        expect(session.accountKey).toBeNull();
        expect(session.ownSignIn).toBeNull();
        expect(session.nextMove).toBeNull();
        expect(session.scopeLine).toContain('pool=Work pool');
    });

    it('shows the gauge\'s own windows for a session that signs in on its own', async () => {
        const session = await build({ [SERVICE_KEY]: { source: 'native' } }, {
            viewModel: {
                serviceId: null,
                providerDisplayName: 'Claude',
                allMeterRows: [{ meterId: '5h', label: '5-hour', remainingPct: 3, resetsAt: null }],
                recoveryCreditSummary: null,
            } as never,
        });
        expect(session.accountKey).toBeNull();
        expect(session.ownSignIn).toMatchObject({
            title: 'Claude',
            windows: [{ meterId: '5h', remainingPct: 3, tone: 'danger' }],
        });
    });
});
