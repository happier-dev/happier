import React from 'react';
import { Pressable, View } from 'react-native';

import type { ReviewCommentStateV1, ReviewCommentV1 } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';

import type { ReviewCommentLabels } from './labels';
import { ReviewCommentSnapshotView } from './ReviewCommentSnapshotView';
import { resolveReviewCommentBodyText } from './content';

export type ReviewCommentCardProps = Readonly<{
    comment: ReviewCommentV1;
    labels: ReviewCommentLabels;
    actions?: ReviewCommentCardActions;
    testID?: string;
}>;

export type ReviewCommentCardTransitionInput = Readonly<{
    comment: ReviewCommentV1;
    toState: ReviewCommentStateV1;
}>;

export type ReviewCommentCardActions = Readonly<{
    onEdit?: (comment: ReviewCommentV1) => void;
    onTransition?: (input: ReviewCommentCardTransitionInput) => void;
    onRedact?: (comment: ReviewCommentV1) => void;
}>;

function anchorPath(comment: ReviewCommentV1): string | null {
    if ('filePath' in comment.anchor) return comment.anchor.filePath;
    if ('folderPath' in comment.anchor) return comment.anchor.folderPath;
    return null;
}

function authorLabel(comment: ReviewCommentV1): string {
    if (comment.author.kind === 'plugin') return comment.author.pluginId;
    if (comment.author.kind === 'agent') return comment.author.agentId;
    return comment.author.userId;
}

function isTerminalComment(comment: ReviewCommentV1): boolean {
    return comment.flags.redacted === true || Boolean(comment.tombstone);
}

function transitionTargets(comment: ReviewCommentV1): readonly ReviewCommentStateV1[] {
    if (comment.state === 'resolved' || comment.state === 'dismissed') {
        return ['open'];
    }
    return ['resolved', 'dismissed'];
}

function transitionLabel(labels: ReviewCommentLabels, state: ReviewCommentStateV1): string {
    if (state === 'resolved') return labels.resolve;
    if (state === 'dismissed') return labels.dismiss;
    if (state === 'open') return labels.reopen;
    return labels.states[state];
}

function transitionTestId(state: ReviewCommentStateV1): string {
    if (state === 'resolved') return 'resolve';
    if (state === 'dismissed') return 'dismiss';
    if (state === 'open') return 'reopen';
    return state;
}

function ActionButton(props: Readonly<{
    label: string;
    disabled: boolean;
    onPress?: () => void;
    testID?: string;
}>) {
    if (props.disabled) {
        return (
            <View
                accessibilityRole="button"
                accessibilityState={{ disabled: true }}
                testID={props.testID}
            >
                <Text>{props.label}</Text>
            </View>
        );
    }

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: false }}
            onPress={props.onPress}
            testID={props.testID}
        >
            <Text>{props.label}</Text>
        </Pressable>
    );
}

export function ReviewCommentCard(props: ReviewCommentCardProps) {
    const path = anchorPath(props.comment);
    const body = props.comment.flags.redacted
        ? props.labels.redacted
        : resolveReviewCommentBodyText(props.comment.body, props.labels);
    const engineId = props.comment.engineId ?? (props.comment.author.kind === 'plugin' ? props.comment.author.pluginId : null);
    const disabled = isTerminalComment(props.comment);
    const testID = props.testID ?? `review-comment-${props.comment.id}`;

    return (
        <View testID={props.testID}>
            <Text>{props.labels.states[props.comment.state]}</Text>
            {props.comment.flags.stale ? <Text>{props.labels.stale}</Text> : null}
            {props.comment.flags.outdated ? <Text>{props.labels.outdated}</Text> : null}
            {path ? <Text>{path}</Text> : null}
            {engineId ? <Text>{`${props.labels.engine}: ${engineId}`}</Text> : null}
            <Text>{authorLabel(props.comment)}</Text>
            <Text>{body}</Text>
            <ReviewCommentSnapshotView comment={props.comment} labels={props.labels} />
            {props.actions ? (
                <View>
                    {props.actions.onEdit ? (
                        <ActionButton
                            label={props.labels.edit}
                            disabled={disabled}
                            onPress={() => props.actions?.onEdit?.(props.comment)}
                            testID={`${testID}-edit`}
                        />
                    ) : null}
                    {props.actions.onTransition ? transitionTargets(props.comment).map((toState) => (
                        <ActionButton
                            key={toState}
                            label={transitionLabel(props.labels, toState)}
                            disabled={disabled}
                            onPress={() => props.actions?.onTransition?.({ comment: props.comment, toState })}
                            testID={`${testID}-${transitionTestId(toState)}`}
                        />
                    )) : null}
                    {props.actions.onRedact ? (
                        <ActionButton
                            label={props.labels.redact}
                            disabled={disabled}
                            onPress={() => props.actions?.onRedact?.(props.comment)}
                            testID={`${testID}-redact`}
                        />
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}
