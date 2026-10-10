/** Portable display slots: Protocol owns Happier's executable worker and role kinds. */
export type HappierWorkKind = 'session' | 'execution_run' | 'workflow_run';
export type HappierRoleRunsAsKind = 'session' | 'background_run';

export const HAPPIER_WORK_KIND_GLYPHS = {
  session: 'sparkle', execution_run: 'play-circle', workflow_run: 'stack-simple',
} as const;

export function resolveHappierWorkKindPresentation(kind: HappierWorkKind, labels?: Readonly<Record<HappierWorkKind, string>>) {
  const defaults = { session: 'Session', execution_run: 'Background run', workflow_run: 'Workflow run' };
  return { glyph: HAPPIER_WORK_KIND_GLYPHS[kind], label: labels?.[kind] ?? defaults[kind] };
}

export function resolveHappierRoleRunsAsPresentation(kind: HappierRoleRunsAsKind, labels?: Readonly<Record<HappierRoleRunsAsKind, string>>) {
  const work = resolveHappierWorkKindPresentation(kind === 'session' ? 'session' : 'execution_run');
  return { glyph: work.glyph, label: labels?.[kind] ?? work.label };
}

const ROLE_GLYPHS = {
  orchestrator: 'tree-structure', planner: 'list-checks', builder: 'hammer', reviewer: 'eye',
  judge: 'scales', second_opinion: 'chats-circle', scout: 'binoculars', approval_reviewer: 'shield-check',
} as const;

export function resolveHappierRoleGlyph(roleId: string | undefined, runsAs: HappierRoleRunsAsKind) {
  return roleId && Object.hasOwn(ROLE_GLYPHS, roleId)
    ? ROLE_GLYPHS[roleId as keyof typeof ROLE_GLYPHS]
    : resolveHappierRoleRunsAsPresentation(runsAs).glyph;
}
