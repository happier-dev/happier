import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputSimpleOptionsPopover } from '@/components/sessions/agentInput/components/AgentInputSimpleOptionsPopover';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
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

type TranscriptStorageChipProps = Readonly<{
    transcriptStorage: NewSessionTranscriptStorage;
    onStorageChange: (next: NewSessionTranscriptStorage) => void;
    ctx: AgentInputExtraActionChipRenderContext;
}>;

const TranscriptStorageChip = React.memo(function TranscriptStorageChip(props: TranscriptStorageChipProps) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const isDirect = props.transcriptStorage === 'direct';
    const options = React.useMemo(() => buildTranscriptStorageOptions(), []);

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

            <AgentInputSimpleOptionsPopover
                open={open}
                anchorRef={anchorRef}
                title={t('settingsSession.defaultStorage.title')}
                options={options}
                selectedOptionId={props.transcriptStorage}
                onSelect={(selectedId) => {
                    if (selectedId === 'direct' || selectedId === 'persisted') {
                        props.onStorageChange(selectedId);
                    }
                    setOpen(false);
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
    const options = buildTranscriptStorageOptions();

    return {
        key: 'new-session-storage',
        controlId: 'storage',
        collapsedOptionsPopover: {
            presentation: 'simple',
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
            options,
            selectedOptionId: params.transcriptStorage,
            onSelect: (selectedId) => {
                if (selectedId === 'direct' || selectedId === 'persisted') {
                    params.onStorageChange(selectedId);
                }
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
