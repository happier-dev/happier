import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/**
 * The entity header of a prompt, skill or template editor: its kind's mark, its name (or "New …"
 * while it is a draft), what it is for, then Save and a `⋯` menu of rare operations.
 */
export const PromptEditorHeader = React.memo(function PromptEditorHeader(props: Readonly<{
    testID: string;
    mark: IconName;
    title: string;
    description: string;
    meta?: readonly PageHeaderMetaFact[];
    /** A refusal that belongs to no single field (the save failed). */
    error?: string | null;
    saveTestID: string;
    saveDisabled: boolean;
    saving?: boolean;
    onSave: () => void;
    menuActions: readonly PageHeaderMenuAction[];
}>) {
    const { theme } = useUnistyles();
    return (
        <PageHeader
            testID={props.testID}
            alwaysShowTitle
            title={props.title}
            description={props.description}
            meta={props.meta && props.meta.length > 0 ? props.meta : undefined}
            details={props.error ? (
                <Text
                    testID={`${props.testID}.error`}
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                    style={{ color: theme.colors.state.danger.foreground, fontSize: 13, lineHeight: 18 }}
                >
                    {props.error}
                </Text>
            ) : undefined}
            leading={(
                <PageHeaderMarkSlot>
                    <Icon name={props.mark} size={20} color={theme.colors.text.secondary} />
                </PageHeaderMarkSlot>
            )}
            actions={(
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <RoundButton
                        testID={props.saveTestID}
                        size="small"
                        title={t('common.save')}
                        disabled={props.saveDisabled}
                        loading={props.saving}
                        onPress={props.onSave}
                    />
                    {props.menuActions.length > 0 ? (
                        <PageHeaderMenu testID={`${props.testID}.menu`} actions={props.menuActions} />
                    ) : null}
                </View>
            )}
        />
    );
});
