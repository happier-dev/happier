import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

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

export type WizardGuidedHandoffDividerProps = Readonly<{
    testID: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 14,
        alignItems: 'flex-start',
    },
    divider: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingTop: 12,
        paddingBottom: 4,
    },
    dividerLine: {
        flex: 1,
        height: 1,
        backgroundColor: theme.colors.border.default,
        opacity: 0.8,
    },
    dividerText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    noteBlock: {
        width: '100%',
        gap: 8,
        alignItems: 'flex-start',
    },
    noteTitle: {
        textAlign: 'left',
        color: theme.colors.text.primary,
        fontSize: 16,
        lineHeight: 22,
    },
    noteSubtitle: {
        textAlign: 'left',
        color: theme.colors.text.secondary,
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

export function WizardGuidedHandoffDivider(props: WizardGuidedHandoffDividerProps) {
    useUnistyles();
    const styles = stylesheet;

    return (
        <View testID={props.testID} style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>{t('setupOnboarding.orDividerLabel')}</Text>
            <View style={styles.dividerLine} />
        </View>
    );
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
