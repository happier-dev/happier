import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@hugeicons/react-native', () => ({
    HugeiconsIcon: (props: Record<string, unknown>) => React.createElement('HugeiconsIcon', props),
}));

import { SessionStartFailureBanner } from './SessionStartFailureBanner';

const notice = {
    code: 'native_agent_privileged_effect_authority_unavailable',
    message: 'Runner daemon authority is unavailable. Check the target Machine, then retry the Session.',
};

describe('SessionStartFailureBanner', () => {
    it('names the stored cause and retries through the supplied Resume owner', async () => {
        const run = vi.fn();
        const screen = await renderScreen(
            <SessionStartFailureBanner notice={notice} retry={{ run, busy: false }} />,
        );
        expect(screen.getTextContent()).toContain('Runner daemon authority is unavailable');
        await pressTestInstanceAsync(screen.findByTestId('session-start-failure-retry'));
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('offers no action that cannot run', async () => {
        const screen = await renderScreen(<SessionStartFailureBanner notice={notice} retry={null} />);
        expect(screen.getTextContent()).toContain('Runner daemon authority is unavailable');
        expect(screen.findByTestId('session-start-failure-retry')).toBeNull();
    });

    it('opens plugin recovery for a disabled Agent while its Machine is unavailable', async () => {
        const managePlugin = vi.fn();
        const screen = await renderScreen(<SessionStartFailureBanner
            notice={{ code: 'plugin_disabled', message: 'This Agent plugin is disabled.', retryable: false }}
            retry={null}
            managePlugin={managePlugin}
        />);
        await pressTestInstanceAsync(screen.findByTestId('session-start-failure-manage-plugin'));
        expect(managePlugin).toHaveBeenCalledOnce();
        expect(screen.findByTestId('session-start-failure-retry')).toBeNull();
    });

});
