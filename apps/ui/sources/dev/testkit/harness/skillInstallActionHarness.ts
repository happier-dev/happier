import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SkillsRulesSetInputV1Schema } from '@happier-dev/protocol/actions/specs/capabilityRules';
import type { PromptLibraryArtifactStore, PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { mutateSkillRulesV1, type SkillRulesActionPortV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import { createSkillActionExecuteV1, type SkillActionPortV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import type { SkillRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';

/** Real batch/held identity/rules owners over independently acknowledged persistent-store boundaries. */
export function createSkillInstallActionHarness(options: Pick<SkillActionPortV1, 'readFoundSkillBundle'> = {}) {
    const artifacts = new Map<string, PromptLibraryStoredArtifact>();
    let contentLimit: number | null = null, rulesUnavailable = false, revision = 0, nextId = 0;
    let rules: SkillRuleV1[] = [];
    const store: PromptLibraryArtifactStore = {
        list: async () => ({ coverage: 'complete', items: [...artifacts.values()].map(row => ({ id: row.id, header: row.header, updatedAtMs: 1, owned: true })) }),
        read: async id => artifacts.get(id) ?? null,
        create: async input => {
            if (contentLimit !== null && artifacts.size >= contentLimit) throw Object.assign(new Error('quota_exceeded'), { code: 'quota_exceeded' });
            const id = `skill-${++nextId}`;
            artifacts.set(id, { id, ...input, owned: true, revision: { headerVersion: 1, bodyVersion: 1 } });
            return { artifactId: id, revision: { headerVersion: 1, bodyVersion: 1 } };
        },
        update: async input => {
            const row = artifacts.get(input.artifactId);
            if (!row) throw new Error('not_found');
            const revision = { headerVersion: row.revision.headerVersion + 1, bodyVersion: row.revision.bodyVersion + 1 };
            artifacts.set(row.id, { ...row, header: input.header, body: input.body, revision });
            return { revision };
        },
    };
    const skillRules: SkillRulesActionPortV1 = {
        serverId: 'home', assertCurrent() {}, ruleWriteContext: () => ({ nowMs: 1, newId: () => `rule-${revision}` }),
        listSkills: async () => [...artifacts.values()].map(row => ({ id: row.id, name: String(row.header?.title ?? '') })),
        readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record: { key: 'skill-rules', value: { v: 1, rules } }, revision }], tombstones: [], diagnostics: [] } }),
        writeRecord: async input => {
            if (rulesUnavailable) throw new Error('catalog_unavailable');
            if (input.expectedRevision !== revision) return { status: 'conflict', revision };
            if (input.record.key !== 'skill-rules') throw new Error('Unexpected row');
            rules = input.record.value.rules;
            return { status: 'updated', revision: ++revision, cursor: revision };
        },
    };
    const owner = createSkillActionExecuteV1({ ...options, store, skillRules, randomId: () => `rule-${revision}`, nowMs: () => 1,
        includeInSession: async () => ({ ok: true, state: 'on', previous: 'inherit', applyTiming: { t: 'next_turn' } }) });
    const execute: MountedAuthoringActionExecute = async (actionId, input) => {
        if (actionId === 'skills.rules.set') return { ok: true, result: await mutateSkillRulesV1(skillRules, SkillsRulesSetInputV1Schema.parse(input)) };
        if (actionId !== 'skills.install' && actionId !== 'skills.found.adopt') throw new Error(`Unexpected Action ${actionId}`);
        const result = await owner(actionId, input, { surface: 'ui' });
        const failure = ActionExecuteFailureSchema.safeParse(result);
        return failure.success ? failure.data : { ok: true, result };
    };
    return { execute, artifacts, rules: () => rules,
        setContentUnavailableAfter: (count: number | null) => { contentLimit = count; },
        setRulesUnavailable: (unavailable: boolean) => { rulesUnavailable = unavailable; } };
}
