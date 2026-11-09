import { createSkillActionExecuteV1, type SkillActionPortV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import type { PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { SkillRulesActionPortV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { randomUUID } from '@/platform/randomUUID';
import { createUiRegistryHostV1 } from '@/registries/registryHostDeps';
import type { LazyActionAccountContext } from './actionAccountContext';
import { SKILL_ACTION_INPUT_SCHEMAS_V1, SKILL_ACTION_OUTPUT_SCHEMAS_V1, SkillInstallAcknowledgedEffectsV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { isPluginSkillIdV1, readSkillLockV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { readUiPluginSkillBundleV1, readUiPluginSkillItemsV1 } from './pluginSkillActionDeps';
import { artifactSavedByFromActionContextV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';

/** Projection never rewrites a received content ACK as a failed mutation. */
export async function refreshUiSkillActionAcknowledgements(account: LazyActionAccountContext, skillIds: readonly string[]) {
    if (!skillIds.length) return;
    await Promise.all([...new Set(skillIds)].map(async skillId => {
        try { await account.fetchArtifact(skillId); }
        catch { /* The captured Account may have retired after the ACK. */ }
    }));
    try {
        const { refreshPromptLibraryCatalog } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
        await refreshPromptLibraryCatalog({ serverId: account.serverId, accountId: account.accountId });
    } catch { /* The incumbent loader can retry; the content receipt stays true. */ }
}

/** Skill domain behavior stays in protocol; UI supplies the captured Artifact and row transports. */
export function createUiSkillActionExecuteV1(account: LazyActionAccountContext, store: PromptLibraryArtifactStore,
    skillRules: SkillRulesActionPortV1,
    includeInSession: Parameters<typeof createSkillActionExecuteV1>[0]['includeInSession'],
    readFoundSkillBundle: NonNullable<Parameters<typeof createSkillActionExecuteV1>[0]['readFoundSkillBundle']>): NonNullable<ActionExecutorDeps['skillActionExecute']> {
    return async ({ actionId, input, context }) => {
        if (!store.organization) throw new Error('skill_catalog_unavailable');
        const registry = await createUiRegistryHostV1(account, store.organization, context);
        let privateSourceId: string | undefined;
        if (actionId === 'skills.updates.diff' || actionId === 'skills.updates.apply') {
            const inputValue = SKILL_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
            if (!inputValue.candidate) {
                const artifact = await store.read(inputValue.skillId, { signal: context.signal });
                const provenance = artifact ? readSkillLockV1(artifact.header).provenance : undefined;
                if (provenance?.kind === 'registry') privateSourceId = provenance.registry.sourceId;
            }
        }
        const privateSource = privateSourceId ? await registry.readRegistrySource(privateSourceId) : undefined;
        if (privateSourceId && privateSource && 'token' in privateSource && privateSource.token) {
            // Keep pinned file reads and their mutation in the existing Node
            // Action, under this requester's captured private Account custody.
            const result = await registry.executeActionForSource(privateSourceId, actionId, input);
            if (!result.ok) {
                const effects = SkillInstallAcknowledgedEffectsV1Schema.safeParse(result.details);
                if (effects.success) await refreshUiSkillActionAcknowledgements(account, effects.data.skillIds);
                return result;
            }
            const output = SKILL_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(result.result);
            if (actionId === 'skills.updates.diff') {
                account.assertCurrent(); context.signal?.throwIfAborted();
            }
            if (actionId === 'skills.updates.apply') await refreshUiSkillActionAcknowledgements(account, [SKILL_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input).skillId]);
            return output;
        }
        const addressed = input && typeof input === 'object' && 'skillId' in input && typeof input.skillId === 'string'
            && isPluginSkillIdV1(input.skillId) ? input.skillId : null;
        // Finite reads borrow the catalog loader's admitted publication. Only
        // mutations need the fresh rule base supplied by the write port.
        const catalogRules = getActionSpec(actionId).sideEffectClass === 'read'
            ? { ...skillRules, readCatalog: store.organization.readCatalog }
            : skillRules;
        const output = await createSkillActionExecuteV1({ store, skillRules: catalogRules, includeInSession, readFoundSkillBundle,
            savedBy: artifactSavedByFromActionContextV1(context),
            readPluginSkills: async (signal, skillIds) => Promise.all([...new Set(skillIds ?? [])].filter(isPluginSkillIdV1)
                .map(skillId => readUiPluginSkillBundleV1(account, skillId, { ...context, signal: signal ?? context.signal }))),
            readRegistryItem: registry.readRegistryItem, readRegistrySource: registry.readRegistrySource,
            ...(context.surface !== 'agent' ? { executeRegistryInstall: async (request: Parameters<NonNullable<SkillActionPortV1['executeRegistryInstall']>>[0]) => {
                const result = await registry.executeActionForSource(request.source.sourceId, 'skills.install', request);
                if (!result.ok) {
                    const effects = SkillInstallAcknowledgedEffectsV1Schema.safeParse(result.details);
                    if (effects.success) await refreshUiSkillActionAcknowledgements(account, effects.data.skillIds);
                } else {
                    const installed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(result.result);
                    if ('skillIds' in installed) await refreshUiSkillActionAcknowledgements(account, installed.skillIds);
                    else { account.assertCurrent(); context.signal?.throwIfAborted(); }
                }
                return result;
            } } : {}),
            fetchRegistrySkillFiles: registry.filesForPointer,
            readLinkSkills: registry.readLinkSkills, fetchLinkSkillFiles: registry.fetchLinkSkillFiles,
            randomId: randomUUID,
        })(actionId, input, { surface: context.surface ?? null,
            invocationServices: context.invocationServices,
            ...(context.approvedActionReplay ? { approvedActionReplay: context.approvedActionReplay } : {}),
            ...(context.defaultSessionId ? { sessionId: context.defaultSessionId } : {}) }, context.signal);
        if (actionId === 'skills.list') {
            const local = SKILL_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(output);
            if (!local.success) return output;
            const pluginItems = await readUiPluginSkillItemsV1(account, context, SKILL_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input));
            return { ...local.data, items: [...local.data.items, ...pluginItems],
                revision: JSON.stringify([local.data.revision, pluginItems.map(item => [item.skillId, item.revision])]) };
        }
        if (actionId === 'skills.duplicate' && addressed) {
            const copied = SKILL_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(output);
            if (copied.success) await refreshUiSkillActionAcknowledgements(account, [copied.data.skillId]);
        }
        if (actionId === 'skills.found.read') { account.assertCurrent(); context.signal?.throwIfAborted(); }
        if (actionId === 'skills.found.adopt') {
            const parsed = SKILL_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(output);
            if (parsed.success) await refreshUiSkillActionAcknowledgements(account, parsed.data.skillIds);
            else if (output && typeof output === 'object' && 'details' in output) {
                const effects = SkillInstallAcknowledgedEffectsV1Schema.safeParse(output.details);
                if (effects.success) await refreshUiSkillActionAcknowledgements(account, effects.data.skillIds);
            }
        }
        return output;
    };
}
