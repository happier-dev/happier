import { BUILT_IN_INSTALLABLE_CONTRIBUTIONS } from '@happier-dev/protocol/installables';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';
import { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } from '../sources/generatedBundledPlugins';
import { projectBuiltInAgents } from './agents';
import type { ResolvedContributionInputs, ResolvedInstallableContribution } from '../types';
const EMPTY_CONTRIBUTIONS = Object.freeze([]);
export type ResolvedBuiltInContributionInputs = ResolvedContributionInputs & Required<
    Pick<ResolvedContributionInputs, 'agents' | 'providers'>
>;

export function projectBuiltInContributionInputs(projected: ResolvedContributionInputs,
  params?: Readonly<{ providerContributionKeys?: readonly string[]; agentIdentity?: PluginContributionIdentityV1 }>,
): ResolvedBuiltInContributionInputs {
    const agents = params?.providerContributionKeys ? EMPTY_CONTRIBUTIONS : projectBuiltInAgents({
        manifestAgents: projected.agents ?? EMPTY_CONTRIBUTIONS,
        registrationBindings: BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS,
    });

    return Object.freeze({
        ...projected,
        agents,
        providers: projected.providers ?? EMPTY_CONTRIBUTIONS,
        catalogEntries: EMPTY_CONTRIBUTIONS,
        managedDependencies: params?.providerContributionKeys || params?.agentIdentity ? EMPTY_CONTRIBUTIONS : Object.freeze([
            ...BUILT_IN_INSTALLABLE_CONTRIBUTIONS.map(({ descriptor, owner }) => ({
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId: owner.ownerId,
                definition: descriptor,
            } satisfies ResolvedInstallableContribution)),
            ...(projected.managedDependencies ?? EMPTY_CONTRIBUTIONS),
        ]),
    });
}
