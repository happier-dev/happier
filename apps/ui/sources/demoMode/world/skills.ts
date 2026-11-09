import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { estimateSkillCostV1 } from '@happier-dev/protocol/prompts/library/skills/skillCostV1';
import type { SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';

import { DEMO_NOW_MS } from './constants';
import { buildDemoMachines } from './machines';

/** The same two world Machines, with an authored installed-Agent publication for the listing. */
export function buildDemoSkillMachines(): readonly ReachMachine[] {
    return buildDemoMachines().map(machine => ({
        machineId: machine.id, platform: machine.metadata?.platform === 'win32' ? 'win32' : 'posix',
        os: machine.metadata?.platform ?? null, arch: 'arm64',
        name: machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id,
        agentIds: ['claude', 'codex'], agentInventoryComplete: true,
        online: true, offline: false, lastSeenAt: null,
    }));
}

export const DEMO_REVIEW_SKILL_INSTRUCTIONS = `---
name: review-pull-requests
description: Review a pull request for correctness, security, and maintainability.
---

Read the change and its surrounding code. Trace affected callers and check the intended behavior.

Run the smallest relevant checks. Report concrete findings with file references and explain their impact.
Keep review comments actionable and distinguish observed failures from open questions.
`;

/** A personal demo Library, not an installation receipt or an external catalog response. */
export function buildDemoSkillsLibrary(): SkillsLibrary {
    const skills = [
        { id: 'demo-skill-review', name: 'Review pull requests', description: 'Check correctness, security, and maintainability before merging.' },
        { id: 'demo-skill-tests', name: 'Test a web app', description: 'Follow the main user journey and verify its recovery paths.' },
        { id: 'demo-skill-docs', name: 'Write project docs', description: 'Explain the setup and workflows with examples from this project.' },
        { id: 'demo-skill-diagnose', name: 'Investigate a bug', description: 'Reproduce the failure and trace it back to its owning code.' },
    ];
    return {
        scope: null, status: 'ready', stale: false, errorCode: null, usageObservedSince: DEMO_NOW_MS - 604_800_000,
        retry: () => {},
        items: skills.map((skill, index) => SkillListItemV1Schema.parse({
            skillId: skill.id, name: skill.name, description: skill.description, revision: '1:1',
            rules: [{ id: `${skill.id}-everywhere`, skillId: skill.id, target: { t: 'allMachines' },
                enabled: true, createdAt: DEMO_NOW_MS - 604_800_000, updatedAt: DEMO_NOW_MS - 86_400_000 }],
            trust: 'text_only', cost: estimateSkillCostV1(index === 0 ? DEMO_REVIEW_SKILL_INSTRUCTIONS : skill.description),
            provenance: { kind: 'written' }, modified: false, updatePolicy: 'manual',
            lastUsedAt: DEMO_NOW_MS - (index + 1) * 3_600_000,
            createdAt: DEMO_NOW_MS - 604_800_000, migratedFromContext: false, userInvocable: true, folderId: null,
        })),
    };
}
