import * as React from 'react';
import { StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { invokeTestInstanceHandler, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '../lists/uiListsTestHelpers';
import { InlineAddExpander } from './InlineAddExpander';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installUiListsCommonModuleMocks();

describe('InlineAddExpander', () => {
    it('keeps compact Save and Cancel buttons with 44px touch targets and blocks disabled Save', async () => {
        vi.stubGlobal('matchMedia', (query: string) => ({
            matches: query === '(pointer: coarse)' || query === '(hover: none)',
        }));
        const onSave = vi.fn();
        const onCancel = vi.fn();
        try {
            const screen = await renderScreen(
                <InlineAddExpander isOpen onOpenChange={() => {}} title="Add variable" trigger={null}
                    onSave={onSave} onCancel={onCancel} saveDisabled saveLabel="Save" cancelLabel="Cancel"
                    saveTestID="add-save" cancelTestID="add-cancel">
                    {React.createElement('Text', null, 'Variable fields')}
                </InlineAddExpander>,
            );
            try {
                const save = screen.findHostByTestId('add-save');
                const cancel = screen.findHostByTestId('add-cancel');
                const height = HAPPIER_PAGE_METRICS.controlHeightPx;
                for (const button of [save, cancel]) {
                    if (!button) throw new Error('Missing inline action button');
                    expect(StyleSheet.flatten(button.props.style)?.minHeight).toBeUndefined();
                    expect(button.findAll((node) => typeof node.type === 'string'
                        && StyleSheet.flatten(node.props.style)?.minHeight === height)).toHaveLength(1);

                    // The host renderer has no layout engine. Report the compact pill's measured box.
                    await act(async () => invokeTestInstanceHandler(button, 'onLayout', {
                        nativeEvent: { layout: { width: 80, height } },
                    }));
                    const [frame] = button.findAll((node) => typeof node.type === 'string'
                        && node.props.dataSet?.happierHitArea === 'true');
                    const extension = frame
                        ? -frame.props.style.top - frame.props.style.bottom
                        : button.props.hitSlop?.top + button.props.hitSlop?.bottom;
                    expect(height + extension).toBe(44);
                }
                expect(save?.props.accessibilityState.disabled).toBe(true);
                await pressTestInstanceAsync(save, 'Save');
                await pressTestInstanceAsync(cancel, 'Cancel');
                expect(onSave).not.toHaveBeenCalled();
                expect(onCancel).toHaveBeenCalledOnce();
            } finally {
                await screen.unmount();
            }
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('lets a section own the trigger without duplicating it inside the form, preserving save and cancel', async () => {
        const onSave = vi.fn();
        const onCancel = vi.fn();
        const screen = await renderScreen(
            <InlineAddExpander isOpen onOpenChange={() => {}} title="Add variable" trigger={null}
                onSave={onSave} onCancel={onCancel} saveLabel="Save" cancelLabel="Cancel"
                saveTestID="add-save" cancelTestID="add-cancel">
                {React.createElement('Text', null, 'Variable fields')}
            </InlineAddExpander>,
        );
        const hostTexts = screen.root.findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string')
            .map((node) => node.props.children as string);
        expect(hostTexts).not.toContain('Add variable');
        expect(hostTexts).toContain('Variable fields');
        const save = screen.findByTestId('add-save')!;
        const cancel = screen.findByTestId('add-cancel')!;
        await act(async () => save.props.onPress());
        await act(async () => cancel.props.onPress());
        expect(onSave).toHaveBeenCalledOnce();
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it('shows its save in flight while the owner says it is saving (DEPLOY-REACCEPT-1113E P2)', async () => {
        const screen = await renderScreen(
            <InlineAddExpander isOpen onOpenChange={() => {}} title="Add domain" trigger={null}
                onSave={() => {}} onCancel={() => {}} saveLabel="Add domain" cancelLabel="Cancel" saveDisabled saving
                saveTestID="add-save" cancelTestID="add-cancel">
                {React.createElement('Text', null, 'Domain fields')}
            </InlineAddExpander>,
        );
        // The save button component (it names its own testID and display props), not its host view.
        const save = screen.root.findAll((node) => typeof node.type !== 'string' && node.props.testID === 'add-save' && 'title' in node.props)[0];
        expect(save?.props.loading).toBe(true);
    });
});
