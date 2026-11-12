import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginUiSurfaceNoticeContext } from '@happier-dev/plugin-ui/advanced';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { useClaimableSurfaceNotice } from './claimableSurfaceNotice';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

afterEach(standardCleanup);

it('lets a body claim one Machine notice through an offline notice, and releases both hosts', async () => {
    const manage = vi.fn();
    const retry = vi.fn();
    const machine = { sentence: 'Installed but not ready', action: { label: 'Manage plugin', onPress: manage } };
    const offline = { sentence: 'Offline, nothing cached', action: { label: 'Retry', onPress: retry } };
    let release: (() => void) | undefined;
    function Body() {
        const notice = React.useContext(PluginUiSurfaceNoticeContext);
        React.useEffect(() => {
            release = notice?.claim('body');
            return () => release?.();
        }, [notice]);
        return React.createElement('Body', { notice });
    }
    function Offline() {
        const { notice, claimed } = useClaimableSurfaceNotice(offline);
        return <PluginUiSurfaceNoticeContext.Provider value={notice}>
            {claimed ? null : React.createElement('OfflineHost')}
            <Body />
        </PluginUiSurfaceNoticeContext.Provider>;
    }
    function Machine() {
        const { notice, claimed } = useClaimableSurfaceNotice(machine);
        return <PluginUiSurfaceNoticeContext.Provider value={notice}>
            {claimed ? null : React.createElement('MachineHost')}
            <Offline />
        </PluginUiSurfaceNoticeContext.Provider>;
    }
    const screen = await renderScreen(<Machine />);
    expect(screen.findAllByType('MachineHost')).toHaveLength(0);
    expect(screen.findAllByType('OfflineHost')).toHaveLength(0);
    expect(screen.findByType('Body').props.notice.sentence).toBe(machine.sentence);
    screen.findByType('Body').props.notice.action.onPress();
    expect(manage).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    await act(async () => release?.());
    expect(screen.findAllByType('MachineHost')).toHaveLength(1);
    expect(screen.findAllByType('OfflineHost')).toHaveLength(1);
});
