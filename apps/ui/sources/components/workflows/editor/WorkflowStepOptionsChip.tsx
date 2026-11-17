import * as React from 'react';
import { View } from 'react-native';
import type { WorkflowBlock } from '@happier-dev/protocol/workflows/workflowV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/**
 * What a block changes from the workflow besides its Session fields (D-7): "Only run when", and a
 * step's conversation, workspace, background run or review. Empty while it inherits everything.
 */
export function formatWorkflowBlockOptionsSummary(
    block: WorkflowBlock,
    ownDifferences: readonly string[] = [],
): Readonly<{ label: string; changed: boolean }> {
    const differences = [
        ...ownDifferences,
        ...(block.kind !== 'if' && block.onlyWhen !== undefined ? [t('workflows.condition.onlyWhen')] : []),
    ];
    return { label: differences.join(' · '), changed: differences.length > 0 };
}

/**
 * A block's "…" (round 1116b, step options A): the last control of its card's foot, opening the
 * rest of its options anchored to itself. What the block changes reads as bordered chips beside it.
 */
export function WorkflowStepOptionsMore(props: Readonly<{
    onOpen: (anchorRef: React.RefObject<View | null>) => void;
    /** The block's name, so "Step options" says whose. */
    blockLabel: string;
    testID: string;
}>): React.ReactElement {
    const anchorRef = React.useRef<View>(null);
    return (
        <View ref={anchorRef} collapsable={false}>
            <IconButton
                testID={props.testID}
                iconName="dots-three"
                iconSize={ICON_SIZE.sm}
                variant="plain"
                accessibilityRole="button"
                accessibilityLabel={t('workflows.page.inspector.stepOptions')}
                accessibilityHint={props.blockLabel}
                hasPopup="dialog"
                onPress={() => props.onOpen(anchorRef)}
            />
        </View>
    );
}
