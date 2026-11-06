import type { AccountProviderDeclarationV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';
import type { ProviderContributionV1 } from '@happier-dev/protocol/providers/contributions';
import { resolveProviderBindingDeclarationCompatibilityV1 } from '@happier-dev/protocol/providers/binding-compatibility';

import type { AccountAgentProviderDeclaration } from './accountProviderDeclarations';

/** Descriptive declaration facts only; never a connection, executable grant or model entitlement. */
export type ProviderDeclarationDetail = Readonly<{
    auth?: Readonly<Pick<NonNullable<ProviderContributionV1['credential']>, 'kind' | 'required' | 'keyUrl'>>;
    connectedAccounts?: NonNullable<ProviderContributionV1['managedRuntime']>['connectedAccounts'];
    /** Positive fits only. An omitted Agent can be unknown until a model is listed, not necessarily incompatible. */
    worksWith: readonly Readonly<{
        agentTargetKey: string;
        name?: string;
        modelId?: string;
        compatibility: Exclude<ReturnType<typeof resolveProviderBindingDeclarationCompatibilityV1>['result'], { status: 'incompatible' }>;
    }>[];
    models: ProviderContributionV1['catalog'];
    source: Readonly<{
        contributionKey: string;
        provenance: AccountProviderDeclarationV1['provenance'];
        websiteUrl?: string;
    }>;
    nextStep?: Readonly<{ kind: 'apiKey' }>;
}>;

/** One projection of admitted Provider/Agent declarations; all fit decisions stay in Protocol's resolver. */
export function projectProviderDeclarationDetail(
    declaration: AccountProviderDeclarationV1,
    agents: readonly AccountAgentProviderDeclaration[],
): ProviderDeclarationDetail {
    const { definition } = declaration;
    const models = 'staticModels' in definition.catalog ? definition.catalog.staticModels : [undefined];
    return {
        ...(definition.credential ? { auth: { kind: definition.credential.kind, required: definition.credential.required,
            ...(definition.credential.keyUrl ? { keyUrl: definition.credential.keyUrl } : {}),
        } } : {}),
        ...(definition.managedRuntime?.connectedAccounts ? { connectedAccounts: definition.managedRuntime.connectedAccounts } : {}),
        worksWith: agents.flatMap(agent => {
            for (const model of models) {
                const { result } = resolveProviderBindingDeclarationCompatibilityV1({
                    agentTargetKey: agent.agentTargetKey, agent: agent.requirements,
                    endpoints: definition.endpointTemplates, credential: definition.credential,
                    compatibilityOverrides: definition.compatibilityOverrides, ...(model ? { model } : {}),
                });
                if (result.status !== 'incompatible') return [{ agentTargetKey: agent.agentTargetKey,
                    ...(agent.name ? { name: agent.name } : {}), ...(model ? { modelId: model.id } : {}), compatibility: result }];
            }
            return [];
        }),
        models: definition.catalog,
        // Definition.v is a schema revision. The admitted declaration carries no plugin package version.
        source: { contributionKey: declaration.contributionKey, provenance: declaration.provenance,
            ...(definition.websiteUrl ? { websiteUrl: definition.websiteUrl } : {}) },
        ...(definition.credential?.required ? { nextStep: { kind: 'apiKey' } } : {}),
    };
}
