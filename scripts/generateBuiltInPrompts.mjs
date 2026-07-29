import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');

export function resolveBuiltInPromptsPaths(root = repoRoot) {
  return Object.freeze({
    diagnoseSkillPath: path.join(root, 'skills', 'happier-diagnose', 'SKILL.md'),
    diagnoseRuntimeEvidencePath: path.join(
      root,
      'skills',
      'happier-diagnose',
      'references',
      'runtime-evidence.md',
    ),
    diagnoseReportingPath: path.join(
      root,
      'skills',
      'happier-diagnose',
      'references',
      'reporting.md',
    ),
    outputPath: path.join(
      root,
      'apps',
      'ui',
      'sources',
      'sync',
      'domains',
      'input',
      'slashCommands',
      'builtInPrompts.ts',
    ),
  });
}

export function renderBundledDiagnosePrompt({
  diagnoseSkillMarkdown,
  diagnoseRuntimeEvidenceMarkdown,
  diagnoseReportingMarkdown,
}) {
  return `${diagnoseSkillMarkdown.trimEnd()}

---

# Bundled references for the built-in prompt

The repository skill normally loads the following references on demand. They are bundled here because the built-in \`/happier-diagnose\` prompt must remain self-contained.

## Runtime evidence reference

${diagnoseRuntimeEvidenceMarkdown.trim()}

---

## Reporting reference

${diagnoseReportingMarkdown.trim()}
`;
}

export function renderBuiltInPromptsSource({
  diagnoseSkillMarkdown,
  diagnoseRuntimeEvidenceMarkdown,
  diagnoseReportingMarkdown,
}) {
  const serializedDiagnoseSkill = JSON.stringify(
    renderBundledDiagnosePrompt({
      diagnoseSkillMarkdown,
      diagnoseRuntimeEvidenceMarkdown,
      diagnoseReportingMarkdown,
    }),
  );

  return `// AUTO-GENERATED from skills/happier-diagnose/SKILL.md and its bundled references.
// Regenerate with: node scripts/generateBuiltInPrompts.mjs
// Validate freshness with: node scripts/generateBuiltInPrompts.mjs --check
//
// Built-in core slash commands available in any Happier session, no user
// configuration needed. Each entry's body is sent verbatim to the agent when
// the user types the matching token.

export type BuiltInPrompt = Readonly<{
    token: string;
    title: string;
    /** Markdown body sent to the agent as the user message. */
    body: string;
    /** Whether arguments after the token are appended to the body. */
    allowArgs: boolean;
}>;

export const HAPPIER_DIAGNOSE_BODY: string = ${serializedDiagnoseSkill};

export const BUILT_IN_PROMPTS: ReadonlyArray<BuiltInPrompt> = Object.freeze([
    Object.freeze({
        token: '/happier-diagnose',
        title: 'Diagnose Happier Issue',
        body: HAPPIER_DIAGNOSE_BODY,
        allowArgs: true,
    }),
]);

export function findBuiltInPrompt(token: string): BuiltInPrompt | null {
    const normalized = String(token ?? '').trim().toLowerCase();
    if (normalized.length === 0) return null;
    for (const entry of BUILT_IN_PROMPTS) {
        if (entry.token.toLowerCase() === normalized) return entry;
    }
    return null;
}
`;
}

async function main() {
  const checkOnly = process.argv.slice(2).includes('--check');
  const paths = resolveBuiltInPromptsPaths();
  const [
    diagnoseSkillMarkdown,
    diagnoseRuntimeEvidenceMarkdown,
    diagnoseReportingMarkdown,
  ] = await Promise.all([
    readFile(paths.diagnoseSkillPath, 'utf8'),
    readFile(paths.diagnoseRuntimeEvidencePath, 'utf8'),
    readFile(paths.diagnoseReportingPath, 'utf8'),
  ]);
  const expected = renderBuiltInPromptsSource({
    diagnoseSkillMarkdown,
    diagnoseRuntimeEvidenceMarkdown,
    diagnoseReportingMarkdown,
  });

  if (checkOnly) {
    const current = await readFile(paths.outputPath, 'utf8').catch(() => null);
    if (current !== expected) {
      console.error(
        'Built-in prompts are stale. Run: node scripts/generateBuiltInPrompts.mjs',
      );
      process.exitCode = 1;
    }
    return;
  }

  await writeFile(paths.outputPath, expected);
  console.log(`Generated ${path.relative(repoRoot, paths.outputPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
