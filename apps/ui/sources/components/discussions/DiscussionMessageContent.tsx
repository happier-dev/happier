import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';

import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { MarkdownView, type MarkdownInlineReferences } from '@/components/markdown/MarkdownView';
import { Text } from '@/components/ui/text/Text';
import { referenceChipFill } from '@/components/ui/referenceChip/referenceChipFill';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { t } from '@/text';

import { projectDiscussionMessageReferences } from './discussionTimelineProjection';

/** Discussion parts use the same inline reference presentation as the Session transcript. */
export function DiscussionMessageContent(props: Readonly<{
    message: Pick<DiscussionOpenedMessageV1, 'id' | 'content'>;
    serverId: string;
    resolveAccountLabel?: (accountId: string) => string | null;
    resolveSessionLabel?: (sessionId: string) => string | null;
    textStyle?: StyleProp<TextStyle>;
    /** A thread page renders bodies as a Session transcript does; a compact card keeps the default step. */
    profile?: 'transcript';
    /** The row draws the message's files below the body, so they are not repeated as trailing chips. */
    attachmentsBelow?: boolean;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const projection = React.useMemo(() => props.message.content
        ? projectDiscussionMessageReferences(props.message.content, {
            account: props.resolveAccountLabel, session: props.resolveSessionLabel,
        }, undefined, props.attachmentsBelow ? 'omit' : 'append') : null, [props.attachmentsBelow, props.message.content, props.resolveAccountLabel, props.resolveSessionLabel]);
    const ink = theme.colors.text.primary;
    const inlineReferences = React.useMemo<MarkdownInlineReferences | undefined>(() => {
        if (!projection?.inline.size) return undefined;
        return {
            resolve: (ref) => {
                const reference = projection.inline.get(ref);
                return reference ? {
                    label: reference.label, glyph: reference.glyph,
                    foreground: ink, background: referenceChipFill(ink),
                } : null;
            },
            onPress: (ref) => {
                const reference = projection.inline.get(ref);
                if (reference?.sessionId && props.resolveSessionLabel?.(reference.sessionId)) {
                    router.push(buildScopedSessionRouteHref({ serverId: props.serverId, sessionId: reference.sessionId }) as Href);
                }
            },
        };
    }, [ink, projection, props.resolveSessionLabel, props.serverId, router]);
    const testID = `session-discussion-message-content-${props.message.id}`;
    // Every message body is Markdown, with or without mentions: an Agent's answer keeps its emphasis and code blocks.
    if (!projection) return <Text testID={testID} selectable style={props.textStyle}>
        {t('session.collaboration.discussion.contentUnavailable')}
    </Text>;
    return <MarkdownView testID={testID} markdown={projection.text} textStyle={props.textStyle}
        selectable inlineReferences={inlineReferences} {...(props.profile ? { profile: props.profile } : {})} />;
}
