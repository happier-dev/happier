import * as React from 'react';
import { View } from 'react-native';

export type AdaptiveSelectionPresentation = 'auto' | 'expanded' | 'compact';
export type ResolvedAdaptiveSelectionPresentation = Exclude<AdaptiveSelectionPresentation, 'auto'>;

export type AdaptiveSelectionSectionProps = Readonly<{
    presentation?: AdaptiveSelectionPresentation;
    autoPresentation?: ResolvedAdaptiveSelectionPresentation;
    expandedContent: React.ReactNode;
    compactContent: React.ReactNode;
    quickContent?: React.ReactNode;
    compactContainerTestID?: string;
}>;

export function resolveAdaptiveSelectionPresentation(params: Readonly<{
    presentation?: AdaptiveSelectionPresentation;
    autoPresentation?: ResolvedAdaptiveSelectionPresentation;
}>): ResolvedAdaptiveSelectionPresentation {
    if (params.presentation === 'expanded' || params.presentation === 'compact') {
        return params.presentation;
    }
    return params.autoPresentation ?? 'expanded';
}

export function AdaptiveSelectionSection(props: AdaptiveSelectionSectionProps) {
    const resolvedPresentation = resolveAdaptiveSelectionPresentation({
        presentation: props.presentation,
        autoPresentation: props.autoPresentation,
    });

    if (resolvedPresentation === 'expanded') {
        return <>{props.expandedContent}</>;
    }

    return (
        <View testID={props.compactContainerTestID}>
            {props.quickContent}
            {props.compactContent}
        </View>
    );
}
