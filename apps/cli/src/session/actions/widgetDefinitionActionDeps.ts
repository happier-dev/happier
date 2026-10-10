import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createWidgetDefinitionArtifactPortV1 } from '@happier-dev/protocol/widgets/widgetDefinitionArtifactV1';
import { createWidgetLayoutFragmentArtifactPortV1 } from '@happier-dev/protocol/widgets';
import { createSessionWidgetDefinitionSourceReaderV1 } from '@happier-dev/protocol/widgets/widgetDefinitionPromotionV1';
import { isSameWidgetDefinitionV1, widgetCandidateDefinitionV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import type { WidgetDefinitionArtifactTransportV1, WidgetInputDescriptorV1, WidgetCandidateIdentityV1 } from '@happier-dev/protocol/widgets';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export function createCliWidgetDefinitionActionDepsV1(input: Readonly<{
    transport: WidgetDefinitionArtifactTransportV1; accountId: string; serverHttpBaseUrl?: string;
    getDeps(): ActionExecutorDeps;
    readCandidates(signal?: AbortSignal, session?: Readonly<{ serverId: string; sessionId: string }>): Promise<readonly (WidgetInputDescriptorV1 & WidgetCandidateIdentityV1)[]>;
}>): Pick<ActionExecutorDeps, 'widgetDefinitionArtifacts' | 'widgetLayoutFragmentArtifacts' | 'readSessionWidgetDefinitionSource'> {
    const run = <T>(operation: () => Promise<T>) => input.serverHttpBaseUrl ? runWithServerHttpBaseUrl(input.serverHttpBaseUrl, operation) : operation();
    const transport: WidgetDefinitionArtifactTransportV1 = {
        read: (id, options) => run(() => input.transport.read(id, options)),
        list: options => run(() => input.transport.list(options)),
        create: args => run(() => input.transport.create(args)),
        update: args => run(() => input.transport.update(args)),
        delete: (id, options) => run(() => input.transport.delete(id, options)),
    };
    return { widgetDefinitionArtifacts: createWidgetDefinitionArtifactPortV1(transport, { accountId: input.accountId }),
        widgetLayoutFragmentArtifacts: createWidgetLayoutFragmentArtifactPortV1(transport, { accountId: input.accountId }),
        readSessionWidgetDefinitionSource: async request => {
            const action = input.getDeps().sessionBoardAction;
            if (!action) return { ok: false, errorCode: 'widget_definition_promotion_unavailable', error: 'widget_definition_promotion_unavailable' };
            return createSessionWidgetDefinitionSourceReaderV1({ sessionBoardAction: action,
                readInstalledDescriptor: async (definition, read) => (await input.readCandidates(read.signal, read.session))
                    .find(candidate => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), definition)) ?? null,
            })(request);
        },
    };
}
