import * as React from 'react';
import type { BotTemplateContentV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { BotTemplateArtifactPresentationV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { PageHeader, type PageHeaderTextEditor } from '@/components/ui/layout/PageHeader';
import { PAGE_HEADER_MARK_SLOT_SIZE_PX, PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { Text } from '@/components/ui/text/Text';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { t } from '@/text';

/**
 * The identity anatomy shared by authoring, previews, and recipient Info (R10): the face in the page
 * mark slot, the name, then the byline (author · version · sharing) and the quieter made-from line.
 * `prominence="hero"` is a template's own page; the pane editor keeps the page step. A page that says
 * what the Bot does in its own section passes `descriptionPlacement="body"` so the sentence is said once.
 */
export function BotTemplateHeader(props: Readonly<{
    identity: BotTemplateContentV1['identity'];
    author?: string;
    version: string;
    sharing?: string;
    presentation?: BotTemplateArtifactPresentationV1;
    leading?: React.ReactNode;
    titleEditor?: PageHeaderTextEditor;
    descriptionEditor?: PageHeaderTextEditor;
    actions?: React.ReactNode;
    status?: React.ReactNode;
    prominence?: 'page' | 'hero';
    descriptionPlacement?: 'header' | 'body';
}>) {
    const author = props.presentation ? props.presentation.ownerDisplayName ?? undefined : props.author;
    const sharing = props.presentation ? props.presentation.shared === true ? t('botTemplates.shared')
        : props.presentation.shared === false ? t('botTemplates.private') : undefined : props.sharing;
    const byline = author && sharing
        ? t('botTemplates.byline', { author, version: props.version, sharing })
        : [author, props.version, sharing].filter(Boolean).join(' · ');
    return <PageHeader title={props.identity.name} titleProminence={props.prominence}
        description={props.descriptionPlacement === 'body' ? undefined : props.identity.description}
        titleEditor={props.titleEditor} descriptionEditor={props.descriptionPlacement === 'body' ? undefined : props.descriptionEditor}
        leading={<PageHeaderMarkSlot testID="bot-template-header-mark">{props.leading
            ?? <SessionBotFace facts={{ seed: props.identity.name, face: props.identity.face ?? null }}
                size={PAGE_HEADER_MARK_SLOT_SIZE_PX.page} motion={false} />}</PageHeaderMarkSlot>}
        details={<View style={styles.identityLines}>
            <Text variant="body" style={styles.byline} testID="bot-template-byline">{byline}</Text>
            {props.identity.madeFromName ? <Text variant="meta" style={styles.madeFrom}>
                {t('botTemplates.madeFrom', { name: props.identity.madeFromName })}</Text> : null}
        </View>}
        actions={props.actions} actionsPlacement="page" status={props.status} alwaysShowTitle testID="bot-template-header" />;
}

const styles = StyleSheet.create(theme => ({
    identityLines: { gap: theme.space.s2 },
    byline: { color: theme.colors.text.secondary },
    madeFrom: { color: theme.colors.text.tertiary },
}));
