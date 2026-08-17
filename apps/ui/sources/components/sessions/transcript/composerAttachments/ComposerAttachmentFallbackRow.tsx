import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { StatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';

import type { TranscriptComposerAttachment } from './messageComposerAttachments';

export type ComposerAttachmentFallbackRowProps = Readonly<{
    messageId: string;
    attachments: readonly TranscriptComposerAttachment[];
}>;

function resolveStatusPillVariant(tone: TranscriptComposerAttachment['tone']): StatusPillVariant {
    if (tone === 'success') return 'success';
    if (tone === 'warning') return 'warning';
    if (tone === 'danger') return 'danger';
    if (tone === 'info') return 'info';
    return 'neutral';
}

function accessibleAttachmentLabel(attachment: TranscriptComposerAttachment): string {
    return [attachment.typeLabel, attachment.label, attachment.description]
        .filter((part): part is string => part !== null)
        .join(' — ');
}

/**
 * Immutable host-only fallback for admitted composer attachments in transcript
 * history. This deliberately consumes no attachment value, catalog, renderer,
 * plugin action, or live availability state.
 */
export const ComposerAttachmentFallbackRow = React.memo((props: ComposerAttachmentFallbackRowProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    if (props.attachments.length === 0) return null;

    return (
        <View style={styles.row}>
            {props.attachments.map((attachment) => {
                const testID = `transcript-composer-attachment:${props.messageId}:${attachment.instanceId}`;
                const label = `${attachment.typeLabel}: ${attachment.label}`;
                return (
                    <View
                        key={attachment.instanceId}
                        testID={testID}
                        accessibilityRole="text"
                        accessibilityLabel={accessibleAttachmentLabel(attachment)}
                        style={styles.attachment}
                    >
                        <StatusPill
                            variant={resolveStatusPillVariant(attachment.tone)}
                            label={label}
                            labelVariant="phrase"
                            labelNumberOfLines={1}
                            leading={(
                                <Icon
                                    name={resolvePluginUiIconName(attachment.icon)}
                                    size={ICON_SIZE.xs}
                                    color={theme.colors.state[resolveStatusPillVariant(attachment.tone)].foreground}
                                />
                            )}
                            accessibilityLabel={accessibleAttachmentLabel(attachment)}
                        />
                        {attachment.description ? (
                            <Text style={styles.description}>{attachment.description}</Text>
                        ) : null}
                    </View>
                );
            })}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 8,
        maxWidth: '100%',
        minWidth: 0,
    },
    attachment: {
        flexShrink: 1,
        maxWidth: '100%',
        minWidth: 0,
    },
    description: {
        color: theme.colors.text.secondary,
        flexShrink: 1,
        marginTop: 2,
        minWidth: 0,
    },
}));
