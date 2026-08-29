import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { HappierUiTheme } from '@happier-dev/plugin-ui/environment';
import { Spinner } from '@happier-dev/plugin-ui/components';

import { renderDeclarativeNode, type DeclarativeNodeRenderContext } from './declarativeNodes';

describe('declarative item action structure', () => {
    it('routes live loading state through the activity-aware shared Spinner adapter', () => {
        const rendered = renderDeclarativeNode({
            kind: 'state',
            path: 'root',
            state: 'loading',
            title: 'Loading reviews',
        }, {
            colors: {} as DeclarativeNodeRenderContext['colors'],
            presentationTheme: {
                colors: { textSecondary: '#777777' },
            } as unknown as HappierUiTheme,
            minimumTouchTarget: 44,
            useSharedSpinner: true,
            localize: (value) => typeof value === 'string' ? value : '',
            resolveAction: () => null,
            renderField: () => null,
            renderCollectionList: () => null,
        });

        expect(React.isValidElement(rendered)).toBe(true);
        const tile = (rendered as React.ReactElement<Readonly<{ children?: React.ReactNode }>>).props.children;
        expect(React.isValidElement(tile)).toBe(true);
        const icon = (tile as React.ReactElement<Readonly<{ icon?: React.ReactNode }>>).props.icon;
        expect(React.isValidElement(icon)).toBe(true);
        expect((icon as React.ReactElement).type).toBe(Spinner);
    });

    it('projects focus-visible and pressed state through the shared pressable style owner', () => {
        const context = {
            colors: {
                button: {
                    primary: { background: '#111111', tint: '#ffffff' },
                    secondary: { background: '#eeeeee' },
                },
                border: { default: '#777777' },
                text: { primary: '#222222' },
                state: { danger: { background: '#ffeeee', border: '#cc0000', foreground: '#990000' } },
            } as DeclarativeNodeRenderContext['colors'],
            presentationTheme: { colors: { focus: '#0055ff' } } as HappierUiTheme,
            minimumTouchTarget: 44,
            localize: (value: unknown) => typeof value === 'string' ? value : '',
            resolveAction: () => ({ key: 'acme.plugin/refresh', disabled: false, busy: false }),
            renderField: () => null,
            renderCollectionList: () => null,
        } satisfies DeclarativeNodeRenderContext;
        const rendered = renderDeclarativeNode({
            kind: 'action',
            path: 'root',
            action: 'refresh',
            label: 'Refresh',
        }, context) as React.ReactElement<Readonly<{ style?: unknown }>>;

        expect(rendered.props.style).toEqual(expect.any(Function));
        const style = rendered.props.style as (state: Readonly<{
            focused: boolean;
            pressed: boolean;
            disabled: boolean;
        }>) => Readonly<Record<string, unknown>>;
        expect(style({ focused: true, pressed: false, disabled: false })).toMatchObject({
            borderColor: '#0055ff',
            opacity: 1,
        });
        expect(style({ focused: false, pressed: true, disabled: false })).toMatchObject({
            borderColor: '#777777',
            opacity: 0.8,
        });
        expect(style({ focused: true, pressed: true, disabled: true })).toMatchObject({
            borderColor: '#0055ff',
            opacity: 0.5,
        });
    });

    it('retains one disabled primary-action host when an admitted action is temporarily unavailable', () => {
        const context: DeclarativeNodeRenderContext = {
            colors: {} as DeclarativeNodeRenderContext['colors'],
            presentationTheme: {} as HappierUiTheme,
            minimumTouchTarget: 44,
            localize: (value) => typeof value === 'string' ? value : '',
            resolveAction: () => ({
                key: 'acme.plugin/refresh',
                disabled: true,
                busy: true,
            }),
            renderField: () => null,
            renderCollectionList: () => null,
        };

        const rendered = renderDeclarativeNode({
            kind: 'item',
            path: 'root.children[0]',
            title: 'Refresh',
            action: 'refresh',
        }, context);
        expect(React.isValidElement(rendered)).toBe(true);
        const props = (rendered as React.ReactElement<Readonly<{
            disabled?: boolean;
            busy?: boolean;
            onPress?: () => void;
        }>>).props;
        expect(props).toMatchObject({ disabled: true, busy: true });
        expect(props.onPress).toEqual(expect.any(Function));
        expect(() => props.onPress?.()).not.toThrow();
    });

    it('does not manufacture an action host for a genuinely non-action item', () => {
        const resolveAction = vi.fn();
        const rendered = renderDeclarativeNode({
            kind: 'item',
            path: 'root.children[0]',
            title: 'Read only',
        }, {
            colors: {} as DeclarativeNodeRenderContext['colors'],
            presentationTheme: {} as HappierUiTheme,
            minimumTouchTarget: 44,
            localize: (value) => typeof value === 'string' ? value : '',
            resolveAction,
            renderField: () => null,
            renderCollectionList: () => null,
        });
        const props = (rendered as React.ReactElement<Readonly<{ onPress?: () => void }>>).props;
        expect(resolveAction).not.toHaveBeenCalled();
        expect(props.onPress).toBeUndefined();
    });

    it('uses the mounted direction for declarative logical icons', () => {
        const rendered = renderDeclarativeNode({
            kind: 'item',
            path: 'root.children[0]',
            title: 'Back',
            icon: 'back',
        }, {
            colors: {} as DeclarativeNodeRenderContext['colors'],
            presentationTheme: {} as HappierUiTheme,
            minimumTouchTarget: 44,
            direction: 'rtl',
            localize: (value) => typeof value === 'string' ? value : '',
            resolveAction: () => null,
            renderField: () => null,
            renderCollectionList: () => null,
        });

        const props = (rendered as React.ReactElement<Readonly<{
            icon?: React.ReactElement<Readonly<{ name?: string }>>;
        }>>).props;
        expect(props.icon?.props.name).toBe('arrow-right');
    });
});
