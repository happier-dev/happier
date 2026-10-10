import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * "Name this account" (lab `csvc` D2): a small popover under the account's name with its current name, what
 * changes (only the name in Happier) and Save. Anchored to the pencil beside the title; Esc or outside closes.
 */
export const ConnectedAccountRenamePopover = React.memo(function ConnectedAccountRenamePopover(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<React.ComponentRef<typeof View> | null>;
    currentLabel: string;
    serviceLabel: string;
    onSave: (label: string) => void | Promise<void>;
    onRequestClose: () => void;
    testID: string;
}>) {
    const [value, setValue] = React.useState(props.currentLabel);
    const [saving, setSaving] = React.useState(false);
    React.useEffect(() => {
        if (props.open) setValue(props.currentLabel);
    }, [props.currentLabel, props.open]);
    if (!props.open) return null;
    const save = async () => {
        const next = value.trim();
        if (next.length === 0 || saving) return;
        setSaving(true);
        try { await props.onSave(next); }
        catch { /* The write owner presents its failure; leave the draft available for retry. */ }
        finally { setSaving(false); }
    };
    return (
        <Popover
            open
            anchorRef={props.anchorRef as React.RefObject<View>}
            placement="bottom"
            gap={6}
            maxWidthCap={380}
            maxHeightCap={260}
            portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: 'start' }}
            onRequestClose={props.onRequestClose}
        >
            {({ maxHeight }) => (
                <FloatingOverlay maxHeight={Math.min(maxHeight, 260)} scrollEnabled={false} surfaceChrome="theme">
                    <View style={styles.body} testID={props.testID}>
                        <Text style={styles.title}>{t('connectedServicesCollection.renameTitle')}</Text>
                        <FieldTextInput
                            testID={`${props.testID}:input`}
                            value={value}
                            onChangeText={setValue}
                            accessibilityLabel={t('connectedServicesCollection.renameTitle')}
                            autoFocus
                            returnKeyType="done"
                            onSubmitEditing={save}
                            maxLength={80}
                        />
                        <Text style={styles.note}>{t('connectedServicesCollection.renameBody', { service: props.serviceLabel })}</Text>
                        <View style={styles.actions}>
                            <RoundButton
                                testID={`${props.testID}:cancel`}
                                size="small"
                                display="inverted"
                                title={t('common.cancel')}
                                onPress={props.onRequestClose}
                            />
                            <RoundButton
                                testID={`${props.testID}:save`}
                                size="small"
                                title={t('common.save')}
                                disabled={value.trim().length === 0 || saving}
                                onPress={save}
                            />
                        </View>
                    </View>
                </FloatingOverlay>
            )}
        </Popover>
    );
});

const styles = StyleSheet.create((theme) => ({
    body: {
        width: 320,
        maxWidth: '100%',
        padding: 14,
        gap: 10,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        lineHeight: 19,
        color: theme.colors.text.primary,
    },
    note: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
    },
}));
