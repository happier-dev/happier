import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { glassContentFill } from '@/components/ui/glass/glassSurfacePaint';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { useSessionReferenceTarget } from '@/sync/domains/state/storage';
import { Icon } from '@/components/ui/icons/Icon';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { TranscriptStructuredReference } from './messageStructuredReferences';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useTranscriptFileLinks } from '../useTranscriptFileLinks';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';

/**
 * The transcript's structured-references row (D-6). It presents every reference a message
 * carries — files and sessions — **below** the markdown body rather than as inline link nodes,
 * which is the presentation this row has always used for files. It replaces
 * `LinkedWorkspaceFilesRow` rather than sitting beside it, so the transcript keeps exactly one
 * reference-presentation owner.
 *
 * Session references keep the transcript navigation owner; files enter the shared workspace Action.
 */

const REFERENCE_PREFIX = '@';

export type StructuredReferencesRowProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    references: readonly TranscriptStructuredReference[];
    fileOpenEnabled: boolean;
    routeMessageId?: string | null;
    seq?: number | null;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        maxWidth: '100%',
        minWidth: 0,
        gap: theme.space.s8,
        marginTop: theme.space.s8,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        flexShrink: 1,
        minWidth: 0,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: glassContentFill(theme.colors.surface.inset, theme.colors),
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s6,
        borderRadius: 999,
        maxWidth: '100%',
    },
    chipPressed: {
        opacity: motionTokens.press.opacitySubtle,
    },
    chipText: {
        flexShrink: 1,
        minWidth: 0,
        color: theme.colors.text.primary,
        ...Typography.variant('meta', 'semiBold'),
    },
    chipSubtle: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
}));

function getBasename(path: string): string {
    const parts = path.split('/');
    const last = parts.at(-1) ?? path;
    return last || path;
}

const SessionReferenceChip = React.memo((props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    label: string | null;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const transcriptSource = useSessionTranscriptSource();
    const target = useSessionReferenceTarget(props.sessionId, props.serverId);
    const isSessionVisible = useSessionRecordingVisibility();

    // The live title wins over the label captured when the reference was composed, so a renamed
    // session reads correctly without the reference changing — identity is the id, and the
    // label is advisory display only.
    //
    // `metadata` is `Metadata | null` on a stored session, so a cached session is not necessarily
    // a named one: without this guard `getSessionName` falls through to `t('status.unknown')`,
    // which is not null and would therefore beat the composed label. A reference that knows what
    // it pointed at must not degrade to "Unknown" just because metadata has not resolved.
    const liveTitle = target.metadata
        ? getSessionName({ id: props.sessionId, metadata: target.metadata }, props.serverId)
        : null;
    const title = isSessionVisible({ sessionId: props.sessionId, serverId: props.serverId })
        ? liveTitle ?? props.label : t('message.provenanceSession');

    const openSession = React.useCallback(() => {
        transcriptSource.navigate?.(buildScopedSessionRouteHref({
            sessionId: props.sessionId,
            serverId: props.serverId,
        }));
    }, [props.serverId, props.sessionId, transcriptSource]);

    const testID = `transcript-session-reference:${props.sessionId}`;

    // Only a session this viewer has watched be deleted lands here. An inert chip that still says
    // what it referred to is the honest presentation for that; a pressable one would be a link to
    // nowhere. A session merely missing from the list caches — an archived one, or any row the
    // last refresh did not cover — stays pressable, because it is still openable at its route and
    // the route answers a genuinely missing id itself.
    if (transcriptSource.navigate === null && !target.deleted) {
        return <View testID={testID} style={styles.chip}><Text style={styles.chipText}>{REFERENCE_PREFIX}{title ?? props.sessionId}</Text></View>;
    }
    if (target.deleted) {
        const unavailableText = t('message.sessionReferenceUnavailable');
        return (
            <View
                testID={testID}
                style={styles.chip}
                accessibilityRole="text"
                accessibilityLabel={title ? `${title} — ${unavailableText}` : unavailableText}
            >
                <Icon name="chat-circle" size={14} color={theme.colors.text.secondary} />
                <Text style={styles.chipSubtle}>{REFERENCE_PREFIX}</Text>
                {title ? (
                    <Text style={styles.chipSubtle} numberOfLines={1}>{title}</Text>
                ) : null}
                <Text style={styles.chipSubtle} numberOfLines={1}>{unavailableText}</Text>
            </View>
        );
    }

    return (
        <Pressable
            testID={testID}
            onPress={openSession}
            style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
            accessibilityRole="button"
            accessibilityLabel={t('message.sessionReferenceOpen', { name: title ?? props.sessionId })}
        >
            <Icon name="chat-circle" size={14} color={theme.colors.text.secondary} />
            <Text style={styles.chipSubtle}>{REFERENCE_PREFIX}</Text>
            <Text style={styles.chipText} numberOfLines={1}>{title ?? props.sessionId}</Text>
        </Pressable>
    );
});

export const StructuredReferencesRow = React.memo((props: StructuredReferencesRowProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const transcriptSource = useSessionTranscriptSource();
    const { openPath: openFile, canOpen: canOpenFile } = useTranscriptFileLinks({
        sessionId: props.sessionId, serverId: props.serverId,
        workspacePath: transcriptSource.useWorkspacePath(), canOpenFiles: props.fileOpenEnabled,
        routeMessageId: props.routeMessageId, seq: props.seq,
    });

    if (props.references.length === 0) return null;

    return (
        <View style={styles.row}>
            {props.references.map((reference) => {
                if (reference.kind === 'session') {
                    return (
                        <SessionReferenceChip
                            key={`session:${reference.sessionId}`}
                            sessionId={reference.sessionId}
                            serverId={props.serverId}
                            label={reference.label}
                        />
                    );
                }

                const path = reference.path;
                const content = (
                    <>
                        <Icon name="file-text" size={14} color={theme.colors.text.secondary} />
                        <Text style={styles.chipSubtle}>{REFERENCE_PREFIX}</Text>
                        <Text style={styles.chipText} numberOfLines={1}>
                            {getBasename(path)}
                        </Text>
                    </>
                );
                return canOpenFile ? (
                    <Pressable
                        key={`file:${path}`}
                        testID={`linked-workspace-file:${path}`}
                        onPress={(event) => { openFile(path, { event }); }}
                        style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
                        accessibilityRole="button"
                    >
                        {content}
                    </Pressable>
                ) : (
                    <View
                        key={`file:${path}`}
                        testID={`linked-workspace-file:${path}`}
                        style={styles.chip}
                        accessibilityRole="text"
                    >
                        {content}
                    </View>
                );
            })}
        </View>
    );
});
