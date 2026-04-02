import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

import { WebDesktopDownloadCta } from '../steps/webDesktop/WebDesktopDownloadCta';
import { WizardTerminalHandoff, type WizardTerminalHandoffStep } from './WizardTerminalHandoff';

export type WizardGuidedHandoffProps = Readonly<{
    testID: string;
    children: React.ReactNode;
    style?: React.ComponentProps<typeof View>['style'];
}>;

export type WizardGuidedHandoffTerminalProps = Readonly<{
    testID: string;
    steps: readonly WizardTerminalHandoffStep[];
}>;

export type WizardGuidedHandoffDownloadCtaProps = Readonly<{
    testIDPrefix: string;
    showSubtitle?: boolean;
}>;

export type WizardGuidedHandoffNoteProps = Readonly<{
    testID: string;
    title: React.ReactNode;
    subtitle: React.ReactNode;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 14,
        alignItems: 'center',
    },
    noteBlock: {
        width: '100%',
        gap: 8,
        alignItems: 'center',
    },
    noteTitle: {
        textAlign: 'center',
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 22,
    },
    noteSubtitle: {
        textAlign: 'center',
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
}));

export function WizardGuidedHandoff(props: WizardGuidedHandoffProps) {
    useUnistyles();
    const styles = stylesheet;

    return (
        <View testID={props.testID} style={[styles.root, props.style]}>
            {props.children}
        </View>
    );
}

export function WizardGuidedHandoffTerminal(props: WizardGuidedHandoffTerminalProps) {
    return (
        <WizardTerminalHandoff
            testID={props.testID}
            steps={props.steps}
        />
    );
}

export function WizardGuidedHandoffDownloadCta(props: WizardGuidedHandoffDownloadCtaProps) {
    return <WebDesktopDownloadCta testIDPrefix={props.testIDPrefix} showSubtitle={props.showSubtitle} />;
}

export function WizardGuidedHandoffNote(props: WizardGuidedHandoffNoteProps) {
    useUnistyles();
    const styles = stylesheet;

    return (
        <View testID={props.testID} style={styles.noteBlock}>
            <Text style={styles.noteTitle}>{props.title}</Text>
            <Text style={styles.noteSubtitle}>{props.subtitle}</Text>
        </View>
    );
}
