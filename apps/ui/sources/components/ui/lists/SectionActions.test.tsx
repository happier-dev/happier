import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

const { SectionActionButton } = await import('./SectionActionButton');
const { SectionButtonRow } = await import('./SectionButtonRow');

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function hostTexts(screen: Screen): string[] {
    return screen.root
        .findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string')
        .map((node) => node.props.children as string);
}

describe('SectionActionButton', () => {
    it('is a named button that runs the section action', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <SectionActionButton testID="members.add" title="Add member" icon="plus" onPress={onPress} />,
        );
        expect(hostTexts(screen)).toContain('Add member');
        await screen.pressByTestIdAsync('members.add');
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('does not run while unavailable or busy', async () => {
        const onPress = vi.fn();
        const disabled = await renderScreen(
            <SectionActionButton testID="members.add" title="Add member" icon="plus" disabled onPress={onPress} />,
        );
        expect(disabled.findHostByTestId('members.add')).not.toBeNull();
        await disabled.pressByTestIdAsync('members.add').catch(() => undefined);
        const busy = await renderScreen(
            <SectionActionButton testID="members.refresh" title="Refresh" icon="arrow-clockwise" loading onPress={onPress} />,
        );
        expect(busy.findHostByTestId('members.refresh')).not.toBeNull();
        await busy.pressByTestIdAsync('members.refresh').catch(() => undefined);
        expect(onPress).not.toHaveBeenCalled();
    });

    it('announces whether the thing it opens in place is open', async () => {
        const screen = await renderScreen(
            <SectionActionButton testID="members.pick" title="Choose" icon="plus" expanded onPress={() => {}} />,
        );
        const host = screen.findHostByTestId('members.pick');
        expect(host?.props.accessibilityState?.expanded ?? host?.props['aria-expanded']).toBe(true);
    });

    it('starts a text-only action on its label, with no empty glyph slot before it (DEPLOY-REACCEPT-1113 D5)', async () => {
        const screen = await renderScreen(
            <SectionActionButton testID="definition.edit" title="Edit" onPress={() => {}} />,
        );
        // The button component the section action renders (its props name its display), not a host node.
        const [button] = screen.root.findAll((node) => typeof node.type !== 'string' && node.props.display === 'inverted');
        expect(button).toBeDefined();
        expect('leading' in button!.props).toBe(false);
        expect('trailing' in button!.props).toBe(false);
    });
});

describe('SectionButtonRow', () => {
    it('puts the trailing (irreversible) action after the others, at the far edge', async () => {
        const screen = await renderScreen(
            <SectionButtonRow trailing={React.createElement('Button', { id: 'delete' })}>
                {React.createElement('Button', { id: 'save' })}
                {React.createElement('Button', { id: 'cancel' })}
            </SectionButtonRow>,
        );
        const buttons = screen.root.findAllByType('Button' as never).map((node) => node.props.id);
        expect(buttons).toEqual(['save', 'cancel', 'delete']);
    });

    it('announces a form refusal but keeps a consequence note static', async () => {
        const refusal = await renderScreen(
            <SectionButtonRow footnote="Enter a name first." footnoteTone="danger" footnoteTestID="form.error">
                {React.createElement('Button')}
            </SectionButtonRow>,
        );
        const error = refusal.findHostByTestId('form.error');
        expect(refusal.getTextContent()).toContain('Enter a name first.');
        expect(error?.props.accessibilityRole).toBe('alert');
        expect(error?.props.accessibilityLiveRegion).toBe('assertive');

        const note = await renderScreen(
            <SectionButtonRow footnote="Deleting removes the Team for everyone." footnoteTestID="form.note">
                {React.createElement('Button')}
            </SectionButtonRow>,
        );
        expect(note.findHostByTestId('form.note')?.props.accessibilityRole).toBeUndefined();
    });

    it('renders no footnote line without a message', async () => {
        const screen = await renderScreen(
            <SectionButtonRow footnote={null} footnoteTestID="form.error">{React.createElement('Button')}</SectionButtonRow>,
        );
        expect(screen.findHostByTestId('form.error')).toBeNull();
    });
});
