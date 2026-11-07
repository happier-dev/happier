import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

import type { WorkflowValidationIssue } from '@happier-dev/protocol/workflows/workflowV1';

import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';

export const NO_DISCLOSURE: ReadonlyMap<string, boolean> = new Map();

/**
 * Whether a group is open: attention (an issue or a required-but-missing
 * field) always opens it; otherwise the person's recorded choice; otherwise
 * whether it held a value set when it first rendered for this subject
 * (`initialValueSet`; a value that arrives later never opens a group).
 */
export function resolveWorkflowInspectorGroupExpanded(params: Readonly<{
    attention: boolean;
    recorded: boolean | undefined;
    initialValueSet: boolean;
}>): boolean {
    if (params.attention) return true;
    return params.recorded ?? params.initialValueSet;
}

export function issuesUnder(issues: readonly WorkflowValidationIssue[], prefixes: readonly string[]): boolean {
    return issues.some((issue) => prefixes.some((prefix) => issue.path === prefix || issue.path.startsWith(`${prefix}/`)));
}

/**
 * One settings group as a disclosure whose closed line is its effective values
 * (04 §5.2, D10). Its open state follows `resolveWorkflowInspectorGroupExpanded`.
 */
export function WorkflowInspectorGroup(props: Readonly<{
    groupId: string;
    title: string;
    summary: React.ReactNode;
    description?: string;
    attention: boolean;
    valueSet: boolean;
    disclosure: ReadonlyMap<string, boolean>;
    onChangeDisclosure?: (groupId: string, expanded: boolean) => void;
    testID: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    // Expansion follows the person's intent or the first render, never a value that arrives later
    // (the contextual Agent seeding a new workflow would move the content under an open menu).
    const [initialValueSet] = React.useState(props.valueSet);
    const expanded = resolveWorkflowInspectorGroupExpanded({
        attention: props.attention,
        recorded: props.disclosure.get(props.groupId),
        initialValueSet,
    });
    const { groupId, onChangeDisclosure } = props;
    const onExpandedChange = React.useCallback((next: boolean) => {
        onChangeDisclosure?.(groupId, next);
    }, [groupId, onChangeDisclosure]);
    return (
        <ExpandableItem
            testID={props.testID}
            expanded={expanded}
            onExpandedChange={onExpandedChange}
            showDivider={false}
            header={({ headerProps }) => (
                <HappierPressable
                    testID={`${props.testID}-header`}
                    onPress={headerProps.onPress}
                    accessibilityRole="button"
                    accessibilityLabel={props.title}
                    expanded={expanded}
                    style={(state) => [
                        state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                    ]}
                >
                    <ItemGroup
                        title={props.title}
                        description={expanded ? props.description : props.summary}
                        action={<DisclosureCaret expanded={expanded} size={14} />}
                        // The disclosure caret is a trailing mark, never a control that drops beneath a
                        // narrow pane's summary line (live Workflow settings, DESIGN-13).
                        actionLayout="trailing"
                        surface="none"
                    >{null}</ItemGroup>
                </HappierPressable>
            )}
        >
            <ItemGroup headerStyle={{ paddingTop: 0 }}>{props.children}</ItemGroup>
        </ExpandableItem>
    );
}
