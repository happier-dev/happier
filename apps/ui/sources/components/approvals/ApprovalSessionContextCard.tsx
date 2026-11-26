import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock, joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    resolveSessionContextLine,
    projectSessionContextPresentation,
    resolveSessionHomeLastUpdatedLabel,
    readSessionHomeLastUpdatedLabelRefreshAtMs,
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
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import type { ApprovalSessionReadingStatus } from './useApprovalSessionReading';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
    approvalOriginNamesRequester,
    describeApprovalAgent,
    describeApprovalOrigin,
    describeUnnamedApprovalRequester,
    resolveApprovalHomeSentenceName,
} from './approvalRequesterLabels';
import { useApprovalAccountLabel } from './useApprovalAccountLabel';

const ApprovalContextLine = React.memo(function ApprovalContextLine(props: Readonly<{
    context: SessionContextPresentation | null;
    facts?: SessionContextFacts | null;
    showWorkspace: boolean;
}>) {
    const readNextRefresh = React.useCallback((nowMs: number) => props.facts
        ? readSessionHomeLastUpdatedLabelRefreshAtMs(props.facts.freshness, nowMs) : null, [props.facts]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, useHostActivelyViewed());
    const context = props.facts ? projectSessionContextPresentation({ ...props.facts, freshness: {
        ...props.facts.freshness,
        lastUpdatedLabel: resolveSessionHomeLastUpdatedLabel(props.facts.freshness, nowMs),
    } }) : props.context;
    const line = resolveSessionContextLine(context ? { segments: context.segments.filter((segment) => segment.kind !== 'home') } : null,
        { showWorkspace: props.showWorkspace });
    return line ? <Text style={styles.homeLabel}>{line}</Text> : null;
});

/**
 * The "Requested by" section of an approval page: the requesting session, where it runs, and the
 * agent and surface that asked. Renders nothing when none of that is known.
 */
export const ApprovalSessionContextCard = React.memo(function ApprovalSessionContextCard(props: Readonly<{
    session: Session | SessionListRenderableSession | null;
    /** The asking machine's settled name (`useServerScopedMachineLabel`). */
    machineLabel: string | null;
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
    /** The requester's name from `useApprovalSessionReading`, its one readable-name gate; null while locked or unknown. */
    sessionName: string | null;
    /** The session the request names; when this device does not have it, it reads by where it lives. */
    requesterSessionId?: string | null;
    requesterStatus?: ApprovalSessionReadingStatus;
    requesterAgentId: string | null;
    /** The Account the request was admitted for; names the person who asked when no Session or Agent did. */
    requesterAccountId?: string | null;
    requesterSurface: string;
    /** Happier's own host asked (Guard's Asks); a Session it names is the work's owner, not the requester. */
    requestedByGuard?: boolean;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const homeName = props.homeName?.trim() || null;
    const guard = props.requestedByGuard === true;
    const isRecordingVisible = useSessionRecordingVisibility();
    // The person who asked, as this viewer may see them: You, a known name, or nothing (never guessed).
    const personLabel = useApprovalAccountLabel(props.serverId, guard ? undefined : props.requesterAccountId?.trim() || undefined);
    const requesterId = props.requesterSessionId ?? props.session?.id;
    const recordingVisible = !requesterId || isRecordingVisible({ sessionId: requesterId,
        serverId: props.serverId ?? props.session?.serverId });
    const namedSession = guard || !recordingVisible ? null : props.sessionName?.trim() || null;
    // A session this device cannot name is never shown by its id: it reads by where it lives.
    const sentenceHome = homeName ?? resolveApprovalHomeSentenceName(props.serverId);
    const sessionTitle = namedSession
        ?? (!guard && props.requesterSessionId?.trim() && props.requesterStatus !== 'resolving' ? describeUnnamedApprovalRequester(props.requesterSurface, sentenceHome) : null);
    // The agent that asked: the request's own record, else the asking Session's Agent (R12 (d)).
    const sessionAgentId = guard || !props.session ? null
        : resolveAgentIdFromSessionMetadata(readSessionOwnerMetadataView(props.session));
    const agentLabel = recordingVisible ? describeApprovalAgent(props.requesterAgentId ?? sessionAgentId) : null;
    // A named Agent is the more exact fact than "Asked by an agent" or "Asked by Happier": one fact once.
    const surface = props.requesterSurface.trim();
    const originLabel = guard || (agentLabel && (surface === 'system' || surface === 'agent' || surface === 'session_agent'))
        ? null : describeApprovalOrigin(props.requesterSurface);
    const endpointLabels = readApprovalSessionEndpointLabels({
        session: recordingVisible ? props.session : null,
        machine: null,
    });
    const machineLabel = recordingVisible ? props.machineLabel : null;
    const pathLabel = !recordingVisible ? null : props.serverId ? props.context?.workspace?.label ?? null : endpointLabels.pathLabel;
    // Each fact once: the chips carry the machine and the folder, so the context line leaves the
    // folder out. The Home is named by this section's own Home line (the app's name for it, not the address the
    // session context falls back to), so the context line carries only what else is known.
    const contextLine = guard || !recordingVisible ? null : resolveSessionContextLine(
        props.context ? { segments: props.context.segments.filter((segment) => segment.kind !== 'home') } : null,
        { showWorkspace: !pathLabel },
    );
    // While the asking session is read, its line is held by a neutral placeholder: nothing claims it is
    // elsewhere, and nothing else takes the lead only to be replaced when the name lands.
    const sessionResolving = !guard && !namedSession && props.requesterStatus === 'resolving' && Boolean(props.requesterSessionId?.trim());
    const homeLabel = guard ? null : namedSession || (!sessionTitle && !sessionResolving)
        ? homeName ?? props.homeDisplayId?.trim() ?? null
        // "A session on <Home>" already names the Home.
        : sentenceHome ? null : props.homeDisplayId?.trim() ?? null;

    // The main line names who asked: the session, else the Agent or an origin that is itself the asker ("Asked by
    // Happier"), else the person (You, or their name). A Home's label never stands in for them, and a channel alone
    // ("Asked from the command line") names no one: with nobody to name, the section is left out (UI refinements
    // 2026-11-25 14:53Z, item 3).
    const noSession = !sessionTitle && !sessionResolving;
    const askerLine = noSession && (agentLabel || (originLabel && approvalOriginNamesRequester(surface)))
        ? joinHappierFacts(agentLabel, originLabel) : null;
    const personLeads = noSession && !askerLine && Boolean(personLabel);
    if (!guard && !sessionTitle && !sessionResolving && !askerLine && !personLeads) {
        return null;
    }
    // Who asked, how, and from which Home: one quiet facts line, not a separate "Home: …" label.
    const requesterFacts = askerLine ? homeLabel
        : agentLabel || originLabel || homeLabel ? joinHappierFacts(agentLabel, originLabel, homeLabel) : null;
    const mainLine = guard ? t('detailPages.approval.requesterGuard') : sessionTitle ?? askerLine ?? (personLeads ? personLabel : null);

    return (
        <ItemGroup
            title={t('detailPages.approval.contextTitle')}
            // The description promises a session only when one asked.
            description={t(guard ? 'detailPages.approval.requesterGuardDescription'
                : sessionTitle || sessionResolving ? 'detailPages.approval.contextDescription' : 'detailPages.approval.contextDescriptionNoSession')}
        >
        <SectionContentRow>
        <View style={styles.card}>
            <View style={styles.headerRow}>
                <View style={styles.titleColumn}>
                    {sessionResolving ? (
                        <HappierSkeletonBlock testID="approvals.requester-title-resolving" width={180}
                            height={REQUESTER_TITLE_LINE_PX} color={theme.colors.surface.skeleton} />
                    ) : mainLine ? <Text testID="approvals.requester-title" numberOfLines={2} style={styles.title}>{mainLine}</Text> : null}
                    {machineLabel || pathLabel ? (
                        <View style={mainLine || sessionResolving ? styles.contextChips : null}>
                            <SessionContextChips machineLabel={machineLabel} pathLabel={pathLabel} />
                        </View>
                    ) : null}
                    {recordingVisible && (contextLine || (!guard && props.contextFacts)) ? <ApprovalContextLine context={props.context}
                        facts={props.contextFacts} showWorkspace={!pathLabel} /> : null}
                </View>

                {!guard && props.session?.id ? (
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

            {requesterFacts ? (
                // Who asked and how it arrived, as one quiet line of words (never the stored enum).
                <Text testID="approvals.requester-origin" style={styles.metaText}>
                    {requesterFacts}
                </Text>
            ) : null}
        </View>
        </SectionContentRow>
        </ItemGroup>
    );
});

/** The session line's height at its 15 pt title, so the name lands without moving the card. */
const REQUESTER_TITLE_LINE_PX = 20;

const styles = StyleSheet.create((theme) => ({
    // Sheet content of the "Requested by" section: the section owns the chrome.
    card: {
        gap: theme.space.s12,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s12,
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
        marginTop: theme.space.s8,
    },
    homeLabel: {
        marginTop: theme.space.s8,
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
