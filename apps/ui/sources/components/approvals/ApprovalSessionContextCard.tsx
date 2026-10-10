import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    resolveSessionContextLine,
    projectSessionContextPresentation,
    resolveSessionHomeLastUpdatedLabel,
    type SessionContextFacts,
    type SessionContextPresentation,
} from '@/sync/domains/session/presentation/sessionContextPresentation';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { t } from '@/text';
import { SessionContextChips } from '@/components/sessions/context/SessionContextChips';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { readApprovalSessionEndpointLabels } from './approvalEndpointLabels';
import { useWorkClockSnapshot } from '@/components/sessions/agents/presentation/agentActivityClock';
import {
    describeApprovalAgent,
    describeApprovalOrigin,
    describeUnnamedApprovalSession,
} from './approvalRequesterLabels';

const ApprovalContextLine = React.memo(function ApprovalContextLine(props: Readonly<{
    context: SessionContextPresentation | null;
    facts?: SessionContextFacts | null;
    showWorkspace: boolean;
}>) {
    const snapshotAt = React.useCallback((nowMs: number) => {
        const context = props.facts ? projectSessionContextPresentation({ ...props.facts, freshness: {
            ...props.facts.freshness,
            lastUpdatedLabel: resolveSessionHomeLastUpdatedLabel(props.facts.freshness, nowMs),
        } }) : props.context;
        return resolveSessionContextLine(context ? { segments: context.segments.filter((segment) => segment.kind !== 'home') } : null,
            { showWorkspace: props.showWorkspace });
    }, [props.context, props.facts, props.showWorkspace]);
    const line = useWorkClockSnapshot(snapshotAt);
    return line ? <Text style={styles.homeLabel}>{line}</Text> : null;
});

/**
 * The "Requested by" section of an approval page: the requesting session, where it runs, and the
 * agent and surface that asked. Renders nothing when none of that is known.
 */
export const ApprovalSessionContextCard = React.memo(function ApprovalSessionContextCard(props: Readonly<{
    session: Session | SessionListRenderableSession | null;
    machine: Machine | null;
    serverId: string | null;
    context: SessionContextPresentation | null;
    /** Source facts let the context-line leaf date an unavailable Home without repainting this card. */
    contextFacts?: SessionContextFacts | null;
    /** The Home's own name, when this device knows the Home that asked; never its address. */
    homeName?: string | null;
    /**
     * Immutable, secret-free Home origin, for a Home this device has no profile for (or whose saved
     * route no longer matches): its exact identity is then the only truthful thing to show.
     */
    homeDisplayId?: string | null;
    /** The session the request names; when this device does not have it, it reads by where it lives. */
    requesterSessionId?: string | null;
    requesterAgentId: string | null;
    requesterSurface: string;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const homeName = props.homeName?.trim() || null;
    const namedSession = props.session && (!props.serverId || props.context?.mayShowDecryptedContent === true)
        ? getSessionName(props.session, props.serverId)
        : null;
    // A session this device cannot name is never shown by its id: it reads by where it lives.
    const sessionTitle = namedSession
        ?? (props.requesterSessionId?.trim() ? describeUnnamedApprovalSession(homeName) : null);
    const agentLabel = describeApprovalAgent(props.requesterAgentId);
    const originLabel = describeApprovalOrigin(props.requesterSurface);
    const endpointLabels = readApprovalSessionEndpointLabels({
        session: props.session,
        machine: props.machine,
    });
    const machineLabel = endpointLabels.machineLabel;
    const pathLabel = props.serverId ? props.context?.workspace?.label ?? null : endpointLabels.pathLabel;
    // Each fact once: the chips carry the machine and the folder, so the context line leaves the
    // folder out. The Home is named by this section's own Home line (the app's name for it, not the address the
    // session context falls back to), so the context line carries only what else is known.
    const contextLine = resolveSessionContextLine(
        props.context ? { segments: props.context.segments.filter((segment) => segment.kind !== 'home') } : null,
        { showWorkspace: !pathLabel },
    );
    const homeLabel = namedSession || !sessionTitle
        ? homeName ?? props.homeDisplayId?.trim() ?? null
        // "A session on <Home>" already names the Home.
        : homeName ? null : props.homeDisplayId?.trim() ?? null;

    if (!sessionTitle && !pathLabel && !machineLabel && !agentLabel && !originLabel && !homeLabel) {
        return null;
    }

    return (
        <ItemGroup
            title={t('detailPages.approval.contextTitle')}
            description={t('detailPages.approval.contextDescription')}
        >
        <SectionContentRow>
        <View style={styles.card}>
            <View style={styles.headerRow}>
                <View style={styles.titleColumn}>
                    {sessionTitle ? <Text style={styles.title}>{sessionTitle}</Text> : null}
                    {machineLabel || pathLabel ? (
                        <View style={sessionTitle ? styles.contextChips : null}>
                            <SessionContextChips machineLabel={machineLabel} pathLabel={pathLabel} />
                        </View>
                    ) : null}
                    {contextLine || props.contextFacts ? <ApprovalContextLine context={props.context}
                        facts={props.contextFacts} showWorkspace={!pathLabel} /> : null}
                    {homeLabel ? (
                        <Text style={styles.homeLabel}>{t('actionConfirmations.homeTarget', { serverId: homeLabel })}</Text>
                    ) : null}
                </View>

                {props.session?.id ? (
                    <Pressable
                        testID="approvals.open-session"
                        accessibilityRole="button"
                        accessibilityLabel={t('runs.openSession')}
                        onPress={() => router.push(buildScopedSessionRouteHref({
                            sessionId: props.session!.id,
                            serverId: props.serverId,
                        }))}
                        style={({ pressed }) => [styles.openButton, pressed && styles.openButtonPressed]}
                    >
                        <Icon name="arrow-square-out" size={16} color={theme.colors.text.primary} />
                    </Pressable>
                ) : null}
            </View>

            {agentLabel || originLabel ? (
                // Who asked and how it arrived, as one quiet line of words (never the stored enum).
                <Text testID="approvals.requester-origin" style={styles.metaText}>
                    {joinHappierFacts(agentLabel, originLabel)}
                </Text>
            ) : null}
        </View>
        </SectionContentRow>
        </ItemGroup>
    );
});

const styles = StyleSheet.create((theme) => ({
    // Sheet content of the "Requested by" section: the section owns the chrome.
    card: {
        gap: 12,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
    },
    titleColumn: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.default('medium'),
        fontSize: 15,
        color: theme.colors.text.primary,
    },
    contextChips: {
        marginTop: 8,
    },
    homeLabel: {
        marginTop: 8,
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    metaText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        lineHeight: 18,
    },
    openButton: {
        width: 32,
        height: 32,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    openButtonPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
}));
