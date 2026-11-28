import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { BotTemplateSourceWorkflowV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { SessionWorkflowContextRead } from '@/components/workflows/triggers/useSessionWorkflowContext';
import { buildTriggerDefinition, createDefaultWhen } from '@/components/workflows/triggers/sessionTriggerForm';
import { createWorkflowTriggerClientId, type WorkflowTriggerStartContext } from '@/components/workflows/triggers/workflowTriggerStarts';
import { prepareWorkflowSentenceEditorEntry } from '@/components/workflows/authoring/workflowSentenceAuthoring';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
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
    // One action row on the section's grid (owner 0936 #14): "Give a copy…" with the copy glyph its ⋯ menu entry
    // uses, and the chevron of the page it opens. Where the section's description already says what a copy is,
    // the action carries no second sentence; a private draft names itself and says it is one.
    const subtitle = draft ? t('botTemplates.privateDraft') : instance ? t('botTemplates.giveCopyDescription') : undefined;
    const authorRow = open ? <Item testID={instance ? 'bot-template-author-door' : 'bot-template-author-row'}
        icon={<Icon name={draft ? 'file-text' : 'copy'} />}
        title={draft ? t('botTemplates.namedTemplate', { name }) : t('botTemplates.giveCopyEllipsis')}
        {...(subtitle ? { subtitle } : {})}
        onPress={() => { void open(); }} /> : null;
    return <ItemGroup testID="session-template-section" title={t('botTemplates.templateSection')}
        description={instance ? undefined : t('botTemplates.templateSectionDescription', { name })}>
        {instance?.channelNeeds?.map(need => <Item key={need.key} title={need.name} mode="info" showChevron={false}
            testID={`bot-template-session-channel:${need.key}`}
            subtitle={t('botTemplateRecipient.linkInSession')} />)}
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

/** Project the existing Automations read into the regular Workflow editor's draft. */
export function BotTemplateSourceWorkflowNeeds({ subject, workflows, pullRequestLinks, accountLifetime }: Readonly<{
    subject: NonNullable<WorkflowTriggerStartContext['session']>['subject'];
    workflows: readonly BotTemplateSourceWorkflowV1[];
    pullRequestLinks: SessionWorkflowContextRead['pullRequestLinks'] | undefined;
    accountLifetime: ServerAccountScopeLifetime | null | undefined;
}>) {
    const router = useRouter();
    const links = Array.isArray(pullRequestLinks) ? pullRequestLinks : [];
    return <>{workflows.map(workflow => {
        const { trigger, name } = workflow.source;
        const open = accountLifetime && links.length && trigger.kind !== 'pluginEvent' ? () => {
            const when = createDefaultWhen(trigger.kind, links);
            const complete = buildTriggerDefinition({ when, enabled: false, sessionId: subject.sessionId });
            const route = prepareWorkflowSentenceEditorEntry({
                name: workflow.title, definition: workflow.definition,
                lifetimeSession: { sessionId: subject.sessionId }, startContext: { session: { subject, pullRequestLinks: links } },
                ...(complete ? { trigger: complete } : {}),
            }, accountLifetime, complete ? undefined : {
                incompleteTriggers: { pending: [{ clientId: createWorkflowTriggerClientId(), when, enabled: false }], edits: {} },
            });
            if (route) router.push(route);
        } : undefined;
        return <Item key={workflow.key} title={workflow.title}
            testID={`bot-template-session-automation:${workflow.key}`}
            subtitle={t(open ? 'botTemplateRecipient.reviewSuggestedAutomation' : 'botTemplateRecipient.automationNeedsSource', { source: name })}
            {...(open ? { onPress: open } : { mode: 'info' as const, showChevron: false })} />;
    })}</>;
}
