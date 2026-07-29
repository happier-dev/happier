/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const React = await import('react');

    const View = React.forwardRef<
        HTMLDivElement,
        React.HTMLAttributes<HTMLDivElement> & Readonly<{ testID?: string }>
    >(function TestView({ children, testID: _testID, ...props }, ref) {
        return React.createElement('div', { ...props, ref }, children);
    });

    const Pressable = React.forwardRef<
        HTMLElement,
        Readonly<{
            accessibilityLabel?: string;
            accessibilityRole?: string;
            children?: React.ReactNode;
            href?: string;
            onPress?: () => void;
            style?: unknown;
            testID?: string;
        }> & React.HTMLAttributes<HTMLElement>
    >(function TestPressable(
        {
            accessibilityLabel,
            accessibilityRole,
            children,
            href,
            onPress,
            style: _style,
            testID: _testID,
            ...props
        },
        ref,
    ) {
        return React.createElement(
            href ? 'a' : 'button',
            {
                ...props,
                'aria-label': accessibilityLabel,
                href,
                onClick: onPress,
                ref,
                role: accessibilityRole,
            },
            children,
        );
    });

    return {
        Platform: {
            OS: 'web',
            select: <T,>(values: Readonly<{ web?: T; default?: T }>) => values.web ?? values.default,
        },
        Pressable,
        View,
    };
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/components/ui/status/StatusDot', () => ({ StatusDot: () => null }));
vi.mock('@/components/ui/buttons/IconButton', async () => {
    const React = await import('react');
    return {
        IconButton: (props: Readonly<{
            accessibilityLabel: string;
            onPress: () => void;
            testID?: string;
        }>) => React.createElement('button', {
            'aria-label': props.accessibilityLabel,
            'data-testid': props.testID,
            onClick: props.onPress,
        }),
    };
});
vi.mock('@/components/ui/text/Text', async () => {
    const React = await import('react');
    return {
        Text: React.forwardRef<
            HTMLSpanElement,
            React.HTMLAttributes<HTMLSpanElement>
        >(function TestText({ children, ...props }, ref) {
            return React.createElement('span', { ...props, ref }, children);
        }),
    };
});
vi.mock('./VoiceLevelVisualizer', () => ({ VoiceLevelVisualizer: () => null }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

describe('VoiceSurfaceHeader web disclosure semantics', () => {
    it('renders provider data as a button, not a Privacy settings link', async () => {
        const { VoiceSurfaceHeader } = await import('./VoiceSurfaceHeader');
        const host = document.createElement('div');
        const root = createRoot(host);
        const onOpenDataDisclosure = vi.fn();

        try {
            await act(async () => {
                root.render(
                    <VoiceSurfaceHeader
                        announceSubtitle={false}
                        bargeInLabel="Barge in"
                        canBargeIn={false}
                        isMicCaptureActive={false}
                        isMuted={false}
                        micBadgeStyle={{}}
                        micIconColor="currentColor"
                        microphoneActiveLabel="Microphone active"
                        microphoneInactiveLabel="Microphone inactive"
                        microphoneMutedLabel="Microphone muted"
                        onBargeIn={() => undefined}
                        dataDisclosureLabel="How OpenAI handles Codex Live data"
                        dataDisclosureTestID="voice-surface-data:sidebar"
                        onOpenDataDisclosure={onOpenDataDisclosure}
                        showDataDisclosure
                        providerLabel="Codex Live"
                        statusDotColor="currentColor"
                        statusLabel="Voice"
                        statusTextColor="currentColor"
                        styles={{}}
                        subtitle={null}
                        subtitleColor="currentColor"
                        surfaceState="idle"
                    />,
                );
            });

            const disclosureAction = host.querySelector('[data-testid="voice-surface-data:sidebar"]');
            expect(disclosureAction).toBeInstanceOf(HTMLButtonElement);
            expect(disclosureAction?.getAttribute('href')).toBeNull();
            expect(disclosureAction?.getAttribute('aria-label')).toBe('How OpenAI handles Codex Live data');

            await act(async () => {
                (disclosureAction as HTMLButtonElement).click();
            });
            expect(onOpenDataDisclosure).toHaveBeenCalledTimes(1);
            expect(host.textContent).not.toContain('Privacy');
        } finally {
            await act(async () => {
                root.unmount();
            });
        }
    });
});
