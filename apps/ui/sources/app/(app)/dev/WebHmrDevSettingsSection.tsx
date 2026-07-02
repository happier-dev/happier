import * as React from 'react';
import { Platform } from 'react-native';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
    readWebHmrOptOutRuntimeState,
    setWebHmrOptOutDisabledForWebTab,
    type WebHmrOptOutRuntimeState,
} from '@/dev/webHmrOptOut/webHmrOptOut';

function isWebDevRuntime(): boolean {
    return Platform.OS === 'web' && (typeof __DEV__ !== 'undefined' ? __DEV__ : false);
}

function readCurrentRuntimeState(): WebHmrOptOutRuntimeState {
    if (typeof window === 'undefined') {
        return readWebHmrOptOutRuntimeState({ sessionStorage: null });
    }

    return readWebHmrOptOutRuntimeState({
        sessionStorage: window.sessionStorage,
        globalTarget: globalThis,
    });
}

function setCurrentRuntimeDisabled(disabled: boolean): WebHmrOptOutRuntimeState {
    if (typeof window === 'undefined') {
        return readWebHmrOptOutRuntimeState({ sessionStorage: null });
    }

    return setWebHmrOptOutDisabledForWebTab({
        disabled,
        sessionStorage: window.sessionStorage,
        globalTarget: globalThis,
    });
}

function reloadCurrentWebTab(): void {
    if (typeof window === 'undefined') {
        return;
    }

    window.location.reload();
}

function describeRuntimeState(state: WebHmrOptOutRuntimeState): string {
    const runtime = state.guardInstalled
        ? 'Expo web / Metro runtime detected'
        : 'Expo web / Metro runtime';
    const status = state.enabled ? 'enabled for this tab' : 'disabled for this tab';
    const reload = state.requiresPageReload ? 'Changes reload this tab.' : '';
    return `${runtime}. Fast Refresh / HMR is ${status}. ${reload}`.trim();
}

export function WebHmrDevSettingsSection(): React.ReactElement | null {
    const [state, setState] = React.useState<WebHmrOptOutRuntimeState>(() => readCurrentRuntimeState());

    const setHmrEnabled = React.useCallback((enabled: boolean) => {
        const nextState = setCurrentRuntimeDisabled(!enabled);
        setState(nextState);
        reloadCurrentWebTab();
    }, []);

    if (!isWebDevRuntime() || !state.available) {
        return null;
    }

    return (
        <ItemGroup title="Hot Reload">
            <Item
                testID="dev-web-hmr-toggle-row"
                title="Fast Refresh / HMR"
                subtitle={describeRuntimeState(state)}
                rightElement={
                    <Switch
                        testID="dev-web-hmr-toggle"
                        value={state.enabled}
                        onValueChange={setHmrEnabled}
                    />
                }
                showChevron={false}
                onPress={() => setHmrEnabled(!state.enabled)}
            />
        </ItemGroup>
    );
}
