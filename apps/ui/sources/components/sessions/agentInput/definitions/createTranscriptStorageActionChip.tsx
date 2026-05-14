import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { NewSessionTranscriptStorage } from '@/components/sessions/new/modules/newSessionTranscriptStorage';

function buildTranscriptStorageOptions(): ReadonlyArray<AgentInputChipPickerOption> {
    return [
        {
            id: 'persisted',
            label: t('sessionsList.storagePersistedTab'),
            subtitle: t('settingsSession.defaultStorage.persistedSubtitle'),
        },
        {
            id: 'direct',
            label: t('sessionsList.storageDirectTab'),
            subtitle: t('settingsSession.defaultStorage.directSubtitle'),
        },
    ];
}

/**
 * Shared root-step builder used by BOTH the chip-definition factory (action-menu
 * route) and the inline `TranscriptStorageChip` (direct chip route).
 * Per-option `onSelect` callbacks are the canonical action source for
 * `presentation: 'list'` descriptors.
 */
export function buildTranscriptStorageRootStep(params: Readonly<{
    onSelect?: (selectedId: NewSessionTranscriptStorage) => void;
}> = {}): SelectionListStep {
    const options = buildTranscriptStorageOptions();
    return {
        id: 'transcript-storage-root',
        title: t('settingsSession.defaultStorage.title'),
        sections: [
            {
                kind: 'static',
                id: 'transcript-storage',
                options: options.map((option) => ({
                    id: option.id,
                    label: option.label,
                    subtitle: option.subtitle,
                    onSelect: params.onSelect && (option.id === 'direct' || option.id === 'persisted')
                        ? () => params.onSelect!(option.id as NewSessionTranscriptStorage)
                        : undefined,
                })),
            },
        ],
    };
}

type TranscriptStorageChipProps = Readonly<{
    transcriptStorage: NewSessionTranscriptStorage;
    onStorageChange: (next: NewSessionTranscriptStorage) => void;
    ctx: AgentInputExtraActionChipRenderContext;
}>;

const TranscriptStorageChip = React.memo(function TranscriptStorageChip(props: TranscriptStorageChipProps) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const isDirect = props.transcriptStorage === 'direct';
    const rootStep = React.useMemo(
        () => buildTranscriptStorageRootStep({ onSelect: props.onStorageChange }),
        [props.onStorageChange],
    );

    return (
        <>
            <View ref={anchorRef} collapsable={false} style={{ alignSelf: 'flex-start' }}>
                <Pressable
                    testID="agent-input-storage-chip"
                    onPress={() => setOpen((current) => !current)}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={({ pressed }) => props.ctx.chipStyle(Boolean(pressed))}
                    accessibilityRole="button"
                    accessibilityLabel={t('settingsSession.defaultStorage.title')}
                >
                    {normalizeNodeForView(
                        <Ionicons
                            name={isDirect ? 'radio-outline' : 'save-outline'}
                            size={16}
                            color={props.ctx.iconColor}
                        />,
                    )}
                    {props.ctx.showLabel ? (
                        <Text numberOfLines={1} style={props.ctx.textStyle}>
                            {isDirect
                                ? t('sessionsList.storageDirectTab')
                                : t('sessionsList.storagePersistedTab')}
                        </Text>
                    ) : null}
                </Pressable>
            </View>

            <AgentInputSelectionListPopover
                open={open}
                anchorRef={anchorRef}
                rootStep={rootStep}
                selectedOptionId={props.transcriptStorage}
                onSelect={() => {
                    // FR4-W1-CHIP: documented no-op. Per-row
                    // `SelectionListOption.onSelect` inside `rootStep`
                    // dispatched the storage mutation. The wrapper
                    // `AgentInputSelectionListPopover` owns the close path and
                    // defers `onRequestClose` on web internally — calling
                    // `setOpen(false)` here would close the popover
                    // synchronously and allow the click to fall through to
                    // the chip anchor (re-opening it).
                }}
                onRequestClose={() => setOpen(false)}
                maxHeightCap={320}
            />
        </>
    );
});

export function createTranscriptStorageActionChip(params: Readonly<{
    transcriptStorage: NewSessionTranscriptStorage;
    onStorageChange: (next: NewSessionTranscriptStorage) => void;
}>): AgentInputExtraActionChip {
    const isDirect = params.transcriptStorage === 'direct';
    const rootStep = buildTranscriptStorageRootStep({ onSelect: params.onStorageChange });

    return {
        key: 'new-session-storage',
        controlId: 'storage',
        collapsedOptionsPopover: {
            presentation: 'list',
            title: t('settingsSession.defaultStorage.title'),
            label: isDirect
                ? t('sessionsList.storageDirectTab')
                : t('sessionsList.storagePersistedTab'),
            icon: (tint) => normalizeNodeForView(
                <Ionicons
                    name={isDirect ? 'radio-outline' : 'save-outline'}
                    size={16}
                    color={tint}
                />,
            ),
            rootStep,
            selectedOptionId: params.transcriptStorage,
            onSelect: () => {
                // List-mode option mutations live on per-option SelectionListOption.onSelect
                // (set inside `buildTranscriptStorageRootStep`). The overlay route
                // closes on selection but does NOT call this descriptor-level callback.
                // Documented no-op for parity with the chip-picker contract.
            },
            maxHeightCap: 320,
        },
        render: (ctx) => (
            <TranscriptStorageChip
                transcriptStorage={params.transcriptStorage}
                onStorageChange={params.onStorageChange}
                ctx={ctx}
            />
        ),
    };
}
