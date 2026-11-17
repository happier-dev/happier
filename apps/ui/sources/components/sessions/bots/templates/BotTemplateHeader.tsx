import * as React from 'react';
import type { BotTemplateContentV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { BotTemplateArtifactPresentationV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { PageHeader, type PageHeaderTextEditor } from '@/components/ui/layout/PageHeader';
import { PAGE_HEADER_MARK_SLOT_SIZE_PX, PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { Text } from '@/components/ui/text/Text';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { BotTemplateFace } from './BotTemplateFace';
import { t } from '@/text';

/**
 * The identity anatomy shared by authoring, previews, and recipient Info (R10): the face in the page
 * mark slot, the name, then the byline (author · version · sharing) and the quieter made-from line.
 * A page that says what the Bot does in its own section passes `descriptionPlacement="body"` so the
 * sentence is said once.
 */
export function BotTemplateHeader(props: Readonly<{
    identity: BotTemplateContentV1['identity'];
    /** The pet that travels with the template (PET-SHARE): drawn as the face when present. */
    pet?: BotTemplateContentV1['pet'];
    author?: string;
    version: string;
    sharing?: string;
    presentation?: BotTemplateArtifactPresentationV1;
    leading?: React.ReactNode;
    titleEditor?: PageHeaderTextEditor;
    descriptionEditor?: PageHeaderTextEditor;
    actions?: React.ReactNode;
    status?: React.ReactNode;
    descriptionPlacement?: 'header' | 'body';
}>) {
    const author = props.presentation ? props.presentation.ownerDisplayName ?? undefined : props.author;
    const sharing = props.presentation ? props.presentation.shared === true ? t('botTemplates.shared')
        : props.presentation.shared === false ? t('botTemplates.private') : undefined : props.sharing;
    // Versions read as "v1.2" wherever a template names one (the update offer says "v1.3 available").
    const version = `v${props.version}`;
    const byline = author && sharing
        ? t('botTemplates.byline', { author, version, sharing })
        : [author, version, sharing].filter(Boolean).join(' · ');
    return <PageHeader title={props.identity.name}
        description={props.descriptionPlacement === 'body' ? undefined : props.identity.description}
        titleEditor={props.titleEditor} descriptionEditor={props.descriptionPlacement === 'body' ? undefined : props.descriptionEditor}
        leading={<PageHeaderMarkSlot testID="bot-template-header-mark">{props.leading
            ?? <BotTemplateFace identity={props.identity} pet={props.pet} size={PAGE_HEADER_MARK_SLOT_SIZE_PX.page} />}</PageHeaderMarkSlot>}
        details={<View style={styles.identityLines}>
            {/* The byline leads with the author's own mark (lab r2 R10 header); a template with no known author has none. */}
            <View style={styles.bylineRow}>
                {author ? <Avatar id={author} monogram={author} title size={ICON_SIZE.md} /> : null}
                <Text variant="body" style={styles.byline} testID="bot-template-byline">{byline}</Text>
            </View>
            <Text variant="meta" style={styles.madeFrom}>{props.identity.madeFromName
                ? t('botTemplates.madeFrom', { name: props.identity.madeFromName }) : t('botTemplates.title')}</Text>
        </View>}
        actions={props.actions} actionsPlacement="page" status={props.status} alwaysShowTitle testID="bot-template-header" />;
}

const styles = StyleSheet.create(theme => ({
    identityLines: { gap: theme.space.s2 },
    bylineRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    byline: { flexShrink: 1, color: theme.colors.text.secondary },
    madeFrom: { color: theme.colors.text.tertiary },
}));
