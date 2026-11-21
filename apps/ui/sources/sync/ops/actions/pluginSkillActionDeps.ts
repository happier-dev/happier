import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1, type SkillLibraryActionInputByIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { SkillReadResultV1Schema, type SkillReadInputV1 } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { pluginSkillIdV1, type SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { ReadOnlySkillV1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { readAvailablePluginSkillItemsV1, readSkillLibraryCatalog } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { readPluginUiContributionSupplies } from '@/sync/domains/plugins/ui/projectionUnion';
import { randomUUID } from '@/platform/randomUUID';
import type { LazyActionAccountContext } from './actionAccountContext';
import { resolveUiAccountActionFallbackMachineId } from './accountActionDeps';

function sources(account: LazyActionAccountContext) {
    const projection = readCurrentAppShellPluginUiProjection({ scope: account, declarationsOnly: true });
    return Object.values(projection?.skillsById ?? {}).map(entry => ({
        entry, skillId: pluginSkillIdV1({ pluginId: entry.pluginId, localId: entry.definition.id }),
        supplies: readPluginUiContributionSupplies(entry),
    }));
}
type Source = ReturnType<typeof sources>[number];
const unavailable = (code: string): never => {
    throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code });
};

async function execute(account: LazyActionAccountContext, context: ActionExecutorContext, actionId: ActionId, input: unknown) {
    const { executeOriginalAccountMachineAction } = await import('@/sync/api/externalActionAccountTransport');
    account.assertCurrent(); context.signal?.throwIfAborted();
    // The carrier executes the Account Action; the Account owner may read a different supplier.
    const machineId = resolveUiAccountActionFallbackMachineId(account, { target: context.externalActionTarget });
    if (!machineId) return unavailable('needs_machine');
    const result = await executeOriginalAccountMachineAction({ account, machineId, actionId, input,
        requestId: context.actionRequestId ?? randomUUID(), authority: context.authority,
        actionCaller: context.actionCaller, signal: context.signal }).catch((error: unknown) => {
        account.assertCurrent(); context.signal?.throwIfAborted();
        if (actionId === 'skills.list') return unavailable('skill_content_unavailable');
        throw error;
    });
    account.assertCurrent(); context.signal?.throwIfAborted();
    if (!result?.ok) {
        if (result && actionId !== 'skills.list') throw createActionExecuteFailureError(result);
        return unavailable('skill_content_unavailable');
    }
    return result.result;
}

function owns(source: Source, item: Pick<SkillListItemV1, 'skillId' | 'provenance'>): boolean {
    if (item.skillId !== source.skillId || item.provenance.kind !== 'plugin' || item.provenance.pluginId !== source.entry.pluginId) return false;
    const provenance = item.provenance;
    return source.supplies.some(candidate => candidate.occurrenceId === null || candidate.occurrenceId === provenance.occurrenceId);
}

/** The Account Action owns fleet selection; UI receives one metadata page without eagerly reading bytes. */
export async function readUiPluginSkillItemsV1(account: LazyActionAccountContext, context: ActionExecutorContext,
    input: SkillLibraryActionInputByIdV1['skills.list'] = {}, skillIds?: readonly string[]): Promise<readonly SkillListItemV1[]> {
    const selectedIds = skillIds ?? input.skillIds;
    const expected = sources(account).filter(source => !selectedIds || selectedIds.includes(source.skillId));
    if (!expected.length) return [];
    const received = await readAvailablePluginSkillItemsV1(async () => SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await execute(account, context,
        'skills.list', selectedIds ? { ...input, skillIds: [...selectedIds] } : input)).items, context.signal);
    account.assertCurrent(); context.signal?.throwIfAborted();
    const current = new Map(sources(account).map(source => [source.skillId, source]));
    const expectedIds = new Set(expected.map(source => source.skillId));
    return received.filter(item => {
        const source = current.get(item.skillId);
        return expectedIds.has(item.skillId) && source !== undefined && owns(source, item);
    });
}

export async function readUiPluginSkillV1(account: LazyActionAccountContext, request: SkillReadInputV1, context: ActionExecutorContext) {
    if (!('skillId' in request)) return unavailable('not_found');
    const source = sources(account).find(source => source.skillId === request.skillId);
    if (!source) return unavailable('not_found');
    const result = SkillReadResultV1Schema.parse(await execute(account, context, 'skills.read', request));
    const current = sources(account).find(source => source.skillId === result.skillId);
    if (!sources(account).some(source => source.skillId === request.skillId)) return unavailable('not_found');
    if (result.skillId !== request.skillId || !current || !owns(current, result)) return unavailable('skill_content_unavailable');
    return result;
}

/** Read one addressed bundle, then let the local shared Action owner preserve copy/reach custody. */
export async function readUiPluginSkillBundleV1(account: LazyActionAccountContext, skillId: string, context: ActionExecutorContext): Promise<ReadOnlySkillV1> {
    const read = await readUiPluginSkillV1(account, { skillId, includeFileContents: true }, context);
    if (!read.fileContents || read.provenance.kind !== 'plugin') return unavailable('skill_content_unavailable');
    return { skillId, files: read.fileContents, provenance: read.provenance };
}

/** Rules, Session selection and Profiles resolve the same metadata as the Skills library. */
export async function readUiSkillLibraryCatalogV1(account: LazyActionAccountContext, signal?: AbortSignal,
    skillIds?: readonly string[], context: ActionExecutorContext = {}) {
    const [library, pluginItems] = await Promise.all([
        readSkillLibraryCatalog({ list: options => account.listArtifacts(options), read: (id, options) => account.readArtifactContent(id, options) }, signal, skillIds),
        readUiPluginSkillItemsV1(account, { ...context, signal }, {}, skillIds),
    ]);
    account.assertCurrent(); signal?.throwIfAborted();
    return [...library, ...pluginItems.map(item => ({ id: item.skillId, name: item.name }))];
}
