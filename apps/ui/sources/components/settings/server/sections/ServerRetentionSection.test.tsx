import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installServerSettingsHooksCommonModuleMocks } from '../hooks/serverSettingsHooksTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useServerRetentionPolicy = vi.fn();

vi.mock('@/hooks/server/useServerRetentionPolicy', () => ({
    useServerRetentionPolicy,
}));

installServerSettingsHooksCommonModuleMocks();

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title, description }: any) => React.createElement('ItemGroup', { title, description }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

const { ServerRetentionSection } = await import('./ServerRetentionSection');

const LEGACY_KEEP_ALL = {
    policyVersion: 1,
    enabled: true,
    sessions: { mode: 'keep_forever' },
    accountChanges: { mode: 'keep_forever' },
    voiceSessionLeases: { mode: 'keep_forever' },
    userFeedItems: { mode: 'keep_forever' },
    sessionShareAccessLogs: { mode: 'keep_forever' },
    publicShareAccessLogs: { mode: 'keep_forever' },
    terminalAuthRequests: { mode: 'keep_forever' },
    accountAuthRequests: { mode: 'keep_forever' },
    authPairingSessions: { mode: 'keep_forever' },
    repeatKeys: { mode: 'keep_forever' },
    globalLocks: { mode: 'keep_forever' },
    automationRuns: { mode: 'keep_forever' },
    automationRunEvents: { mode: 'keep_forever' },
} as const;

function fullPolicy(domains: ReadonlyArray<Readonly<{ id: string; policy: Record<string, unknown> }>>, enabled = true) {
    return { status: 'ready', policy: { enabled, completeness: 'complete', domains } } as const;
}

async function renderSection() {
    return renderScreen(React.createElement(ServerRetentionSection, { serverId: 'server-a' }));
}

function texts(screen: Awaited<ReturnType<typeof renderSection>>): string[] {
    return screen.root.findAllByType('Item' as any).map((item) => String(item.props.title));
}

describe('ServerRetentionSection', () => {
    it('renders nothing without a Home to ask', async () => {
        useServerRetentionPolicy.mockReturnValue({ status: 'loading' });
        const screen = await renderScreen(React.createElement(ServerRetentionSection, { serverId: null }));
        expect(screen.root.findAllByType('ItemGroup' as any)).toHaveLength(0);
    });

    it('reserves the rows while the full policy is being read, and says nothing about it yet', async () => {
        useServerRetentionPolicy.mockReturnValue({ status: 'loading' });
        const screen = await renderSection();

        expect(screen.findByTestId('server-retention-load')).not.toBeNull();
        expect(screen.findByTestId('server-retention-summary')).toBeNull();
        expect(texts(screen)).not.toContain('server.retention.detailsUnavailable');
        expect(texts(screen)).not.toContain('server.retention.keepForever');
    });

    it('says the policy could not be read and offers Retry when the read failed', async () => {
        const retry = vi.fn();
        useServerRetentionPolicy.mockReturnValue({ status: 'failed', retry });
        const screen = await renderSection();

        // The read needs only this Home, so while it is unreachable the page's banner speaks for it.
        const load = screen.root.findAll((node) => node.props?.testID === 'server-retention-load' && node.props?.state)[0];
        expect(load?.props.state).toMatchObject({ kind: 'failed', homeServerIds: ['server-a'] });
        expect(screen.findByTestId('server-retention-load')?.props.title).toBe('server.retention.readFailed');
        expect(texts(screen)).not.toContain('server.retention.detailsUnavailable');
        // `Item` renders its trailing control from `rightElement`: the Retry button.
        await screen.findByTestId('server-retention-load')?.props.rightElement.props.action();
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it('lists each policy that deletes, with no summary, when the full policy answered', async () => {
        useServerRetentionPolicy.mockReturnValue(fullPolicy([
            { id: 'sessions', policy: { mode: 'delete_inactive', inactivityDays: 30 } },
            { id: 'sessionSidechainMessages', policy: { mode: 'delete_older_than', days: 7 } },
            { id: 'providerAccountUsageHistory', policy: { mode: 'delete_older_than', days: 90 } },
            { id: 'usageEvents', policy: { mode: 'keep_forever' } },
        ]));
        const screen = await renderSection();

        expect(screen.findByTestId('server-retention-summary')).toBeNull();
        expect(screen.findByTestId('server-retention-row-sessions')?.props).toMatchObject({
            title: 'server.retention.sessions',
            subtitle: 'server.retention.deleteInactiveSessionsDays',
        });
        expect(screen.findByTestId('server-retention-row-sessionSidechainMessages')).not.toBeNull();
        expect(screen.findByTestId('server-retention-row-providerAccountUsageHistory')).not.toBeNull();
        expect(screen.findByTestId('server-retention-row-usageEvents')).toBeNull();
    });

    it('says it cannot display every policy only when the full policy holds one this client cannot name', async () => {
        useServerRetentionPolicy.mockReturnValue(fullPolicy([
            { id: 'sessionSidechainMessages', policy: { mode: 'delete_older_than', days: 7 } },
            { id: 'futureDomain', policy: { mode: 'delete_older_than', days: 9 } },
        ]));
        const screen = await renderSection();

        expect(screen.findByTestId('server-retention-row-sessionSidechainMessages')).not.toBeNull();
        // The unknown domain is never shown by its raw id; the notice says something is not shown.
        expect(screen.findByTestId('server-retention-row-futureDomain')).toBeNull();
        expect(screen.findByTestId('server-retention-summary')?.props.title).toBe('server.retention.detailsUnavailable');
    });

    it('says so in one row when this Home keeps everything', async () => {
        useServerRetentionPolicy.mockReturnValue(fullPolicy([
            { id: 'sessionSidechainMessages', policy: { mode: 'delete_older_than', days: 7 } },
        ], false));
        const screen = await renderSection();

        expect(texts(screen)).toEqual(['server.retention.keepForever']);
    });

    it('does not claim there is no automatic deletion when an older Home answered with an incomplete policy', async () => {
        useServerRetentionPolicy.mockReturnValue({ status: 'ready', policy: LEGACY_KEEP_ALL });
        const screen = await renderSection();

        expect(screen.findByTestId('server-retention-summary')?.props.title).toBe('server.retention.detailsUnavailable');
    });
});
