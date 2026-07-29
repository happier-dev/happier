import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  renderBuiltInPromptsSource,
  resolveBuiltInPromptsPaths,
} from './generateBuiltInPrompts.mjs';

test('the built-in Happier diagnose prompt is generated from the canonical skill', async () => {
  const paths = resolveBuiltInPromptsPaths();
  const [
    skillMarkdown,
    runtimeEvidenceMarkdown,
    reportingMarkdown,
    generatedSource,
  ] = await Promise.all([
    readFile(paths.diagnoseSkillPath, 'utf8'),
    readFile(paths.diagnoseRuntimeEvidencePath, 'utf8'),
    readFile(paths.diagnoseReportingPath, 'utf8'),
    readFile(paths.outputPath, 'utf8'),
  ]);

  assert.equal(
    generatedSource,
    renderBuiltInPromptsSource({
      diagnoseSkillMarkdown: skillMarkdown,
      diagnoseRuntimeEvidenceMarkdown: runtimeEvidenceMarkdown,
      diagnoseReportingMarkdown: reportingMarkdown,
    }),
  );
});
