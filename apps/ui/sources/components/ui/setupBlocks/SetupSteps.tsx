import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSetupSteps, happierPageTextMetrics, type HappierSetupStep } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

export type SetupStep = HappierSetupStep;

/**
 * The one numbered-step anatomy of a set-up block (Home's "Add your phone", Connected services'
 * sign-in flows): a marker per step, the step in words, its detail, and what it asks for beneath.
 * `plain` is a list of instructions (sentences, no step titles), as the pairing panel reads.
 */
export function SetupSteps(props: Readonly<{
    steps: readonly SetupStep[];
    plain?: boolean;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    return <HappierSetupSteps {...props} theme={presentationTheme}
        stateGlyph={<Icon name="check" size={12} color={theme.colors.state.success.foreground} />}
        renderTitle={(step, plain) => typeof step.title === 'string' ? (
            <Text style={plain ? styles.plainTitle : [styles.title, step.state === 'done' ? styles.titleDone : null]}>{step.title}</Text>
        ) : step.title}
        renderDetail={(detail) => <Text style={styles.detail}>{detail}</Text>} />;
}

const styles = StyleSheet.create((theme) => ({
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        paddingTop: 1,
        color: theme.colors.text.primary,
    },
    titleDone: {
        ...Typography.default('medium'),
        color: theme.colors.text.secondary,
    },
    plainTitle: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.primary,
    },
    detail: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        marginTop: 2,
        color: theme.colors.text.secondary,
    },
}));
