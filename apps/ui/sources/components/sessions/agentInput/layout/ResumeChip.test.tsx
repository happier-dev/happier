import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                    React.createElement('Pressable', props, props.children),
                                Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                    React.createElement('Text', props, props.children),
                                ActivityIndicator: (props: Record<string, unknown>) =>
                                    React.createElement('ActivityIndicator', props, null),
                            }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

describe('ResumeChip', () => {
    it('does not emit raw text nodes under Pressable when icons render as text on web', async () => {
        const { ResumeChip } = await import('./ResumeChip');

        const screen = await renderScreen(<ResumeChip
                    onPress={() => {}}
                    showLabel={false}
                    resumeSessionId={null}
                    iconColor="#000"
                    labelTitle="Resume"
                    labelOptional="Optional"
                    pressableStyle={() => ({})}
                    textStyle={{}}
                />);

        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
        expect(screen.findByTestId('agent-input-resume-chip')).toBeTruthy();
    });

    it('renders a single-line ellipsized label when showLabel is true', async () => {
        const { ResumeChip } = await import('./ResumeChip');

        const screen = await renderScreen(<ResumeChip
            onPress={() => {}}
            showLabel={true}
            resumeSessionId={'sess-123'}
            iconColor="#000"
            labelTitle="Resume"
            labelOptional="Optional"
            pressableStyle={() => ({})}
            textStyle={{}}
        />);

        const labels = screen.tree.root.findAll((node: any) => node?.type === 'Text');
        const labelNode = labels.find((node: any) => String(node?.props?.children ?? '') === 'agentInput.resumeChip.withId');
        expect(labelNode).toBeTruthy();
        expect(labelNode?.props?.numberOfLines).toBe(1);
        expect(labelNode?.props?.ellipsizeMode).toBe('tail');
    });
});
