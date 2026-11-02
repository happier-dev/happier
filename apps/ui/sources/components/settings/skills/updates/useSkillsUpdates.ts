import * as React from 'react';
import { useRegistryUpdateCheck } from '@/registries/useRegistryUpdateCheck';
import {
  SKILL_ACTION_OUTPUT_SCHEMAS_V1,
  type SkillLibraryActionResultByIdV1,
} from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import type { SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { RegistryContentRefV1 } from '@happier-dev/protocol/registries';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';

import { readSkillActionRefusal } from '../detail/useSkillDetail';
import type { SkillFileChoice } from './skillsUpdatesModel';

export type SkillUpdateDiff =
  SkillLibraryActionResultByIdV1['skills.updates.diff'];
export type SkillUpdateDiffState =
  | Readonly<{ status: 'loading'; revision: string }>
  | Readonly<{ status: 'ready'; revision: string; diff: SkillUpdateDiff }>
  | Readonly<{ status: 'failed'; revision: string; code: string }>;
export type SkillUpdateApplyState =
  | Readonly<{ status: 'applying' }>
  | Readonly<{ status: 'applied'; ref: string | null }>
  | Readonly<{ status: 'failed'; code: string }>;

/**
 * The Updates page's operations, all through Actions: P4's one checker (`registries.updates.check`),
 * the R5 inputs (`skills.updates.diff`) and `skills.updates.apply`. "Checked at" lives in this screen's
 * state (P4: the checker returns it; nothing stores it), and every write refreshes the library.
 */
export function useSkillsUpdates(library: SkillsLibrary) {
  const { execute, ready, isCurrent } = useMountedActionExecution(library.scope);
  const { check, checkNow } = useRegistryUpdateCheck({
    scopeKey: JSON.stringify(library.scope), execute, isCurrent, kind: 'skill', retry: library.retry,
  });
  const [diffs, setDiffs] = React.useState<
    ReadonlyMap<string, SkillUpdateDiffState>
  >(new Map());
  const [applies, setApplies] = React.useState<
    ReadonlyMap<string, SkillUpdateApplyState>
  >(new Map());
  const { retry } = library;
  const libraryRef = React.useRef(library);
  libraryRef.current = library;
  const scopeKey = JSON.stringify(library.scope);
  const scopeRef = React.useRef(scopeKey);
  scopeRef.current = scopeKey;

  const loadDiff = React.useCallback(
    async (skillId: string) => {
      const revision = libraryRef.current.items.find(item => item.skillId === skillId)?.revision;
      if (!revision || !isCurrent()) return;
      const current = () => isCurrent() && scopeRef.current === scopeKey
        && libraryRef.current.items.some(item => item.skillId === skillId && item.revision === revision);
      setDiffs((previous) =>
        new Map(previous).set(skillId, { status: 'loading', revision }),
      );
      try {
        const result = await execute('skills.updates.diff', { skillId });
        const refusal = readSkillActionRefusal(result);
        const parsed = refusal
          ? null
          : SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.diff'].safeParse(
              result.ok ? result.result : null,
            );
        if (!current()) return;
        setDiffs((previous) =>
          new Map(previous).set(
            skillId,
            parsed?.success
              ? { status: 'ready', revision, diff: parsed.data }
              : { status: 'failed', revision, code: refusal ?? 'invalid_action_output' },
          ),
        );
      } catch (error) {
        if (!current()) return;
        setDiffs((previous) =>
          new Map(previous).set(skillId, {
            status: 'failed',
            revision,
            code: error instanceof Error ? error.message : 'unknown',
          }),
        );
      }
    },
    [execute, isCurrent, scopeKey],
  );

  // Retire the review when the library changes, including a checker's upstream observation.
  // Only already-open reviews reload; this does not fetch a diff for every library item.
  React.useEffect(() => {
    for (const item of library.items) {
      const review = diffs.get(item.skillId);
      if (review && review.revision !== item.revision) void loadDiff(item.skillId);
    }
    setDiffs(previous => {
      const retained = new Map([...previous].filter(([id]) => library.items.some(item => item.skillId === id)));
      return retained.size === previous.size ? previous : retained;
    });
  }, [library.items, diffs, loadDiff]);
  React.useLayoutEffect(() => { setDiffs(new Map()); setApplies(new Map()); }, [scopeKey]);

  const apply = React.useCallback(
    async (
      item: SkillListItemV1,
      choices?: Readonly<Record<string, SkillFileChoice>>,
      reviewedRevision?: string,
    ) => {
      if (!isCurrent()) return;
      const review = diffs.get(item.skillId);
      const expectedRevision = reviewedRevision ?? (choices && review?.status === 'ready' ? review.revision : undefined);
      // Choices can only authorize the version whose sides were reviewed.
      if (choices && !expectedRevision) {
        setApplies(previous => new Map(previous).set(item.skillId, { status: 'failed', code: 'revision_conflict' }));
        return;
      }
      setApplies((previous) =>
        new Map(previous).set(item.skillId, { status: 'applying' }),
      );
      try {
        const result = await execute('skills.updates.apply', {
          skillId: item.skillId,
          expectedRevision: expectedRevision ?? item.revision,
          ...(choices ? { choices } : {}),
        });
        const refusal = readSkillActionRefusal(result);
        const parsed = refusal
          ? null
          : SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.apply'].safeParse(
              result.ok ? result.result : null,
            );
        if (!isCurrent() || scopeRef.current !== scopeKey) return;
        setApplies((previous) =>
          new Map(previous).set(
            item.skillId,
            parsed?.success
              ? {
                  status: 'applied',
                  ref: provenanceRefLabel(parsed.data.provenance),
                }
              : { status: 'failed', code: refusal ?? 'invalid_action_output' },
          ),
        );
        if (parsed?.success || refusal === 'revision_conflict') retry();
      } catch (error) {
        if (!isCurrent() || scopeRef.current !== scopeKey) return;
        setApplies((previous) =>
          new Map(previous).set(item.skillId, {
            status: 'failed',
            code: error instanceof Error ? error.message : 'unknown',
          }),
        );
      }
    },
    [execute, retry, diffs, isCurrent, scopeKey],
  );

  return { ready, check, checkNow, diffs, loadDiff, applies, apply };
}

export type SkillsUpdatesController = ReturnType<typeof useSkillsUpdates>;

/** A source revision as people read it: a short commit, digest, or published version. */
export function contentRefLabel(
  ref: RegistryContentRefV1 | undefined | null,
): string | null {
  if (!ref) return null;
  return ref.kind === 'gitTree' ? ref.commit.slice(0, 7)
    : ref.kind === 'version' ? ref.version : `${ref.digest.slice(0, 19)}…`;
}

/** The revision a skill's library copy came from. */
export function provenanceRefLabel(
  provenance: SkillListItemV1['provenance'],
): string | null {
  if (provenance.kind === 'registry')
    return contentRefLabel(provenance.registry.ref);
  if (provenance.kind === 'link') return contentRefLabel(provenance.ref);
  if (provenance.kind === 'wellKnown') return contentRefLabel(provenance);
  return null;
}
