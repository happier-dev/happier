import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BotTemplateReleaseV1AuthoringSchema } from './botTemplateV1.js';

describe('bundled Bot template releases', () => {
  it.each([
    ['release-captain', 'Release captain'], ['pr-reviewer', 'PR reviewer'],
    ['ci-fixer', 'CI fixer'], ['dependency-gardener', 'Dependency gardener'],
    ['issue-sorter', 'Issue sorter'], ['docs-keeper', 'Docs keeper'],
    ['spec-drafter', 'Spec drafter'], ['support-desk', 'Support desk'],
    ['standup-writer', 'Standup writer'], ['machine-caretaker', 'Machine caretaker'],
  ])('admits the portable %s release', (id, name) => {
    const path = new URL(`../../../../plugins/bot-templates/resources/bots/${id}.json`, import.meta.url);
    const release = BotTemplateReleaseV1AuthoringSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(release.content.identity.name).toBe(name);
    expect(release.content.workedExample).toBeDefined();
    expect(release.content.firstTask).toBeTruthy();
    expect(release.content.memoryRules).not.toHaveLength(0);
    expect(release.content.skills).not.toHaveLength(0);
    expect(release.content.pausedWorkflows?.filter(workflow => workflow.kind === 'memoryUpkeep')).toHaveLength(1);
  });
});
