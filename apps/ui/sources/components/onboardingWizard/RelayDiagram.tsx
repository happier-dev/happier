import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { WizardIconBox } from './WizardIconBox';

export type RelayDiagramProps = Readonly<{
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        alignItems: 'stretch',
        justifyContent: 'center',
        gap: 10,
        paddingTop: 6,
        paddingBottom: 4,
        maxWidth: 300,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
    },
    node: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
    },
    label: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    connector: {
        height: 2,
        background: `repeating-linear-gradient(to right, ${theme.colors.divider} 0, ${theme.colors.divider} 4px, transparent 4px, transparent 8px)`,
        marginHorizontal: 2,
        marginBottom: 18,
        flexGrow: 1,
    },
}));

export const RelayDiagram = React.memo(function RelayDiagram(props: RelayDiagramProps) {
    useUnistyles();
    const styles = stylesheet;

    return (
        <View testID={props.testID} style={styles.root}>
            <View style={styles.row}>
                <View style={styles.node}>
                    <WizardIconBox icon="phone-portrait-outline" boxSize={44} iconSize={22} />
                    <Text style={styles.label}>{t('setupOnboarding.relayDiagramPhoneLabel')}</Text>
                </View>

                <View
                    style={styles.connector}
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                >
                </View>

                <View style={styles.node}>
                    <WizardIconBox icon="cloud-outline" selected boxSize={44} iconSize={22} />
                    <Text style={styles.label}>{t('setupOnboarding.relayDiagramRelayLabel')}</Text>
                </View>

                <View
                    style={styles.connector}
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                >
                </View>

                <View style={styles.node}>
                    <WizardIconBox icon="laptop-outline" boxSize={44} iconSize={22} />
                    <Text style={styles.label}>{t('setupOnboarding.relayDiagramThisComputerLabel')}</Text>
                </View>
            </View>
        </View>
    );
});
