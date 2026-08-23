import { describe, expectTypeOf, it } from 'vitest';

import type {
    MessageActionAvailableSnapshotV1,
    PluginInvocationCaller,
    PluginInvocationContext,
    PluginInvocationSurface,
} from './invocation.js';
import type { MessageActionAvailableSnapshotV1 as PublicMessageActionAvailableSnapshotV1 } from './index.js';
import type { PluginInvocationContributionIdentity } from './identity.js';
import type { PluginMachineMaterializationRefV1 } from './executionOrigin.js';

type IsRequired<TValue, TKey extends keyof TValue> = {} extends Pick<TValue, TKey>
    ? false
    : true;

type ExpectedMessageActionAvailableSnapshotV1 = Readonly<{
    sessionId: string;
    messageId: string;
    observedRevision: string;
    role: 'user' | 'agent' | 'event' | 'unknown';
    contentCategory: 'text' | 'structured';
    seq: number;
    visibleText: string | null;
    structuredPresentationSummary: string | null;
    provenanceCategory:
        | 'owner'
        | 'collaborator'
        | 'plugin'
        | 'external_human'
        | 'automation'
        | 'voice'
        | 'terminal'
        | 'recovered_history'
        | 'unknown';
}>;

describe('Plugin invocation context', () => {
    it('makes the executing surface and host-stamped caller explicit', () => {
        const surfaceIsRequired: IsRequired<PluginInvocationContext, 'surface'> = true;
        void surfaceIsRequired;

        expectTypeOf<PluginInvocationSurface>().toEqualTypeOf<
            'cli' | 'mcp' | 'agent' | 'ui' | 'voice' | 'background' | 'api' | 'plugin'
        >();
        expectTypeOf<PluginInvocationCaller>().toEqualTypeOf<
            | Readonly<{
                kind: 'plugin';
                pluginId: string;
                contribution: PluginInvocationContributionIdentity;
                materialization: PluginMachineMaterializationRefV1;
                originSurface?: 'cli' | 'mcp' | 'agent' | 'ui' | 'voice' | 'background' | 'api';
            }>
            | Readonly<{
                kind: 'host';
                domain: 'ingress';
                originSurface: 'http' | 'webhook';
                contribution: PluginInvocationContributionIdentity;
            }>
            | Readonly<{
                kind: 'automationRun';
                runId: string;
                automationId: string;
                origin: 'schedule' | 'manual' | 'event' | 'conversation';
            }>
        >();
        expectTypeOf<PluginInvocationContext['caller']>()
            .toEqualTypeOf<PluginInvocationCaller | undefined>();
        expectTypeOf<PluginInvocationContext['ui']>()
            .toEqualTypeOf<import('./interactions.js').PresentationService | undefined>();
        expectTypeOf<MessageActionAvailableSnapshotV1>()
            .toEqualTypeOf<ExpectedMessageActionAvailableSnapshotV1>();
        expectTypeOf<PluginInvocationContext['messageAction']>()
            .toEqualTypeOf<ExpectedMessageActionAvailableSnapshotV1 | undefined>();
        expectTypeOf<PluginInvocationContext['operation']>()
            .toEqualTypeOf<Readonly<{
                update(progress: Readonly<{
                    label?: string;
                    phase?: string;
                    current?: number;
                    total?: number;
                }>): void;
            }> | undefined>();
        expectTypeOf<PublicMessageActionAvailableSnapshotV1>()
            .toEqualTypeOf<ExpectedMessageActionAvailableSnapshotV1>();
    });
});
