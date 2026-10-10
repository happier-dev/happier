import type { createActionExecutor } from '@happier-dev/protocol';
import { createHomeHubArtifactPortV1, HomeHubLayoutV1Schema, type HomeHubArtifactTransportV1, type HomeHubLayoutIntent } from '@happier-dev/protocol/home';
import { classifyWidgetDefinitionCommandResult } from '@/components/widgets/definitions/widgetDefinitionCommands';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { t } from '@/text';

/** The mounted queue's Action adapter; the existing Artifact owner still commits every intent. */
export async function executeHomeHubLayoutIntent(input: Readonly<{
    intent: HomeHubLayoutIntent;
    scope: Readonly<{ serverId: string; accountId: string }>;
    transport: HomeHubArtifactTransportV1;
    execute: ReturnType<typeof createActionExecutor>['execute'];
}>) {
    const context = {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: input.scope.serverId, expectedAccountId: input.scope.accountId,
    } as const;
    const result = input.intent.kind === 'widget_size'
        ? await input.execute('widgets.item.size.set', { ref: {
            surface: { ...input.scope, owner: { kind: 'home' } }, instanceId: input.intent.instanceId,
        }, size: input.intent.size }, context)
        : await input.execute('home.hub.layout.update', { intent: input.intent }, context);
    if (input.intent.kind === 'widget_size') {
        const outcome = classifyWidgetDefinitionCommandResult('widgets.item.size.set', result);
        if (outcome.kind === 'refused') throw Object.assign(new Error(outcome.errorCode), { code: outcome.errorCode });
        // Universal mutation acknowledgement does not fabricate a native layout revision.
        const layout = await createHomeHubArtifactPortV1(input.transport, { accountId: input.scope.accountId }).read();
        if (outcome.kind === 'approvalPending') publishPresentationNotice({
            key: `${input.scope.serverId}:${input.scope.accountId}:${input.intent.instanceId}:size`,
            severity: 'info', message: t('widgetAdd.areaApprovalPending'),
        });
        return layout;
    }
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
    const value = result.result;
    if (!value || typeof value !== 'object' || !('layout' in value)) throw new Error('Home layout acknowledgement unavailable');
    return HomeHubLayoutV1Schema.parse(value.layout);
}
