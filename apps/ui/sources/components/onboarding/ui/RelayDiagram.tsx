import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { WizardIconBox } from './WizardIconBox';
import { useWizardCardLayoutMetrics } from './WizardCardLayout';

export type RelayDiagramProps = Readonly<{
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingTop: 6,
        paddingBottom: 4,
        alignSelf: 'center',
        ...Platform.select({
            web: {
                marginLeft: 'auto',
                marginRight: 'auto',
            },
            default: {},
        }),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        alignSelf: 'center',
        width: '100%',
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
        borderBottomWidth: 2,
        borderBottomColor: theme.colors.divider,
        borderStyle: 'dashed',
        marginHorizontal: 2,
        marginBottom: 18,
        flexGrow: 1,
    },
}));

export const RelayDiagram = React.memo(function RelayDiagram(props: RelayDiagramProps) {
    useUnistyles();
    const styles = stylesheet;
    const { width } = useWindowDimensions();
    const metrics = useWizardCardLayoutMetrics();
    const diagramWidth = React.useMemo(() => {
        const safeAvailableWidth = Math.max(0, (metrics?.cardWidth ?? width) - 48);
        if (safeAvailableWidth < 220) return safeAvailableWidth;
        return Math.min(300, safeAvailableWidth);
    }, [metrics?.cardWidth, width]);

    return (
        <View
            testID={props.testID}
            style={[
                styles.root,
                { width: diagramWidth },
            ]}
        >
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
                />

                <View style={styles.node}>
                    <WizardIconBox icon="cloud-outline" selected boxSize={44} iconSize={22} />
                    <Text style={styles.label}>{t('setupOnboarding.relayDiagramRelayLabel')}</Text>
                </View>

                <View
                    style={styles.connector}
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                />

                <View style={styles.node}>
                    <WizardIconBox icon="laptop-outline" boxSize={44} iconSize={22} />
                    <Text style={styles.label}>{t('setupOnboarding.relayDiagramThisComputerLabel')}</Text>
                </View>
            </View>
        </View>
    );
});
