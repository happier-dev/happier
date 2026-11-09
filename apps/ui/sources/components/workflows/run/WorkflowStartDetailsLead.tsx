import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ContextualStartLead } from '@/components/sessions/authoring/ContextualStartLead';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** The selected workflow's identity, shared by New and the contextual Start pane. */
export function WorkflowStartDetailsLead(props: Readonly<{
    name: string;
    description?: string;
    source?: string;
    inputs: readonly string[];
    summary: string;
    children?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    return <ContextualStartLead testID="workflow-start-lead" title={props.name} description={props.description}
        marks={<Icon name="tree-structure" size={ICON_SIZE.xl} color={theme.colors.text.secondary} />}>
        {props.source ? <Text style={styles.meta}>{props.source}</Text> : null}
        {/* Silent without inputs: nothing to ask needs no line of its own. */}
        {props.inputs.length ? <Text style={styles.meta}>{t('workflows.start.asksFor', { names: props.inputs.join(' · ') })}</Text> : null}
        <Text style={styles.meta}>{props.summary}</Text>
        {props.children}
    </ContextualStartLead>;
}

const styles = StyleSheet.create(theme => ({
    meta: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
}));
