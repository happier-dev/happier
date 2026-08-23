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
import { OUTPUT_PATH as PLUGIN_AVAIL_OUT, renderPluginAvailabilityMarkdown } from './generatePluginAvailability.mjs';
import { OUTPUT_PATH as FEATURE_ENV_OUT, renderFeatureEnvReferenceMarkdown } from './generateFeatureEnvReference.mjs';
import { OUTPUT_PATH as RUNTIME_EVENTS_OUT, renderRuntimeEventReferenceMarkdown } from './generateRuntimeEventReference.mjs';
import { OUTPUT_PATH as BUNDLED_PLUGINS_OUT, renderBundledPluginReferenceMarkdown } from './generateBundledPluginReference.mjs';
import { OUTPUT_PATH as SDK_SURFACE_OUT, renderSdkSurfaceReferenceMarkdown } from './generateSdkSurfaceReference.mjs';
import { OUTPUT_PATH as PLUGIN_ACTIONS_OUT, renderPluginActionReferenceMarkdown } from './generatePluginActionReference.mjs';

export const GENERATORS = [
  { name: 'agent capabilities', outputPath: AGENTS_OUT, render: renderAgentReferenceMarkdown },
  { name: 'feature flags', outputPath: FLAGS_OUT, render: renderFeatureFlagReferenceMarkdown },
  { name: 'API rate limits', outputPath: LIMITS_OUT, render: renderRateLimitReferenceMarkdown },
  { name: 'app downloads', outputPath: DOWNLOADS_OUT, render: renderDownloadsPageMarkdown },
  { name: 'keyboard shortcuts', outputPath: KEYS_OUT, render: renderKeyboardReferenceMarkdown },
  { name: 'plugin availability', outputPath: PLUGIN_AVAIL_OUT, render: renderPluginAvailabilityMarkdown },
  { name: 'feature environment', outputPath: FEATURE_ENV_OUT, render: renderFeatureEnvReferenceMarkdown },
  { name: 'runtime events', outputPath: RUNTIME_EVENTS_OUT, render: renderRuntimeEventReferenceMarkdown },
  { name: 'bundled plugins', outputPath: BUNDLED_PLUGINS_OUT, render: renderBundledPluginReferenceMarkdown },
  { name: 'SDK API surface', outputPath: SDK_SURFACE_OUT, render: renderSdkSurfaceReferenceMarkdown },
  { name: 'Plugin host Actions', outputPath: PLUGIN_ACTIONS_OUT, render: renderPluginActionReferenceMarkdown },
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
      // A missing source means this workspace simply is not checked out — skip.
      if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ENOENT')) continue;
      // A source that exists but no longer has the shape the generator expects
      // is a real problem, and the generator is right to refuse rather than
      // publish a guess. But it is *this* generator's problem: reporting it and
      // carrying on keeps the link and label checks working, which matters most
      // when the two lines of the codebase have diverged and one generator needs
      // rewiring for the tree it now finds itself in.
      problems.push({
        at: relative(process.cwd(), generator.outputPath),
        reason: `${generator.name}: generator could not run here — ${error?.message ?? error}`,
      });
      continue;
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
  // Tolerate an unbuildable source exactly as `checkGeneratedPages` does. A
  // generator reading a sibling package that is not built in this checkout used
  // to throw here and abort the loop, so one unbuilt workspace silently stopped
  // every *later* generator from regenerating — and the writer disagreeing with
  // the checker is the worst version of that, because the build then reports the
  // pages as stale with no way to refresh them.
  let failed = 0;
  for (const generator of GENERATORS) {
    let rendered;
    try {
      rendered = await generator.render();
    } catch (error) {
      if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ENOENT')) {
        console.log(`skipped ${generator.name} — its source is not built in this checkout`);
        continue;
      }
      console.error(`FAILED  ${generator.name}: ${error?.message ?? error}`);
      failed += 1;
      continue;
    }
    writeFileSync(generator.outputPath, rendered, 'utf8');
    console.log(`wrote ${relative(process.cwd(), generator.outputPath)}  (${generator.name})`);
  }
  if (failed > 0) process.exitCode = 1;
}
