import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: createPassThroughComponent('Ionicons'),
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: createPassThroughComponent('View'),
            Pressable: createPassThroughComponent('Pressable'),
            Platform: {
                OS: 'ios',
                select: <T,>(values: { ios?: T; default?: T }) => values.ios ?? values.default,
            },
            InteractionManager: {
                runAfterInteractions: (cb: () => void) => {
                    cb();
                    return { cancel: () => undefined };
                },
            },
        });
    },
    text: () => createTextModuleMock({ translate: (key) => key }),
    unistyles: async () => await createUnistylesMock({
        theme: {
            colors: {
                groupped: { background: '#f5f5f5' },
                surface: '#fff',
                divider: '#ddd',
                text: '#111',
                textSecondary: '#666',
                textDestructive: '#d00',
                input: {
                    background: '#fafafa',
                    text: '#111',
                    placeholder: '#999',
                },
                button: {
                    primary: {
                        background: '#00f',
                        tint: '#fff',
                    },
                },
            },
        },
    }),
});

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: () => undefined,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList']));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'claude',
    getAgentCore: () => ({
        displayNameKey: 'agents.claude.displayName',
    }),
    isAgentId: () => true,
}));

vi.mock('@/utils/ui/clipboard', () => ({
    getClipboardStringTrimmedSafe: vi.fn(async () => 'resume-id'),
}));

describe('NewSessionResumeSelectionContent', () => {
    it('does not render inline modal-style header chrome inside the popover content', async () => {
        const { NewSessionResumeSelectionContent } = await import('./NewSessionResumeSelectionContent');

        const screen = await renderScreen(<NewSessionResumeSelectionContent
                    value=""
                    onChangeValue={() => {}}
                    onSave={() => {}}
                    onClear={() => {}}
                    onClose={() => {}}
                    agentType="claude"
                    maxHeight={460}
                    showInlineHeader={true}
                />);

        const textContent = screen.getTextContent();

        expect(screen.findAllByProps({ accessibilityLabel: 'common.close' })).toHaveLength(0);
        expect(textContent).not.toContain('newSession.resume.pickerTitle');
        expect(textContent).not.toContain('newSession.resume.subtitle');
    });

    it('caps popover height', async () => {
        const { NewSessionResumeSelectionContent } = await import('./NewSessionResumeSelectionContent');

        const screen = await renderScreen(<NewSessionResumeSelectionContent
                    value=""
                    onChangeValue={() => {}}
                    onSave={() => {}}
                    onClear={() => {}}
                    onClose={() => {}}
                    agentType="claude"
                    maxHeight={460}
                />);

        const rootView = screen.find((node) => {
            const style = node.props?.style;
            const styleArray = Array.isArray(style) ? style : [style];
            return styleArray.filter(Boolean).some((entry) => (entry as { maxHeight?: number }).maxHeight === 460);
        });
        const styleArray = Array.isArray(rootView?.props.style) ? rootView.props.style : [rootView?.props.style];
        const flattenedStyle = Object.assign({}, ...styleArray.filter(Boolean));

        expect(flattenedStyle.maxHeight).toBe(460);
    });
});
