function normalizeChangeType(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return 'committed';
  if (t === 'committed' || t === 'uncommitted' || t === 'all') return t;
  // Be defensive: unknown values shouldn't crash prompt building.
  return 'committed';
}

function codexScopePathForComponent(component) {
  switch (component) {
    case 'happier-ui':
      return 'apps/ui';
    case 'happier-cli':
      return 'apps/cli';
    case 'happier-server-light':
    case 'happier-server':
      return 'apps/server';
    default:
      return null;
  }
}

function normalizeScopePaths(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const cleaned = arr
    .map((p) => String(p ?? '').trim().replace(/\/+$/g, ''))
    .filter(Boolean);
  return Array.from(new Set(cleaned));
}

function buildPromptBaseLines({ title, baseRef, changeType, scopePath, deep, customPrompt }) {
  const ct = normalizeChangeType(changeType);
  const committedCmd = scopePath
    ? `git diff ${baseRef}...HEAD -- ${scopePath}/`
    : `git diff ${baseRef}...HEAD`;
  const uncommittedCmd = scopePath
    ? `git diff HEAD -- ${scopePath}/`
    : `git diff HEAD`;
  const cmds = ct === 'committed' ? [committedCmd] : ct === 'uncommitted' ? [uncommittedCmd] : [committedCmd, uncommittedCmd];

  const focusLines = deep
    ? [
      '- Focus on correctness, edge cases, reliability, performance, and security.',
      '- Prefer unified/coherent fixes; avoid duplication.',
      '- Avoid brittle tests that assert on wording/phrasing/config; test real behavior and observable outcomes.',
      '- Ensure i18n coverage is complete: do not introduce hardcoded user-visible strings; add translation keys across locales as needed.',
      '- Be exhaustive: list all findings you notice, not only the highest-signal ones.',
    ]
    : [
      '- Focus on correctness, edge cases, reliability, performance, and security.',
      '- Prefer unified/coherent fixes; avoid duplication.',
      '- Avoid low-signal nits and docs-only wording feedback unless it affects correctness, safety, or long-term maintainability.',
      '- Limit to the highest-signal items (aim for <= 15 findings).',
    ];

  const extra = String(customPrompt ?? '').trim();
  const customLines = extra
    ? [
      'Custom focus:',
      extra,
      '',
    ]
    : [];

  return [
    title,
    '',
    `Change type: ${ct}`,
    ct === 'uncommitted' ? 'Base for review: (uncommitted-only)' : `Base for review: ${baseRef}`,
    scopePath ? `Scope: ${scopePath}/` : 'Scope: full repo',
    '',
    'Instructions:',
    ...cmds.map((c) => `- Use: ${c}`),
    ct !== 'committed'
      ? '- Include untracked files (if any): git status --porcelain=v1'
      : null,
    ...customLines,
    ...focusLines,
    '- Do not wait for other agents/reviewers and do not attempt to coordinate with them. Produce your own review output immediately.',
    "- Treat every recommendation as a suggestion: validate it against best practices and this codebase's existing patterns. Do not propose changes that violate project invariants.",
    '- Clearly mark any item that is uncertain, has tradeoffs, or needs product/UX decisions as "needs discussion".',
    '',
    'Output format:',
    '- Start with a short overall verdict.',
    '- Then list findings as bullets with severity (blocker/major/minor/nit) and a concrete fix suggestion.',
    '',
    'Machine-readable output (required):',
    '- After your review, output a JSON array of findings preceded by a line containing exactly: ===FINDINGS_JSON===',
    '- Each finding should include: severity, file, (optional) lines, title, description, recommendation, needsDiscussion (boolean).',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildAuditPromptBaseLines({ title, scopePaths, deep, customPrompt }) {
  const paths = normalizeScopePaths(scopePaths);
  const scopeLine = paths.length ? `Scope paths: ${paths.join(', ')}` : 'Scope paths: (not specified)';
  const focusLines = deep
    ? [
      '- Focus on correctness, edge cases, reliability, performance, and security.',
      '- Prefer unified/coherent fixes; avoid duplication.',
      '- Avoid brittle tests that assert on wording/phrasing/config; test real behavior and observable outcomes.',
      '- Be exhaustive: list all findings you notice, not only the highest-signal ones.',
    ]
    : [
      '- Focus on correctness, edge cases, reliability, performance, and security.',
      '- Prefer unified/coherent fixes; avoid duplication.',
      '- Avoid low-signal nits and docs-only wording feedback unless it affects correctness, safety, or long-term maintainability.',
      '- Limit to the highest-signal items (aim for <= 15 findings).',
    ];

  const extra = String(customPrompt ?? '').trim();
  const customLines = extra
    ? [
      'Custom focus:',
      extra,
      '',
    ]
    : [];

  return [
    title,
    '',
    'Mode: audit (no diff).',
    scopeLine,
    '',
    'Instructions:',
    '- Inspect the current repository state directly (not a diff).',
    '- Prefer starting from the scope paths above; follow cross-references as needed, but keep findings grounded in concrete code.',
    ...customLines,
    ...focusLines,
    '- Do not wait for other agents/reviewers and do not attempt to coordinate with them. Produce your own review output immediately.',
    "- Treat every recommendation as a suggestion: validate it against best practices and this codebase's existing patterns. Do not propose changes that violate project invariants.",
    '- Clearly mark any item that is uncertain, has tradeoffs, or needs product/UX decisions as "needs discussion".',
    '',
    'Output format:',
    '- Start with a short overall verdict.',
    '- Then list findings as bullets with severity (blocker/major/minor/nit) and a concrete fix suggestion.',
    '',
    'Machine-readable output (required):',
    '- After your review, output a JSON array of findings preceded by a line containing exactly: ===FINDINGS_JSON===',
    '- Each finding should include: severity, file, (optional) lines, title, description, recommendation, needsDiscussion (boolean).',
  ].join('\n');
}

export function buildCodexDeepPrompt({ component, baseRef, changeType, customPrompt }) {
  const scopePath = codexScopePathForComponent(component);
  return buildPromptBaseLines({
    title: 'Run a deep, long-form code review.',
    baseRef,
    changeType,
    scopePath,
    deep: true,
    customPrompt,
  });
}

export function buildCodexNormalPrompt({ component, baseRef, changeType, customPrompt }) {
  const scopePath = codexScopePathForComponent(component);
  return buildPromptBaseLines({
    title: 'Run a focused code review.',
    baseRef,
    changeType,
    scopePath,
    deep: false,
    customPrompt,
  });
}

export function buildCodexMonorepoDeepPrompt({ baseRef, changeType, customPrompt }) {
  return buildPromptBaseLines({
    title: 'Run a deep, long-form code review on the monorepo.',
    baseRef,
    changeType,
    scopePath: null,
    deep: true,
    customPrompt,
  });
}

export function buildCodexMonorepoNormalPrompt({ baseRef, changeType, customPrompt }) {
  return buildPromptBaseLines({
    title: 'Run a focused code review on the monorepo.',
    baseRef,
    changeType,
    scopePath: null,
    deep: false,
    customPrompt,
  });
}

export function buildCodexAuditPrompt({ component, deep = true, scopePaths = [], customPrompt }) {
  const scopePath = codexScopePathForComponent(component);
  const paths = normalizeScopePaths(scopePaths);
  // If no explicit paths are provided, fall back to the component scope path for signal.
  const effective = paths.length ? paths : scopePath ? [scopePath] : [];
  return buildAuditPromptBaseLines({
    title: deep ? 'Run a deep, long-form repository audit.' : 'Run a focused repository audit.',
    scopePaths: effective,
    deep: Boolean(deep),
    customPrompt,
  });
}

export function buildCodexMonorepoAuditPrompt({ deep = true, scopePaths = [], customPrompt }) {
  return buildAuditPromptBaseLines({
    title: deep ? 'Run a deep, long-form repository audit on the monorepo.' : 'Run a focused repository audit on the monorepo.',
    scopePaths,
    deep: Boolean(deep),
    customPrompt,
  });
}

export function buildCodexMonorepoSlicePrompt({ sliceLabel, baseCommit, baseRef, deep = true, customPrompt }) {
  const diffCmd = `git -C \"$(git rev-parse --show-toplevel)\" diff ${baseCommit}...HEAD`;
  const focusLines = deep
    ? [
      '- Focus on correctness, edge cases, reliability, performance, and security.',
      '- Prefer unified/coherent fixes; avoid duplication.',
      '- Avoid brittle tests that assert on wording/phrasing/config; test real behavior and observable outcomes.',
      '- Ensure i18n coverage is complete: do not introduce hardcoded user-visible strings; add translation keys across locales as needed.',
      '- Be exhaustive within this slice: list all findings you notice, not only the highest-signal ones.',
    ]
    : [
      '- Focus on correctness, edge cases, reliability, performance, and security.',
      '- Prefer unified/coherent fixes; avoid duplication.',
      '- Avoid low-signal nits and docs-only wording feedback unless it affects correctness, safety, or long-term maintainability.',
      '- Limit to the highest-signal items (aim for <= 15 findings).',
    ];

  const extra = String(customPrompt ?? '').trim();
  const customLines = extra
    ? [
      '',
      'Custom focus:',
      extra,
    ]
    : [];

  return [
    deep ? 'Run a deep, long-form code review on the monorepo.' : 'Run a focused code review on the monorepo.',
    '',
    `Base ref: ${baseRef}`,
    `Slice: ${sliceLabel}`,
    '',
    'Important:',
    '- The base commit for this slice is synthetic: it represents upstream plus all NON-slice changes.',
    '- Therefore, the diff below contains ONLY the changes for this slice, but the checked-out code is the full final HEAD.',
    '',
    'Instructions:',
    `- Use: ${diffCmd}`,
    '- You may inspect any file in the repo for cross-references (server/cli/ui), but keep findings scoped to this slice diff.',
    ...customLines,
    ...focusLines,
    '- Do not wait for other agents/reviewers and do not attempt to coordinate with them. Produce your own review output immediately.',
    "- Treat every recommendation as a suggestion: validate it against best practices and this codebase's existing patterns. Do not propose changes that violate project invariants.",
    '- Clearly mark any item that is uncertain, has tradeoffs, or needs product/UX decisions as "needs discussion".',
    '',
    'Output format:',
    '- Start with a short overall verdict.',
    '- Then list findings as bullets with severity (blocker/major/minor/nit) and a concrete fix suggestion.',
    '',
    'Machine-readable output (required):',
    '- After your review, output a JSON array of findings preceded by a line containing exactly: ===FINDINGS_JSON===',
    '- Each finding should include: severity, file, (optional) lines, title, description, recommendation, needsDiscussion (boolean).',
  ].join('\n');
}

export function buildUncommittedSlicePrompt({ sliceLabel, basePrompt }) {
  return [
    `Slice: ${sliceLabel}`,
    '- The worktree is pre-scoped for this slice only.',
    '- Files outside this slice may be intentionally absent in this temporary worktree.',
    '- Do not file "missing file/module" findings unless the missing path is part of this slice diff.',
    '- Review only the uncommitted changes currently present in this worktree.',
    '',
    basePrompt,
  ].join('\n');
}
