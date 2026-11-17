import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACTIONS_SETTINGS_V1} from '@happier-dev/protocol/account/settings/accountSettings';
import { setActionApprovalOverride} from '@happier-dev/protocol/actions/actionSettings';
import { type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import { applyActionSettingsTargetControlState, resolveActionSettingsTargetControlState } from './resolveActionSettingsControlState';
import { ActionSettingsTargetModeControl } from './ActionSettingsTargetModeControl';
import { listActionSettingsTargetDefinitions } from './actionSettingsTargetDefinitions';

installNavigationCommonModuleMocks();
afterEach(standardCleanup);

function ControlHarness(props: Readonly<{
    actionId: ActionId;
    targetId: 'agent' | 'cli' | 'contextual_ui';
    Control: typeof import('./ActionSettingsTargetModeControl').ActionSettingsTargetModeControl;
}>) {
    const [settings, setSettings] = React.useState(() => setActionApprovalOverride({
        settings: DEFAULT_ACTIONS_SETTINGS_V1,
        actionId: props.actionId,
        surface: props.targetId === 'contextual_ui' ? 'ui' : props.targetId,
        approvalRequired: false,
    }));
    return <props.Control
        testIDPrefix="confirmation"
        accessibilityLabel="Action availability"
        controlState={resolveActionSettingsTargetControlState({ settings, actionId: props.actionId, targetId: props.targetId })}
        onChange={(value) => setSettings((current) => applyActionSettingsTargetControlState({ settings: current, actionId: props.actionId, targetId: props.targetId, value }))}
    />;
}

describe('ActionSettingsTargetModeControl', () => {
    it('does not offer a Resource approval prompt that the read/watch boundary cannot create', async () => {
        const actionId = 'acme.preview/resources/status';
        const target = listActionSettingsTargetDefinitions({ surfaces: {}, placements: [], resource: true })[0]!;
        const state = resolveActionSettingsTargetControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId, targetId: 'foreign_session_html', target });
        const screen = await renderScreen(<ActionSettingsTargetModeControl testIDPrefix="resource" accessibilityLabel="Resource access"
            controlState={state} onChange={() => { throw new Error('Resource Ask must not be selectable'); }} />);
        expect(screen.findByTestId('resource:mode:ask_first')?.props.accessibilityState.disabled).toBe(true);
        expect(screen.findByTestId('resource:mode:off')?.props.accessibilityState.checked).toBe(true);
        expect(screen.findByTestId('resource:mode:allowed')?.props.accessibilityState.disabled).toBe(false);
    });
    it('shows a use-only value as its word, with no choices to press', async () => {
        const state = resolveActionSettingsTargetControlState({ settings: setActionApprovalOverride({
            settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId: 'mcp.servers.signIn.start', surface: 'cli', approvalRequired: true,
        }), actionId: 'mcp.servers.signIn.start', targetId: 'cli' });
        const screen = await renderScreen(<ActionSettingsTargetModeControl testIDPrefix="shared" accessibilityLabel="Action availability"
            controlState={state} readOnly onChange={() => { throw new Error('A use-only value must not change'); }} />);
        expect(screen.findByTestId('shared:mode:value')).not.toBeNull();
        expect(screen.getTextContent()).toContain('settingsActions.modes.askFirst');
        for (const choice of ['off', 'ask_first', 'allowed', 'useDefault']) expect(screen.findByTestId(`shared:mode:${choice}`)).toBeNull();
    });
    it('offers Off, Ask first and Allowed, and returns an override to the inherited default', async () => {
        const screen = await renderScreen(<ControlHarness Control={ActionSettingsTargetModeControl} actionId="mcp.servers.signIn.start" targetId="cli" />);
        for (const choice of ['off', 'ask_first', 'allowed']) {
            expect(screen.findByTestId(`confirmation:mode:${choice}`)).not.toBeNull();
        }
        // The inherited default is a way the value is held, not a fourth choice.
        expect(screen.findByTestId('confirmation:mode:default')).toBeNull();
        expect(screen.findByTestId('confirmation:mode:allowed')?.props.accessibilityState.checked).toBe(true);
        await screen.pressByTestIdAsync('confirmation:mode:ask_first');
        expect(screen.findByTestId('confirmation:mode:ask_first')?.props.accessibilityState.checked).toBe(true);
        // Choosing the inherited answer restores the default without a second reset press.
        expect(screen.findByTestId('confirmation:mode:useDefault')).toBeNull();
        const inherited = ['ask_first', 'allowed'].map((id) => screen.findByTestId(`confirmation:mode:${id}`)).find((node) => node?.props.accessibilityState.checked);
        expect(inherited?.props.accessibilityLabel).toContain('capabilities.detail.inheritedValue');
    });

    it('chooses what the inherited default resolves to and says once that it is the default', async () => {
        const { DEFAULT_ACTIONS_SETTINGS_V1: settings} = await import('@happier-dev/protocol/account/settings/accountSettings');
        const controlState = resolveActionSettingsTargetControlState({ settings, actionId: 'machines.storage.trash.move', targetId: 'agent' });
        const screen = await renderScreen(<ActionSettingsTargetModeControl
            testIDPrefix="confirmation"
            accessibilityLabel="Action availability"
            controlState={controlState}
            onChange={() => {}}
        />);
        expect(screen.findByTestId('confirmation:mode:default')).toBeNull();
        expect(screen.findByTestId('confirmation:mode:useDefault')).toBeNull();
        const effective = controlState.kind === 'approval' && controlState.approvalRequiredByPolicy ? 'ask_first' : 'allowed';
        const chosen = screen.findByTestId(`confirmation:mode:${effective}`);
        expect(chosen?.props.accessibilityState.checked).toBe(true);
        expect(chosen?.props.accessibilityLabel).toContain('capabilities.detail.inheritedValue');
        // "Ask first" is said once: no segment repeats another segment's words.
        expect(screen.getTextContent()).not.toMatch(/common\.default/);
    });

    it.each(['machines.resources.policy.set', 'machines.storage.trash.move'] as const)(
        'keeps the user waiver available for resource Action %s',
        async (actionId) => {
            const screen = await renderScreen(<ControlHarness Control={ActionSettingsTargetModeControl} actionId={actionId} targetId="agent" />);
            expect(screen.findByTestId('confirmation:mode:allowed')?.props.accessibilityState.checked).toBe(true);
            expect(screen.findByTestId('confirmation:mode:useDefault')).not.toBeNull();
        },
    );
});
