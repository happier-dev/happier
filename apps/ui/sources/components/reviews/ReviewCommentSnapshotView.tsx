import React from 'react';
import { View } from 'react-native';

import type { ReviewCommentV1 } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';

import type { ReviewCommentLabels } from './labels';
import {
    resolveReviewCommentSnapshot,
    resolveReviewCommentSnapshotEnvelopeLabel,
} from './content';

export type ReviewCommentSnapshotViewProps = Readonly<{
    comment: ReviewCommentV1;
    labels: Pick<
        ReviewCommentLabels,
        | 'binarySnapshot'
        | 'bidiControls'
        | 'minified'
        | 'submoduleSnapshot'
        | 'symlinkSnapshot'
        | 'textSnapshot'
        | 'tooLargeSnapshot'
        | 'encryptedSnapshot'
        | 'contentUnavailable'
        | 'truncated'
    >;
}>;

function snapshotKindLabel(props: ReviewCommentSnapshotViewProps): string {
    const snapshot = resolveReviewCommentSnapshot(props.comment.snapshot);
    if (!snapshot) {
        return resolveReviewCommentSnapshotEnvelopeLabel(props.comment.snapshot, props.labels) ?? props.labels.contentUnavailable;
    }
    if (snapshot.kind === 'binary') return props.labels.binarySnapshot;
    if (snapshot.kind === 'submodule') return props.labels.submoduleSnapshot;
    if (snapshot.kind === 'symlink') return props.labels.symlinkSnapshot;
    if (snapshot.kind === 'too_large') return props.labels.tooLargeSnapshot;
    return props.labels.textSnapshot;
}

export function ReviewCommentSnapshotView(props: ReviewCommentSnapshotViewProps) {
    const badges: string[] = [snapshotKindLabel(props)];
    const snapshot = resolveReviewCommentSnapshot(props.comment.snapshot);
    if (snapshot?.kind === 'text') {
        if (snapshot.truncated) badges.push(props.labels.truncated);
        if (snapshot.hasBidiControls) badges.push(props.labels.bidiControls);
        if (snapshot.likelyMinified) badges.push(props.labels.minified);
    }

    return (
        <View>
            {badges.map((badge) => (
                <Text key={badge}>{badge}</Text>
            ))}
        </View>
    );
}
