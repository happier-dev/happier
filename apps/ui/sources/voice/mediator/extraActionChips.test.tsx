import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { Text } from 'react-native';
import { getVoiceMediatorExtraActionChips } from './extraActionChips';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('getVoiceMediatorExtraActionChips', () => {
    it('returns empty when not local mediator mode', () => {
        expect(getVoiceMediatorExtraActionChips({
            voiceProviderId: 'local_openai_stt_tts',
            voiceLocalConversationMode: 'direct_session',
            onCommitPress: async () => {},
        })).toEqual([]);

        expect(getVoiceMediatorExtraActionChips({
            voiceProviderId: 'off',
            voiceLocalConversationMode: 'mediator',
            onCommitPress: async () => {},
        })).toEqual([]);
    });

    it('renders a commit chip and calls handler on press', () => {
        const onCommitPress = vi.fn(async () => {});
        const chips = getVoiceMediatorExtraActionChips({
            voiceProviderId: 'local_openai_stt_tts',
            voiceLocalConversationMode: 'mediator',
            onCommitPress,
            label: 'Commit',
            accessibilityLabel: 'Commit',
        });
        expect(chips.length).toBe(1);

        const chip = chips[0]!;
        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                <>
                    {chip.render({
                        chipStyle: () => ({}),
                        showLabel: true,
                        iconColor: '#000',
                        textStyle: {},
                    })}
                </>,
            );
        });

        const pressables = tree?.root.findAll((n) => typeof n.props?.onPress === 'function');
        expect(pressables?.length).toBeGreaterThan(0);

        act(() => {
            pressables?.[0]?.props?.onPress?.();
        });

        expect(onCommitPress).toHaveBeenCalledTimes(1);
    });

    it('hides label when showLabel=false and uses default accessibility label fallback', () => {
        const chips = getVoiceMediatorExtraActionChips({
            voiceProviderId: 'local_openai_stt_tts',
            voiceLocalConversationMode: 'mediator',
            onCommitPress: async () => {},
        });
        const chip = chips[0]!;
        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                <>
                    {chip.render({
                        chipStyle: () => ({}),
                        showLabel: false,
                        iconColor: '#000',
                        textStyle: {},
                    })}
                </>,
            );
        });

        const textNodes = tree?.root.findAllByType(Text);
        expect(textNodes?.length ?? 0).toBe(0);

        const pressables = tree?.root.findAll((n) => typeof n.props?.onPress === 'function');
        expect(pressables?.[0]?.props?.accessibilityLabel).toBe('Commit');
    });
});
