import * as React from 'react';
import { Pressable, View } from 'react-native';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { buildReviewCommentsDisplayText } from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

function ReviewCommentsMiniSwitch(props: Readonly<{
    enabled: boolean;
}>) {
    return (
        <View pointerEvents="none">
            <Switch
                value={props.enabled}
                onValueChange={() => {}}
                compact
                disabled
                style={{ transform: [{ scale: 0.72 }] }}
            />
        </View>
    );
}

export function createReviewCommentsToggleActionChip(params: Readonly<{
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    enabled: boolean;
    onToggle: () => void;
}>): AgentInputExtraActionChip | undefined {
    if (params.reviewCommentDrafts.length <= 0) return undefined;

    const label = buildReviewCommentsDisplayText({ drafts: params.reviewCommentDrafts });

    return {
        key: 'review-comments',
        controlId: 'reviewComments',
        collapsedAction: ({ dismiss }) => ({
            id: 'review-comments',
            label,
            selected: params.enabled,
            right: <ReviewCommentsMiniSwitch enabled={params.enabled} />,
            onPress: () => {
                dismiss();
                params.onToggle();
            },
        }),
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <Pressable
                onPress={params.onToggle}
                style={({ pressed }) => ctx.chipStyle(Boolean(pressed))}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <ReviewCommentsMiniSwitch enabled={params.enabled} />
                    {ctx.showLabel ? (
                        <Text style={ctx.textStyle}>{label}</Text>
                    ) : null}
                </View>
            </Pressable>
        ),
    };
}
