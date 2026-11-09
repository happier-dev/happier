import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { HappierProvenanceChip } from '@happier-dev/plugin-ui/presentation';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useMachineDisplayNamesById, useSessionDisplayNameSource } from '@/sync/store/hooks';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';

import type { ArtifactProvenance as Provenance } from './artifactBrowserModel';

/**
 * What to say about an artifact no producer recorded a source for: that someone shared it, or nothing when
 * it is simply the viewer's own (a word repeated on every row says nothing).
 */
export function readArtifactProvenanceFallback(artifact: Readonly<{ access?: string | null }>): string | null {
    return artifact.access && artifact.access !== 'owner' ? t('artifacts.browser.provenance.sharedWithYou') : null;
}

/** The session and machine names a provenance names, from the store's narrow display projections. */
function useProvenanceNames(provenance: Provenance): Readonly<{ sessionId: string | null; session: string; machine: string | null }> {
    const sessionId = 'sessionId' in provenance ? provenance.sessionId : null;
    const source = useSessionDisplayNameSource(sessionId ?? '');
    const isSessionVisible = useSessionRecordingVisibility();
    const identityVisible = sessionId === null || isSessionVisible({ sessionId, serverId: source?.serverId });
    const machineIds = React.useMemo(() => [provenance.machineId], [provenance.machineId]);
    const machines = useMachineDisplayNamesById(machineIds);
    const fileName = provenance.path.split(/[\\/]/).filter(Boolean).pop() ?? provenance.path;
    return {
        sessionId,
        session: !identityVisible ? t('message.provenanceSession') : source ? getSessionName(source) : t('artifacts.browser.provenance.fromFile', { name: fileName }),
        machine: identityVisible ? machines[provenance.machineId] ?? null : null,
    };
}

/**
 * Where an artifact came from: "session · machine". `line` sits under a card or row title;
 * `chip` heads the artifact view and opens the session it came from.
 */
export const ArtifactProvenanceLabel = React.memo(function ArtifactProvenanceLabel(props: Readonly<{
    provenance: Provenance | null;
    /** What to say when no producer recorded a source (an artifact someone wrote by hand). */
    fallback: string;
    presentation: 'line' | 'chip';
    testID?: string;
}>) {
    if (props.provenance === null) return <ProvenanceText icon="user-circle" session={props.fallback} machine={null} presentation={props.presentation} testID={props.testID} />;
    return <SourcedProvenance provenance={props.provenance} presentation={props.presentation} testID={props.testID} />;
});

function SourcedProvenance(props: Readonly<{ provenance: Provenance; presentation: 'line' | 'chip'; testID?: string }>) {
    const names = useProvenanceNames(props.provenance);
    const sessionId = names.sessionId;
    const router = useRouter();
    return <ProvenanceText icon="chat-circle" session={names.session} machine={names.machine}
        presentation={props.presentation} chevron={props.presentation === 'chip' && sessionId !== null} testID={props.testID}
        {...(props.presentation === 'chip' && sessionId ? {
            accessibilityLabel: t('artifacts.browser.provenance.openSession', { session: names.session }),
            onPress: () => router.push(buildScopedSessionRouteHref({ sessionId }) as never),
        } : {})} />;
}

function ProvenanceText(props: Readonly<{
    icon: 'chat-circle' | 'user-circle';
    session: string;
    machine: string | null;
    presentation: 'line' | 'chip';
    chevron?: boolean;
    testID?: string;
    accessibilityLabel?: string;
    onPress?: () => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const chip = props.presentation === 'chip';
    if (chip) return <HappierProvenanceChip testID={props.onPress && props.testID ? `${props.testID}:open` : props.testID}
        label={[props.session, props.machine].filter(Boolean).join(' · ')}
        accessibilityLabel={props.accessibilityLabel} onPress={props.onPress} style={styles.chipPress}
        colors={{ foreground: theme.colors.text.primary, background: theme.colors.surface.elevated,
            focus: theme.colors.border.focus }}
        badgeStyle={[styles.chip, { paddingVertical: 0 }]}
        leading={<Icon name={props.icon} size={13} color={theme.colors.text.tertiary} />}
        trailing={props.chevron ? <Icon name="caret-right" size={11} color={theme.colors.text.tertiary} /> : undefined}
        labelContent={<View style={styles.row} testID={props.onPress ? props.testID : undefined}>
            <Text numberOfLines={1} style={[styles.session, styles.chipText]}>{props.session}</Text>
            {props.machine ? <Text numberOfLines={1} style={styles.machine}>{`· ${props.machine}`}</Text> : null}
        </View>} />;
    return (
        <View style={styles.row} testID={props.testID}>
            <Icon name={props.icon} size={12} color={theme.colors.text.tertiary} />
            <Text numberOfLines={1} style={styles.session}>{props.session}</Text>
            {props.machine ? <Text numberOfLines={1} style={styles.machine}>{`· ${props.machine}`}</Text> : null}
            {props.chevron ? <Icon name="caret-right" size={11} color={theme.colors.text.tertiary} /> : null}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        minWidth: 0,
        flexShrink: 1,
    },
    chip: {
        alignSelf: 'flex-start',
        height: 26,
        paddingLeft: theme.space.s8,
        paddingRight: theme.space.s8,
        borderRadius: 13,
        backgroundColor: theme.colors.surface.elevated,
    },
    chipPress: {
        alignSelf: 'flex-start',
        borderRadius: 13,
    },
    session: {
        flexShrink: 1,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    chipText: {
        color: theme.colors.text.primary,
    },
    machine: {
        flexShrink: 0,
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
}));
