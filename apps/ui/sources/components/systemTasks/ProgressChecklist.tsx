import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { Icon, type IconName, type IconWeight } from '@/components/ui/icons/Icon';

export type ProgressChecklistStepStatus =
    | 'pending'
    | 'active'
    | 'waiting'
    | 'done'
    | 'failed'
    | 'canceled';

export type ProgressChecklistStep<StepId extends string = string> = Readonly<{
    stepId: StepId;
    title: string;
    message?: string | null;
    status: ProgressChecklistStepStatus;
}>;

export function encodeProgressChecklistStepIdForTestId(stepId: string): string {
    return String(stepId ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'unknown';
}

export const ProgressChecklist = React.memo(function ProgressChecklist(props: Readonly<{
    steps: readonly ProgressChecklistStep[];
    testIDPrefix: string;
    showStepMessages?: boolean;
}>) {
    const { theme } = useUnistyles();
    const showStepMessages = props.showStepMessages ?? true;

    return props.steps.map((step) => {
        const testId = `${props.testIDPrefix}-${step.status}-${encodeProgressChecklistStepIdForTestId(step.stepId)}`;
        const iconName: IconName = step.status === 'done'
            ? 'check-circle'
            : step.status === 'failed'
                ? 'x-circle'
                : step.status === 'canceled'
                    ? 'minus-circle'
                    : step.status === 'waiting'
                        ? 'question'
                        : 'circle';
        // 'active' and 'pending' both render the same 'circle' glyph; Phosphor expresses the old
        // filled-vs-outline Ionicons pair ('ellipse' vs 'ellipse-outline') as a weight, not a name.
        const iconWeight: IconWeight | undefined = step.status === 'active' ? 'fill' : undefined;
        const iconColor = step.status === 'done'
            ? theme.colors.state.success.foreground
            : step.status === 'failed'
                ? theme.colors.state.danger.foreground
                : step.status === 'active' || step.status === 'waiting'
                    ? theme.colors.accent.blue
                    : theme.colors.text.tertiary;
        const subtitle = showStepMessages && (typeof step.message === 'string' && step.message.trim())
            ? step.message.trim()
            : null;

        return (
            <Item
                key={step.stepId}
                testID={testId}
                title={step.title}
                subtitle={subtitle}
                icon={<Icon name={iconName} size={16} color={iconColor} weight={iconWeight} />}
                loading={step.status === 'active'}
                showChevron={false}
                mode="info"
                accessibilityLabel={subtitle ? `${step.title}. ${subtitle}` : step.title}
            />
        );
    });
});
