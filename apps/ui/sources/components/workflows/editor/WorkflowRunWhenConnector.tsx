import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { WorkflowRunWhenV1Schema, type WorkflowRunWhenV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover/Popover';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { workflowEditorStyles } from './workflowEditorStyles';

const styles = StyleSheet.create(theme => ({
    connector: { alignSelf: 'flex-start', marginLeft: ICON_SIZE.lg + theme.margins.sm, marginBottom: theme.margins.sm },
}));

/** The authored sequence edge; the coordinator, not this control, owns its outcome predicate. */
export function WorkflowRunWhenConnector(props: Readonly<{
    value: WorkflowRunWhenV1;
    editable: boolean;
    onChange: (value: WorkflowRunWhenV1) => void;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const label = props.value === 'failure' ? t('workflows.runWhen.ifFailure')
        : props.value === 'always' ? t('workflows.runWhen.regardless') : t('workflows.runWhen.ifSuccess');
    const pill = <StatusPill variant="neutral" hideDot labelVariant="phrase" label={label} />;
    if (!props.editable) return <View testID={props.testID} style={styles.connector}>{pill}</View>;
    return <View ref={anchorRef} collapsable={false} style={styles.connector}>
        <HappierPressable testID={props.testID} accessibilityRole="button" hasPopup="dialog"
            accessibilityLabel={`${t('workflows.runWhen.title')}: ${label}`} onPress={() => setOpen(true)}
            style={state => [workflowEditorStyles.actionTarget, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
            {pill}
        </HappierPressable>
        <Popover open={open} anchorRef={anchorRef} placement="bottom" onRequestClose={() => setOpen(false)} portal={{ sizeToContent: true }}>
            {({ maxHeight }) => <FloatingOverlay maxHeight={maxHeight}>
                <ItemGroup>
                    <SegmentedChoiceItem title={t('workflows.runWhen.title')} subtitle={t('workflows.runWhen.previousStep')}
                        accessoryLayout="stacked" value={props.value} testIDPrefix={`${props.testID}-choice`}
                        options={WorkflowRunWhenV1Schema.options.map(id => ({ id, label: id === 'failure' ? t('workflows.runWhen.failure')
                            : id === 'always' ? t('workflows.runWhen.always') : t('workflows.runWhen.success') }))}
                        onChange={value => { props.onChange(value); setOpen(false); }} />
                </ItemGroup>
            </FloatingOverlay>}
        </Popover>
    </View>;
}
