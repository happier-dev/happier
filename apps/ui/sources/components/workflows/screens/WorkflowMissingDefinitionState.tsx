import * as React from 'react';
import { View } from 'react-native';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { StyleSheet } from 'react-native-unistyles';

/**
 * A saved workflow this route cannot open.
 *
 * It borrowed the empty-library heading and a delete confirmation's
 * consequence, so someone following a stale link was told "No saved workflows
 * yet" and that "existing Automations and runs keep working" — copy that
 * describes an empty collection and implies a deletion nothing here observed.
 * This state knows only that the requested definition could not be opened, so
 * that is what it says, and it offers the way back the route never had.
 */

const styles = StyleSheet.create((theme) => ({
    root: {
        padding: theme.margins.xxl,
        gap: theme.margins.sm,
        alignItems: 'flex-start',
    },
    title: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    body: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
    },
}));

export function WorkflowMissingDefinitionState(props: Readonly<{
    testID?: string;
    /** A lost in-memory copy is not evidence that its original definition is missing. */
    source?: 'definition' | 'unsaved-copy';
    /** Present wherever the route can return to the collection. */
    onOpenCollection?: () => void;
}>): React.ReactElement {
    const testID = props.testID ?? 'workflow-missing-definition';
    return (
        <View testID={testID} style={styles.root} accessibilityRole="alert">
            <Text style={styles.title}>{t(props.source === 'unsaved-copy' ? 'workflows.empty.missingDraftTitle' : 'workflows.empty.missingTitle')}</Text>
            <Text style={styles.body}>{t(props.source === 'unsaved-copy' ? 'workflows.empty.missingDraftBody' : 'workflows.empty.missingBody')}</Text>
            {props.onOpenCollection === undefined ? null : (
                <ToolbarButton
                    testID={`${testID}-open-collection`}
                    label={t('workflows.openCollection')}
                    onPress={props.onOpenCollection}
                    tone="primary"
                    size="md"
                />
            )}
        </View>
    );
}
