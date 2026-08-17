import * as React from 'react';
import { Platform } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';

import { QuietAction, TerminalAction, VoiceTransport } from './VoiceControls';

vi.mock('@/sync/store/hooks', () => ({ useLocalSetting: () => 1 }));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    return style && typeof style === 'object' ? { ...style } as Record<string, unknown> : {};
}

function readEffectiveTargetSize(node: ReactTestInstance): Readonly<{ width: number; height: number }> {
    const style = flattenStyle(node.props.style);
    const hitSlop = node.props.hitSlop;
    const inset = (edge: 'top' | 'right' | 'bottom' | 'left'): number => (
        typeof hitSlop === 'number' ? hitSlop : Number(hitSlop?.[edge] ?? 0)
    );
    return {
        width: Math.max(Number(style.width ?? 0), Number(style.minWidth ?? 0)) + inset('left') + inset('right'),
        height: Math.max(Number(style.height ?? 0), Number(style.minHeight ?? 0)) + inset('top') + inset('bottom'),
    };
}

describe('Voice controls interactive targets', () => {
    it('keeps every transport, quiet, and terminal action at the platform minimum', async () => {
        const screen = await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.4, energized: false, direction: 'none' }}
                previewTimeMs={1_100}
            >
                <VoiceTransport
                    live
                    canStart
                    muted={false}
                    canMute
                    labels={{
                        start: 'Start Voice',
                        end: 'End Voice',
                        startHint: 'Starts Voice',
                        endHint: 'Ends Voice',
                        startText: 'Start',
                        endText: 'End',
                        mute: 'Mute microphone',
                        unmute: 'Unmute microphone',
                    }}
                    onStart={vi.fn()}
                    onEnd={vi.fn()}
                    onToggleMute={vi.fn()}
                    onAction={vi.fn()}
                />
                <QuietAction label="Open conversation" onPress={vi.fn()} />
                <TerminalAction label="End session" accessibilityHint="Ends Voice" onPress={vi.fn()} />
            </VoiceEnergyProvider>,
        );

        const minimum = resolveMinimumInteractiveTargetSize(Platform.OS);
        for (const label of ['End Voice', 'Mute microphone', 'Open conversation', 'End session']) {
            const matches = screen.root.findAll((node) => (
                typeof node.type === 'string' && node.props?.accessibilityLabel === label
            ));
            expect(matches, label).toHaveLength(1);
            const target = readEffectiveTargetSize(matches[0]!);
            expect(target.width, `${label} width`).toBeGreaterThanOrEqual(minimum);
            expect(target.height, `${label} height`).toBeGreaterThanOrEqual(minimum);
        }

        await screen.unmount();
    });
});
