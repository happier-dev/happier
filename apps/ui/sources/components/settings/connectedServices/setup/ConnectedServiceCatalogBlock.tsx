import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { SetupBlockPaper } from '@/components/ui/setupBlocks/SetupBlockPaper';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { Modal } from '@/modal';

import { ConnectedServiceMark } from '../ConnectedServiceMark';
import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { getConnectedServiceSetupPresentation } from '@/sync/domains/connectedServices/connectedServiceRegistry';

import type { ConnectedServiceSetupCatalogEntry } from './ConnectedServiceSetupPanel';

/** How a service signs in, in words: "Sign in with a browser or a code", "Paste a key". */
export function describeConnectedServiceSignIn(entry: ConnectedServiceRegistryEntry | null): string | null {
    const modes = entry?.authenticationModes ?? entry?.projectedDescriptor?.authentication.modes ?? [];
    if (modes.length === 0) return null;
    const kinds = new Set(modes.map((mode) => mode.kind));
    const browser = kinds.has('oauthAuthorizationCode');
    const code = kinds.has('oauthDeviceCode');
    const key = kinds.has('manual');
    if (browser && code) return t('connectedServicesSettings.catalogSignInBrowserOrCode');
    if (browser && key) return t('connectedServicesSettings.catalogSignInBrowserOrKey');
    if (browser) return t('connectedServicesSettings.catalogSignInBrowser');
    if (code) return t('connectedServicesSettings.catalogSignInCode');
    return t('connectedServicesSettings.catalogPasteKey');
}

/**
 * One service in the catalog (lab `csvc` A1, P0, H2c), a choice on the action-tile paper (as "Add a
 * machine"'s ways to add one): its mark and how many accounts you have, its name, how it signs in, and
 * the marks of the agents that use it. Pressing it grows the block into the service's flow.
 */
export const ConnectedServiceCatalogBlock = React.memo(function ConnectedServiceCatalogBlock(props: Readonly<{
    entry: ConnectedServiceSetupCatalogEntry;
    layout: 'card' | 'row';
    /** "3 connected" (the page's catalog); Home's first accounts have none to count. */
    showCount: boolean;
    onConnect: () => void;
}>) {
    const { entry } = props;
    const card = props.layout === 'card';
    const presentation = getConnectedServiceSetupPresentation(entry.service);
    const signIn = presentation ? t(presentation.catalogDescriptionKey) : describeConnectedServiceSignIn(entry.entry);
    const count = props.showCount && entry.connectedCount > 0
        ? t('connectedServicesSettings.setupConnectedCount', { count: entry.connectedCount })
        : null;
    const agents = entry.usedByAgentIds.length > 0 ? (
        <View style={styles.agents} accessibilityLabel={entry.usedBy.join(', ')}>
            {entry.usedByAgentIds.map((agentId) => <AgentIcon key={agentId} agentId={agentId} size={14} />)}
        </View>
    ) : null;
    const diagnostic = entry.statusLine ? <Text style={styles.body}>{entry.statusLine}</Text> : null;
    const supportDetails = entry.supportDetails ? (
        <RoundButton size="small" display="secondary" title={t('common.details')}
            onPress={(event) => { event?.stopPropagation?.(); void Modal.alert(t('common.details'), entry.supportDetails ?? ''); }} />
    ) : null;
    return (
        <Pressable
            testID={`connected-service-setup:tile:${entry.serviceKey}`}
            // The tile extends the pointer target; Connect owns keyboard and screen-reader activation.
            accessible={false}
            focusable={false}
            tabIndex={-1}
            onPress={entry.canAdd ? props.onConnect : undefined}
            style={styles.press}
        >
            {({ pressed, hovered }: Readonly<{ pressed: boolean; hovered?: boolean }>) => card ? (
                <SetupBlockPaper
                    testID={`connected-service-setup:block:${entry.serviceKey}`}
                    layout="card"
                    appearance="tile"
                    highlighted={entry.canAdd && (pressed || hovered === true)}
                >
                    <View style={styles.top}>
                        <ConnectedServiceMark legacyServiceId={entry.legacyServiceId} size="card" />
                        {count ? <Text style={styles.count}>{count}</Text> : null}
                    </View>
                    <View>
                        <Text style={styles.title} numberOfLines={1}>{entry.label}</Text>
                        {signIn ? <Text style={styles.body}>{signIn}</Text> : null}
                        {diagnostic}
                    </View>
                    <View style={styles.foot}>
                        {agents}
                        {supportDetails}
                        <RoundButton testID={`connected-service-setup:connect:${entry.serviceKey}`}
                            size="small" display="secondary" title={t('connectedServicesSettings.connect')}
                            accessibilityLabel={t('connectedServicesSettings.setupServiceTitle', { service: entry.label })}
                            accessibilityHint={entry.usedBy.length > 0 ? entry.usedBy.join(', ') : undefined}
                            disabled={!entry.canAdd}
                            onPress={(event) => { event?.stopPropagation?.(); if (entry.canAdd) props.onConnect(); }} />
                    </View>
                </SetupBlockPaper>
            ) : (
                <SetupBlockPaper
                    testID={`connected-service-setup:block:${entry.serviceKey}`}
                    layout="row"
                    appearance="tile"
                    highlighted={entry.canAdd && (pressed || hovered === true)}
                >
                    <View style={styles.rowIdentity}>
                        <ConnectedServiceMark legacyServiceId={entry.legacyServiceId} size="card" />
                        {count ? <Text style={styles.count}>{count}</Text> : null}
                    </View>
                    <View style={styles.rowText}>
                        <Text style={styles.title} numberOfLines={1}>{entry.label}</Text>
                        {signIn ? <Text style={styles.body}>{signIn}</Text> : null}
                        {diagnostic}
                    </View>
                    <View style={styles.rowFoot}>
                    {agents}
                    {supportDetails}
                    <RoundButton testID={`connected-service-setup:connect:${entry.serviceKey}`}
                        size="small" display="secondary" title={t('connectedServicesSettings.connect')}
                        accessibilityLabel={t('connectedServicesSettings.setupServiceTitle', { service: entry.label })}
                        accessibilityHint={entry.usedBy.length > 0 ? entry.usedBy.join(', ') : undefined}
                        disabled={!entry.canAdd}
                        onPress={(event) => { event?.stopPropagation?.(); if (entry.canAdd) props.onConnect(); }} />
                    </View>
                </SetupBlockPaper>
            )}
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    top: {
        height: 24,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    count: {
        ...Typography.default(),
        fontSize: 11.5,
        lineHeight: 15,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    rowText: {
        flex: 1,
        minWidth: 0,
    },
    rowIdentity: { alignItems: 'center', gap: 4 },
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.primary,
    },
    body: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        marginTop: 2,
        color: theme.colors.text.secondary,
    },
    press: {
        flex: 1,
    },
    foot: {
        marginTop: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    agents: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    rowFoot: { alignItems: 'flex-end', gap: 5 },
}));
