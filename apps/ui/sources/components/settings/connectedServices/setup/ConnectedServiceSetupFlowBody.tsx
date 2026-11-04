import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { t } from '@/text';

export type ConnectedServiceSetupMethod = Readonly<{
    id: string;
    title: string;
    recommended: boolean;
}>;

/**
 * The inside of a setup panel for one service: the ways to sign in (the recommended one first and
 * selected by default), then its Ready action or running flow — the code to enter, the steps to paste back, or the
 * key to paste — with its waiting, failure and recovery states from the controller.
 */
export function ConnectedServiceSetupFlowBody(props: Readonly<{
    state: 'ready' | 'preparing' | 'chooseMachine' | 'unknownService';
    methods?: readonly ConnectedServiceSetupMethod[];
    activeMethodId?: string | null;
    methodsDisabled?: boolean;
    onSelectMethod?: (methodId: string) => void;
    flow?: React.ReactNode;
}>) {
    const styles = stylesheet;
    if (props.state === 'chooseMachine') {
        return (
            <SurfaceStateCard
                testID="connected-service-setup:choose-machine"
                size="line"
                kind="unavailable"
                title={t('connectedServicesSettings.setupChooseMachine')}
            />
        );
    }
    if (props.state === 'unknownService') {
        return (
            <SurfaceStateCard
                testID="connected-service-setup:unknown-service"
                size="line"
                kind="unavailable"
                title={t('connectedServices.detail.unknownService')}
            />
        );
    }
    const methods = props.methods ?? [];
    const activeMethodId = props.activeMethodId && methods.some((method) => method.id === props.activeMethodId)
        ? props.activeMethodId
        : methods[0]?.id ?? null;
    const twoMethods = methods.length === 2;
    return (
        <View style={styles.body} testID="connected-service-setup:flow">
            {methods.length > 1 && activeMethodId ? (
                <View style={twoMethods ? null : styles.methods}>
                    <SegmentedTabBar
                        role="radiogroup"
                        testIDPrefix="connected-service-setup:method"
                        accessibilityLabel={t('connectedServicesSettings.setupHowToSignIn')}
                        labelSize={twoMethods ? 'field' : undefined}
                        segmentSizing={twoMethods ? 'equal' : 'content'}
                        // A narrow column keeps one line of methods; the ones that no longer fit move behind More.
                        overflow={twoMethods ? undefined : { label: t('common.more'), testID: 'connected-service-setup:method:more' }}
                        tabs={methods.map((method) => ({
                            id: method.id,
                            label: method.title,
                            // Two methods are one plain choice: the first, already selected, needs no badge.
                            badge: method.recommended && !twoMethods ? t('connectedServicesSettings.methodRecommended') : undefined,
                        }))}
                        activeTabId={activeMethodId}
                        disabled={props.methodsDisabled}
                        onSelectTab={(id) => props.onSelectMethod?.(id)}
                    />
                </View>
            ) : null}
            {props.state !== 'preparing' && !props.flow && activeMethodId && props.onSelectMethod ? (
                // A chosen method waits for the person: nothing signs in until they press (one method or several).
                <ConnectedServiceSetupFlowActions
                    primary={{
                        testID: 'connected-service-setup:method-continue',
                        label: t('common.continue'),
                        loading: props.methodsDisabled,
                        onPress: () => props.onSelectMethod?.(activeMethodId),
                    }}
                />
            ) : props.state === 'preparing' || !props.flow ? (
                <SurfaceStateCard
                    testID="connected-service-setup:preparing"
                    size="line"
                    kind="loading"
                    title={t('connectedServices.deviceAuth.preparing')}
                />
            ) : props.flow}
        </View>
    );
}

const stylesheet = StyleSheet.create(() => ({
    body: {
        gap: 12,
    },
    methods: {
        alignItems: 'flex-start',
    },
}));

export type ConnectedServiceSetupFlowAction = Readonly<{
    testID: string;
    label: string;
    onPress: () => void;
    disabled?: boolean;
    loading?: boolean;
}>;

/**
 * A sign-in flow's footer in a setup panel: where what you enter is kept, last thing before you commit,
 * then secondary Cancel (local: the panel steps back at once) beside the step's one primary action.
 */
export function ConnectedServiceSetupFlowActions(props: Readonly<{
    onCancel?: () => void;
    primary?: ConnectedServiceSetupFlowAction;
}>) {
    const { theme } = useUnistyles();
    return (
        <View style={flowActionStyles.footer}>
            <View style={flowActionStyles.trust}>
                <Icon name="lock" size={14} color={theme.colors.text.secondary} />
                <Text style={flowActionStyles.trustText}>{t('connectedServicesSettings.setupTrust')}</Text>
            </View>
            <View style={flowActionStyles.row}>
            {props.onCancel ? (
                <RoundButton
                    testID="connected-account-setup:cancel"
                    size="small"
                    display="inverted"
                    title={t('common.cancel')}
                    onPress={props.onCancel}
                />
            ) : null}
            {props.primary ? (
                <RoundButton
                    testID={props.primary.testID}
                    size="small"
                    title={props.primary.label}
                    disabled={props.primary.disabled}
                    loading={props.primary.loading}
                    onPress={props.primary.onPress}
                />
            ) : null}
            </View>
        </View>
    );
}

const flowActionStyles = StyleSheet.create((theme) => ({
    footer: {
        gap: theme.space.s16,
    },
    trust: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s6,
    },
    trustText: {
        flex: 1,
        minWidth: 0,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    row: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 8,
    },
}));
