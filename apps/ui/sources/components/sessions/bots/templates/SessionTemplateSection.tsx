import * as React from 'react';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { readSessionTemplateDraftRef, useOpenBotTemplate } from './openBotTemplate';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { BotTemplateRecipientInfo } from './BotTemplateRecipientInfo';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { readSessionStateFieldFromMetadata } from '@happier-dev/agents';

/**
 * Session Info's Template section (r2 `give-inforow`, `update-inforow`): after Setup, one row that
 * names the template and opens it. A copied Bot keeps its provenance and follow controls here too.
 */
export function SessionTemplateSection(props: Readonly<{ session: Session; serverId: string }>) {
    const open = useOpenBotTemplate(props.session, props.serverId);
    const [expanded, setExpanded] = React.useState(false);
    if (readSessionBotV1(props.session.metadata?.bot)?.kind !== 'bot') return null;
    const draft = readSessionTemplateDraftRef(props.session);
    const metadata = readSessionOwnerMetadataView(props.session);
    const instance = metadata ? readSessionStateFieldFromMetadata(metadata, 'intent.templateInstance') : null;
    if (!instance && !open) return null;
    const name = getSessionName(props.session, props.serverId);
    const authorRow = open ? <Item testID={instance ? 'bot-template-author-door' : 'bot-template-author-row'} icon={<Icon name="file-text" />}
        title={draft ? t('botTemplates.namedTemplate', { name }) : t('botTemplates.giveCopyEllipsis')}
        subtitle={t(draft ? 'botTemplates.privateDraft' : 'botTemplates.giveCopyDescription')}
        onPress={() => { void open(); }} /> : null;
    return <ItemGroup testID="session-template-section" title={t('botTemplates.templateSection')}
        description={instance ? undefined : t('botTemplates.templateSectionDescription', { name })}>
        {instance ? <BotTemplateRecipientInfo instance={instance} serverId={props.serverId}
            sessionRef={{ serverId: props.serverId, sessionId: props.session.id }} renderTemplate={facts =>
                <ExpandableItem expanded={expanded} onExpandedChange={setExpanded}
                    header={({ headerProps }) => <Item {...headerProps} testID="bot-template-recipient-row" icon={<Icon name="file-text" />}
                        // "<Author>'s template" (lab r2 update-inforow); the template's name only when its author is unknown.
                        // Beneath it the version this Bot has, then any offered one, so a narrow pane never truncates them.
                        title={facts.author ? t('botTemplates.authorsTemplate', { author: facts.author }) : facts.name ?? name}
                        titleLines={1} rightElementOutsidePressable
                        subtitle={facts.availableVersion ? `v${instance.acceptedVersion} · ${t('botTemplateRecipient.availableVersion', { version: facts.availableVersion })}`
                            : `v${instance.acceptedVersion}`}
                        rightElement={facts.availableVersion ? <TextLinkButton testID="bot-template-review-updates"
                            label={t('botTemplateRecipient.review')} onPress={facts.review} /> : undefined} />}>
                    {expanded ? <>{facts.details}{authorRow}</> : null}
                </ExpandableItem>} /> : authorRow}
    </ItemGroup>;
}
