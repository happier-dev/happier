import * as React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { shouldRedirectDetailsRouteToPanes } from '@/components/ui/panels/shouldRedirectDetailsRouteToPanes';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSetting, useSessionReferenceTarget } from '@/sync/domains/state/storage';
import { Icon } from '@/components/ui/icons/Icon';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { TranscriptStructuredReference } from './messageStructuredReferences';

/**
 * The transcript's structured-references row (D-6). It presents every reference a message
 * carries — files and sessions — **below** the markdown body rather than as inline link nodes,
 * which is the presentation this row has always used for files. It replaces
 * `LinkedWorkspaceFilesRow` rather than sitting beside it, so the transcript keeps exactly one
 * reference-presentation owner.
 *
 * Navigation goes through the router / pane deep-link the rest of the app uses, never through
 * an agent action: `session.open` is `surfaces.session_agent: false` on purpose, because the
 * agent does not drive the user's navigation.
 *
 * The file-open dependencies stay row-level so a message with several file references keeps
 * one pane/layout subscription, exactly as it did before sessions joined the row. Only a
 * session chip subscribes per reference, because only it depends on a per-id store entry.
 */

const REFERENCE_PREFIX = '@';

export type StructuredReferencesRowProps = Readonly<{
    sessionId: string;
    references: readonly TranscriptStructuredReference[];
    fileOpenEnabled: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        maxWidth: '100%',
        minWidth: 0,
        gap: 8,
        marginTop: 8,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 1,
        minWidth: 0,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        maxWidth: '100%',
    },
    chipPressed: {
        opacity: 0.8,
    },
    chipText: {
        flexShrink: 1,
        minWidth: 0,
        color: theme.colors.text.primary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    chipSubtle: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        ...Typography.default(),
    },
}));

function getBasename(path: string): string {
    const parts = path.split('/');
    const last = parts.at(-1) ?? path;
    return last || path;
}

const SessionReferenceChip = React.memo((props: Readonly<{
    sessionId: string;
    label: string | null;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const target = useSessionReferenceTarget(props.sessionId);

    // The live title wins over the label captured when the reference was composed, so a renamed
    // session reads correctly without the reference changing — identity is the id, and the
    // label is advisory display only.
    //
    // `metadata` is `Metadata | null` on a stored session, so a cached session is not necessarily
    // a named one: without this guard `getSessionName` falls through to `t('status.unknown')`,
    // which is not null and would therefore beat the composed label. A reference that knows what
    // it pointed at must not degrade to "Unknown" just because metadata has not resolved.
    const liveTitle = target.metadata
        ? getSessionName({ id: props.sessionId, metadata: target.metadata })
        : null;
    const title = liveTitle ?? props.label;

    const openSession = React.useCallback(() => {
        router.push(`/session/${encodeURIComponent(props.sessionId)}` as never);
    }, [props.sessionId, router]);

    const testID = `transcript-session-reference:${props.sessionId}`;

    // Only a session this viewer has watched be deleted lands here. An inert chip that still says
    // what it referred to is the honest presentation for that; a pressable one would be a link to
    // nowhere. A session merely missing from the list caches — an archived one, or any row the
    // last refresh did not cover — stays pressable, because it is still openable at its route and
    // the route answers a genuinely missing id itself.
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
    const router = useRouter();
    const { width: windowWidth } = useWindowDimensions();
    const deviceType = useDeviceType();
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const paneScopeLayout = useOptionalAppPaneScopeLayout();

    const scopeId = React.useMemo(() => `session:${props.sessionId}`, [props.sessionId]);
    const pane = useAppPaneScope(scopeId);

    const openFile = React.useCallback((path: string) => {
        const containerWidthPx = paneScopeLayout?.containerWidthPx ?? windowWidth;
        const shouldOpenInDetailsPane = shouldRedirectDetailsRouteToPanes({
            containerWidthPx,
            deviceType,
            multiPaneEnabled,
        });

        if (!shouldOpenInDetailsPane) {
            const href = `/session/${props.sessionId}/file?path=${encodeURIComponent(path)}`;
            router.push(href as never);
            return;
        }

        pane.openDetailsTab({
            key: `file:${path}`,
            kind: 'file',
            title: getBasename(path),
            resource: { kind: 'file', path },
        });
    }, [deviceType, multiPaneEnabled, pane, paneScopeLayout?.containerWidthPx, props.sessionId, router, windowWidth]);

    if (props.references.length === 0) return null;

    return (
        <View style={styles.row}>
            {props.references.map((reference) => {
                if (reference.kind === 'session') {
                    return (
                        <SessionReferenceChip
                            key={`session:${reference.sessionId}`}
                            sessionId={reference.sessionId}
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
                return props.fileOpenEnabled ? (
                    <Pressable
                        key={`file:${path}`}
                        testID={`linked-workspace-file:${path}`}
                        onPress={() => openFile(path)}
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
