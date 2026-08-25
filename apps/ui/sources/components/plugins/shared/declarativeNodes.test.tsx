import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { HappierUiTheme } from '@happier-dev/plugin-ui/environment';

import { renderDeclarativeNode, type DeclarativeNodeRenderContext } from './declarativeNodes';

describe('declarative item action structure', () => {
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

        const props = (rendered as React.ReactElement<Readonly<{ icon?: React.ReactElement }>>).props;
        expect(props.icon?.props.name).toBe('arrow-right');
    });
});
