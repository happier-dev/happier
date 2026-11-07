import * as React from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { readSkillFrontmatterV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { reachRulesToDraftsV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useDraftReachRules } from '@/components/capabilities/where/WhereItsOnControl';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { lintSkillMarkdown } from '../detail/SkillInstructionsSection';
import { SKILL_DRAFT_TEMPLATE } from '../detail/skillDraftTemplate';
import { skillTextFile } from '../detail/skillFileContent';
import { acknowledgeSkillCreation, describeSkillInstallIncomplete, retrySkillInstallRules, type SkillCreationAcknowledgment } from './skillInstall';

type SkillDraftState = {
  text: string; dirty: boolean; busy: boolean; receipt: SkillCreationAcknowledgment | null;
  error: string | null; where?: ReachRulesChangeV1;
};

export type SkillDraft = Readonly<{
  store: StoreApi<SkillDraftState>;
  current: boolean;
  isCurrent: () => boolean;
  resolving: boolean;
  reach: ReturnType<typeof useDraftReachRules>;
  changeText: (text: string) => void;
  create: () => Promise<string | null>;
  reset: () => void;
}>;

/** Explicit creation and receipt custody shared by Write and the existing new-skill route. */
export function useSkillDraft(): SkillDraft {
  const scope = useAccountSettingsScope();
  const { binding, resolution } = useServerCredentialAccountScopeBinding(scope?.serverId);
  const captured = React.useRef<ServerCredentialAccountScopeBinding | null>(null);
  if (!captured.current && binding) captured.current = binding;
  const execution = useMountedActionExecution(captured.current?.scope ?? null);
  const [store] = React.useState(() => createStore<SkillDraftState>(() => ({ text: SKILL_DRAFT_TEMPLATE, dirty: false, busy: false, receipt: null, error: null })));
  const reach = useDraftReachRules('skill');
  const [initialRules] = React.useState(() => reachRulesToDraftsV1(reach.rules));
  const liveReach = React.useRef(reach);
  liveReach.current = reach;
  const liveScope = React.useRef(scope);
  liveScope.current = scope;
  const isCurrent = React.useCallback(() => captured.current?.isCurrent() === true
    && areServerAccountScopesEqual(captured.current.scope, liveScope.current) && execution.isCurrent(), [execution.isCurrent]);
  const current = isCurrent();
  const changeText = React.useCallback((text: string) => {
    if (!isCurrent()) return;
    store.setState(state => state.busy || state.receipt || state.text === text ? state : {
      ...state, text, error: null, dirty: text !== SKILL_DRAFT_TEMPLATE
        || !sameStrictJsonValue(reachRulesToDraftsV1(liveReach.current.rules), initialRules),
    });
  }, [initialRules, isCurrent, store]);
  const changeReach = React.useCallback<typeof reach.onChange>(async change => {
    if (!isCurrent() || store.getState().busy || store.getState().receipt) return { ok: false, message: t('common.unavailable') };
    const result = await liveReach.current.onChange(change);
    if (result.ok) store.setState(state => ({ ...state, where: change,
      dirty: state.text !== SKILL_DRAFT_TEMPLATE || !sameStrictJsonValue(change.rules, initialRules) }));
    return result;
  }, [initialRules, isCurrent, store]);
  const create = React.useCallback(async (): Promise<string | null> => {
    const state = store.getState();
    if (!isCurrent() || state.busy) return null;
    const frontmatter = readSkillFrontmatterV1(state.text);
    if (!state.receipt && (!lintSkillMarkdown(state.text).ok || !frontmatter.name)) return null;
    store.setState({ busy: true, error: null });
    try {
      let receipt = state.receipt;
      if (receipt) {
        if (receipt.incomplete.length > 0) receipt = await retrySkillInstallRules(execution.execute, receipt, state.where);
      } else {
        const result = await execution.execute('skills.create', {
          name: frontmatter.name!, ...(frontmatter.description ? { description: frontmatter.description } : {}),
          files: [skillTextFile('SKILL.md', state.text)], ...(state.where ? { where: state.where } : {}),
        });
        if (!result.ok) throw new Error(t('capabilities.skillDetail.draft.addFailed'));
        receipt = acknowledgeSkillCreation(SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(result.result));
      }
      store.setState({ receipt, dirty: false });
      if (receipt.incomplete.length > 0) {
        store.setState({ error: describeSkillInstallIncomplete(receipt) });
        return null;
      }
      return isCurrent() ? receipt.skillIds[0]! : null;
    } catch {
      if (isCurrent()) store.setState({ error: t('capabilities.skillDetail.draft.addFailed') });
      return null;
    } finally { store.setState({ busy: false }); }
  }, [execution.execute, isCurrent, store]);
  const reset = React.useCallback(() => {
    if (store.getState().busy || store.getState().receipt) return;
    void liveReach.current.onChange({ kind: 'replace', rules: initialRules });
    store.setState({ text: SKILL_DRAFT_TEMPLATE, dirty: false, error: null, where: undefined });
  }, [initialRules, store]);
  return { store, current, isCurrent, resolving: captured.current === null && resolution.kind === 'resolving',
    reach: { ...reach, onChange: changeReach }, changeText, create, reset };
}

