import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const routeParams = vi.hoisted(() => ({
    value: {} as Record<string, string | undefined>,
}));
const latestHostProps = vi.hoisted(() => ({ value: null as any }));

vi.mock('expo-router', () => ({
    Stack: { Screen: (props: any) => React.createElement('StackScreen', props) },
    useLocalSearchParams: () => routeParams.value,
}));
vi.mock('@/components/automations/gating/AutomationsGate', () => ({
    AutomationsGate: (props: any) => React.createElement(React.Fragment, null, props.children),
}));
vi.mock('@/components/automations/screens/AutomationEditorHostScreen', () => ({
    AutomationEditorHostScreen: (props: any) => {
        latestHostProps.value = props;
        return React.createElement('AutomationEditorHostScreen', props);
    },
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

describe('Automation edit route', () => {
    beforeEach(() => {
        routeParams.value = {};
        latestHostProps.value = null;
    });

    it('mounts the one plural editor host for the exact Automation identity', async () => {
        routeParams.value = { id: ' automation-42 ' };
        await renderScreen(React.createElement((await import('@/app/(app)/automations/edit')).default));

        expect(latestHostProps.value).toEqual({
            automationId: 'automation-42',
            exactTurnPrefill: null,
        });
    });

    it('passes only a complete typed exact-turn prefill to the shared host', async () => {
        routeParams.value = {
            id: 'automation-42',
            sourceSessionId: 'source-session',
            sourceTurnId: 'turn-7',
            sourceServerId: 'server-1',
        };
        await renderScreen(React.createElement((await import('@/app/(app)/automations/edit')).default));

        expect(latestHostProps.value).toEqual({
            automationId: 'automation-42',
            exactTurnPrefill: {
                sourceSessionId: 'source-session',
                sourceTurnId: 'turn-7',
                sourceServerId: 'server-1',
            },
        });
    });
});
