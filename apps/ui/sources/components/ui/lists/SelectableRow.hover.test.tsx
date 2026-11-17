import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

// Only OS hosts, the theme runtime and platform services are substituted.
installUiListsCommonModuleMocks();
const { SelectableRow } = await import('./SelectableRow');

// Both rail More-menu rows and Account ActionListSection rows use this owner.
describe('SelectableRow hover lifecycle', () => {
    it.each(['default', 'slim', 'selectable'] as const)('keeps a %s row usable through hover and exit', async variant => {
        let presses = 0;
        const screen = await renderScreen(<SelectableRow testID="row" title="Open" variant={variant} presentation="menu" onPress={() => { presses++; }} />);
        const host = () => screen.findHostByTestId('row')!;
        // The native host owns calling this callback for resting and pressed paint.
        expect(() => host().props.style({ pressed: false })).not.toThrow();
        await act(async () => host().props.onMouseEnter());
        expect(() => host().props.style({ pressed: false })).not.toThrow();
        await act(async () => host().props.onPress());
        expect(presses).toBe(1);
        await act(async () => host().props.onMouseLeave());
        expect(() => host().props.style({ pressed: true })).not.toThrow();
    });
});
