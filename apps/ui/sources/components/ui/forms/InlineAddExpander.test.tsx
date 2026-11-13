import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '../lists/uiListsTestHelpers';
import { InlineAddExpander } from './InlineAddExpander';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installUiListsCommonModuleMocks();

describe('InlineAddExpander', () => {
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
