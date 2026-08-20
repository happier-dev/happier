/**
 * Runs every documentation generator and reports which published pages moved.
 *
 * Registering them in one place means the drift check in `checkContent.mjs` and
 * the regeneration command cannot fall out of step: adding a generator here
 * makes the build enforce it too.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OUTPUT_PATH as AGENTS_OUT, renderAgentReferenceMarkdown } from './generateAgentReference.mjs';
import { OUTPUT_PATH as FLAGS_OUT, renderFeatureFlagReferenceMarkdown } from './generateFeatureFlagReference.mjs';
import { OUTPUT_PATH as DOWNLOADS_OUT, renderDownloadsPageMarkdown } from './generateDownloadsPage.mjs';
import { OUTPUT_PATH as KEYS_OUT, renderKeyboardReferenceMarkdown } from './generateKeyboardReference.mjs';
import { OUTPUT_PATH as LIMITS_OUT, renderRateLimitReferenceMarkdown } from './generateRateLimitReference.mjs';

export const GENERATORS = [
  { name: 'agent capabilities', outputPath: AGENTS_OUT, render: renderAgentReferenceMarkdown },
  { name: 'feature flags', outputPath: FLAGS_OUT, render: renderFeatureFlagReferenceMarkdown },
  { name: 'API rate limits', outputPath: LIMITS_OUT, render: renderRateLimitReferenceMarkdown },
  { name: 'app downloads', outputPath: DOWNLOADS_OUT, render: renderDownloadsPageMarkdown },
  { name: 'keyboard shortcuts', outputPath: KEYS_OUT, render: renderKeyboardReferenceMarkdown },
];

/**
 * Compare each generated page against a fresh render.
 *
 * A generator that cannot run — because the package it reads has not been built
 * in this checkout — is skipped rather than failed. A docs-only deploy is a
 * legitimate way to build this site, and an unbuildable sibling is not evidence
 * that the committed page is wrong.
 */
export async function checkGeneratedPages({ generators = GENERATORS } = {}) {
  const problems = [];
  for (const generator of generators) {
    let rendered;
    try {
      rendered = await generator.render();
    } catch (error) {
      if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ENOENT')) continue;
      throw error;
    }
    if (!existsSync(generator.outputPath)) {
      problems.push({ at: generator.outputPath, reason: `${generator.name}: generated page is missing` });
      continue;
    }
    if (readFileSync(generator.outputPath, 'utf8') !== rendered) {
      problems.push({
        at: relative(process.cwd(), generator.outputPath),
        reason: `${generator.name}: published page is stale — run \`yarn --cwd apps/docs generate:reference\``,
      });
    }
  }
  return problems;
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  for (const generator of GENERATORS) {
    writeFileSync(generator.outputPath, await generator.render(), 'utf8');
    console.log(`wrote ${relative(process.cwd(), generator.outputPath)}  (${generator.name})`);
  }
}
