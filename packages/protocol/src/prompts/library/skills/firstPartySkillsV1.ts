import type { PromptBundleEntryV1 } from '../promptBundleSchemas.js';
import { encodeBase64 } from '../../../crypto/base64.js';
import type { SkillRuleV1 } from '../../../reach/reachRuleV1.js';
import type { ReadOnlySkillProvenanceV1 } from './skillLibraryItemV1.js';
import type { FeatureId } from '../../../features/catalog.js';
import { resolveReachV1, type ReachContextV1, type ReachDecisionV1 } from '../../../reach/resolveReachV1.js';
import type { ReachRulesV1 } from '../../../reach/reachRuleV1.js';
const DEPLOY_GUIDE_V1 = `---
name: deploy
description: Prepare and publish deployments, verify receipts and health, or diagnose a failed deployment in Happier
---

Use Happier's Action discovery tools to read the current input schema before
executing an Action. Search results are choices, not a deployment recipe. Follow
returned availability and approvals; a disabled feature is not permission to
deploy by another channel.

## Identify and prepare

Confirm the intended Happier Home, project, environment, source revision and
destination with the person. Inspect existing environments using
\`deployments.environments.list\` and \`deployments.environments.get\`. Check the
environment's controller and targets before changing them: a controller runs
deployment work; it is not necessarily the application host. Reuse the intended
environment rather than creating a second one to escape an error.

Read \`deployments.prepare\` for the supported preparation flow, or
\`deployments.publish.prepare\` when publishing the current project. Preparation
describes the exact operation and remaining choices. Resolve the returned
options, template, source, target and binding requirements from current schemas;
do not copy a previous environment's choices blindly. If a template is needed,
inspect \`deployments.templates.instantiate\` and distinguish its preview from
its apply operation. Link a target with \`deployments.targets.link\` only when
that is the intended change. Never infer permission to provision infrastructure
or overwrite an environment from a request to inspect it.

## Deploy and verify

Review the prepared changes and obtain any required approval through the Action
executor. Use \`deployments.deploy\` for the prepared environment, or
\`deployments.publish\` for the publish flow. Carry returned identifiers and
preparation results into the operation exactly as its schema requires. Treat
an accepted request as started work, not as a healthy application.

Inspect the operation through \`deployments.receipts.get\`; use
\`deployments.receipts.list\` to find a receipt when the identifier is missing.
Follow the receipt's state and output to its actual target. Then inspect
\`deployments.health.current\`, or \`deployments.health.read\` when historical
health evidence is needed. Use \`deployments.logs.read\` for the relevant
runtime and interval. Report what finished, what health evidence was observed,
and any remaining warning or unavailable check. Do not claim success solely
because deployment execution returned without an exception.

## Diagnose a failed deployment

Start with the failed receipt and its environment. Separate control-plane
admission or controller failures from build/runtime failures, database or binding
configuration, and domain routing. Read the specific runtime logs and current
health before proposing a repair. \`deployments.drift.read\` can explain a
difference between intended and observed configuration. For a domain problem,
inspect \`deployments.domains.get\` and the returned verification requirements
before choosing \`deployments.domains.verify\`.

Explain the smallest evidence-backed repair and its effect. A restart does not
repair a bad binding, and redeploying does not establish correct domain routing.
Use \`deployments.restart\`, \`deployments.rollback\` or
\`deployments.cancel\` only when the person's intent and the current schema
support that operation. After repair, inspect the new receipt and health again;
preserve the original failed receipt for diagnosis.

## Keep secrets out of the conversation

Use Saved Secret references and the deployment binding flow rather than asking
for tokens or environment secret values in chat. \`deployments.bindings.set\`
changes bindings; inspect its schema and use the supported reference mechanism.
Never read a secret just to paste it into an Action, transcript, diagnostic
summary or command. Share only non-secret identifiers, statuses and redacted
failure evidence. If a required secret reference is missing, ask the person to
link it through the appropriate Happier control, then resume preparation.
`;
const WORKFLOWS_GUIDE_V1 = `---
name: workflows
description: Create or edit user Workflows, run a one-off Workflow, configure triggers and placement, or diagnose and repair a failed Run in Happier
---

Discover the current Action specs and field options before authoring or running
a Workflow. Use Happier's Action executor and its approval flow. Do not replace
a refused or unavailable Workflow operation with a shell script.

## Choose the outcome

Distinguish a reusable user Workflow from a one-off Run. For an existing user
Workflow, locate it with \`workflow.definition.list\` and inspect it with
\`workflow.definition.get\`. Preserve its identity and existing triggers when
editing. For a one-off request, use \`workflow.run.start\` with the currently
supported inline definition; do not create a saved definition or schedule unless
the person wants future reuse. Inspect \`workflow.starters.list\` and
\`workflow.starters.resolve\` when a starter fits the task.

## Author deliberately

When the person has an editor open, use \`workflow.authoring.draft.get\` to read
the mounted draft and \`workflow.authoring.draft.edit\` to change it. Validate
before \`workflow.authoring.draft.save\`; draft edits and saved definitions are
different states. Use \`workflow.authoring.draft.undo\` to undo a mistaken edit
instead of overwriting newer work. If no draft is mounted, use
\`workflow.definition.create\` or \`workflow.definition.edit\` according to
the current schema and requested outcome. Do not assume a mounted draft exists
on an unattended machine.

Read \`workflow.validate\` and its current definition schema. Choose step
types from that schema and resolve supported options rather than guessing enum
values. Make dependencies, inputs and outputs explicit. Choose the execution
placement for each applicable step: the intended machine or pool, session or
background execution, workspace and Agent/model options must serve the task.
A phone authoring a Workflow does not imply execution on the phone, and an
Account-scoped definition does not identify an execution machine.

Explain the normal path and failure path to the person. Conditions control
whether work should proceed; approvals control whether the requested effect
is authorized. Neither should silently stand in for the other. Keep secret
values in supported Saved Secret references, out of prompts and run summaries.

## Triggers and schedules

For repeatable work, inspect \`workflow.trigger.list\` before adding a trigger
with \`workflow.trigger.add\` or changing one with
\`workflow.trigger.update\`. Read available trigger kinds and event contracts
from \`workflow.events.list\` and the trigger schema. Confirm the schedule,
timezone, event filters, conditions and execution placement that matter to this
request. A manual Run does not authorize a recurring schedule.

Use \`workflow.trigger.test\` to inspect how the intended event and conditions
would match before enabling new unattended work. For a deliberate manual
invocation of a saved trigger, inspect \`workflow.trigger.run_now\`; for a
direct Run use \`workflow.run.start\`. Do not treat a trigger test as proof
that the resulting Run finished.

## Observe, approve and repair

Read \`workflow.run.get\` and \`workflow.run.invocations.list\` to follow a
Run. Inspect \`workflow.run.invocations.get\` for the failed or waiting step,
its inputs, outputs and reported error. A Run waiting for approval or review is
not a crashed Run. Let the person use the returned approval path; never disable
approvals, change the requester or restart by another channel to bypass it.
For a review step, inspect \`workflow.run.invocations.complete_review\` and
use it only for the review decision the person actually authorized.

Before retrying, determine whether the failed invocation already caused an
external effect and whether the relevant operation supports retry. Correct the
definition for future Runs when the cause is an authoring error; inspect the
current Run's recovery options separately. Use
\`workflow.run.invocations.retry\` for a supported retry, or
\`workflow.run.resume\` for a paused Run, rather than starting duplicate work.
Use \`workflow.run.cancel\` when asked to stop. Re-inspect the Run and affected
invocations after repair and report completed, skipped, waiting and failed work
from observed state, including any external effect that needs manual recovery.
`;

/** Host-owned content, projected afresh from the current built-in or plugin occurrence. */
export type ReadOnlySkillV1 = Readonly<{
  skillId: string; files: readonly PromptBundleEntryV1[]; provenance: ReadOnlySkillProvenanceV1;
}>;

export type FirstPartySkillV1 = ReadOnlySkillV1 & Readonly<{
  skillId: `happier:${string}`; name: string; description: string; files: readonly PromptBundleEntryV1[];
  provenance: Readonly<{ kind: 'first_party' }>;
  requiresFeature?: FeatureId;
}>;

/** Shared tool-use instructions; installing a Skill is not required for discovery. */
export const HAPPIER_ACTION_DISCOVERY_GUIDANCE_V1 = `Use the Happier tools delivered in this session, through MCP or a native extension.
Find \`action_spec_search\`, \`action_spec_get\`, and \`action_execute\` among your
available tools; their server prefix may vary. Search for the operation, read its
current schema, then execute its returned Action id with \`{ actionId, input }\`.
A missing direct tool for an Action does not mean the Action is unavailable.
Follow the returned availability, permission, and approval requirements.`;

const happierGuide = `---
name: happier
description: Use Happier from this session
---

${HAPPIER_ACTION_DISCOVERY_GUIDANCE_V1}

For standalone CLI operations, first check that \`happier\` is on PATH and
authenticated to the intended Happier Home. Read \`happier --help\`, then
\`happier skills --help\`, \`happier mcp --help\`, or \`happier session --help\` as needed.
The CLI uses its own authenticated identity; it does not inherit this turn's
requester. Do not switch channels to bypass a refusal or approval requirement.
If a requester cannot be identified, ask the person to send a fresh request from
their signed-in Happier app. If no usable channel is available, say so.
`;

/** Bundled content uses the same digest and materializer as Account skill bundles. */
export const FIRST_PARTY_SKILLS_V1: readonly FirstPartySkillV1[] = [{
  skillId: 'happier:happier', name: 'happier', description: 'Use Happier from this session',
  provenance: { kind: 'first_party' },
  files: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode(happierGuide), 'base64') }],
}, {
  skillId: 'happier:deploy', name: 'deploy', requiresFeature: 'deployments',
  description: 'Prepare and publish deployments, verify receipts and health, or diagnose a failed deployment in Happier',
  provenance: { kind: 'first_party' },
  files: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode(DEPLOY_GUIDE_V1), 'base64') }],
}, {
  skillId: 'happier:workflows', name: 'workflows', requiresFeature: 'workflows',
  description: 'Create or edit user Workflows, run a one-off Workflow, configure triggers and placement, or diagnose and repair a failed Run in Happier',
  provenance: { kind: 'first_party' },
  files: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode(WORKFLOWS_GUIDE_V1), 'base64') }],
}];

/** Existing seed rules remain valid; new built-ins use read-only reach defaults. */
export function buildFirstPartySkillSeedRuleV1(skillId: string, nowMs: number): SkillRuleV1 {
  return { id: `first-party:${skillId}`, skillId, target: { t: 'allMachines' }, enabled: true,
    createdAt: nowMs, updatedAt: nowMs };
}

/** Feature availability is admission; explicit reach rules choose defaults within it. */
export function resolveSkillReachV1(skillId: string, rules: ReachRulesV1, context: ReachContextV1,
  isFeatureEnabled?: (featureId: FeatureId) => boolean): ReachDecisionV1 & Readonly<{ available: boolean }> {
  const skill = FIRST_PARTY_SKILLS_V1.find(skill => skill.skillId === skillId);
  const reach = resolveReachV1(rules, context);
  const available = !skill?.requiresFeature || isFeatureEnabled?.(skill.requiresFeature) === true;
  return { enabled: available && (reach.decidedBy ? reach.enabled : skill !== undefined), decidedBy: reach.decidedBy, available };
}
