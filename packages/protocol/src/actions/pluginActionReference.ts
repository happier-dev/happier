import {
  listActionSpecsForSurface,
  type ActionSpec,
} from './actionSpecs.js';
import { canRequestPresentUserApprovalForActionInputV1, DECISION_ACTION_IDS, requiresPresentUserDecisionForActionInputV1,
  resolveCredentialActionAdmissionV1, TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS } from './decisionAuthority.js';

const GENERATED_REFERENCE_NOTE =
  'Generated from the canonical ActionSpec registry. Do not hand-edit.';

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function escapeMdxText(value: string): string {
  return value
    .trim()
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/\{/gu, '&#123;')
    .replace(/\}/gu, '&#125;')
    .replace(/`/gu, '\\`')
    .replace(/\r?\n/gu, ' ');
}

function renderApproval(spec: ActionSpec): string {
  const flow = spec.approval.flow
    ?? (spec.approval.result === 'required' ? 'blocking' : 'deferred');
  return `\`${spec.approval.result}\` result; \`${flow}\` flow`;
}

/** Request admission and effect authority come from their canonical owners. */
function renderRequestAdmission(spec: ActionSpec): string {
  if ((DECISION_ACTION_IDS as readonly string[]).includes(spec.id)) {
    return '`approval_decision` — deciding credential and target Action authority govern admission; API tokens require `approve` scope; host Agent/MCP permission responses retain their waivable approval policy';
  }
  if ((TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS as readonly string[]).includes(spec.id)) {
    return '`conversational_input` — host invocations retain normal Action admission and policy; API-token answers follow the Send grant without requiring `approve` scope';
  }
  if (canRequestPresentUserApprovalForActionInputV1(spec)) {
    return '`human_approval` — eligible host Agent, MCP and plugin callers may request human approval; API-token callers receive `present_user_required`';
  }
  const admission = resolveCredentialActionAdmissionV1({
    spec, authority: 'account_automation', grant: null, surface: 'plugin',
  });
  return admission.ok
    ? '`account_automation` — subject to surface, access, grant and approval policy'
    : '`present_user` — an automation plugin caller receives `present_user_required`; decision Actions also enforce the deciding credential and target Action authority';
}

function renderDecisionEffectAuthority(spec: ActionSpec): string {
  if ((DECISION_ACTION_IDS as readonly string[]).includes(spec.id)) {
    return '`approval_decision` — present-user credentials or API tokens with `approve` scope may decide admitted requests; approving a present-user-only target still requires present-user authority; host Agent/MCP permission responses retain their waivable approval policy';
  }
  if ((TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS as readonly string[]).includes(spec.id)) {
    return '`conversational_input` — answers are conversational input; API-token answers use the Send grant, and do not confer security approval authority';
  }
  if (spec.requiredAuthority === 'account_automation' && requiresPresentUserDecisionForActionInputV1(spec)) {
    return '`human_decision` — automation may request this control/recovery operation, but its decision requires present-user authority';
  }
  return spec.requiredAuthority === 'present_user'
    ? '`present_user` — approval and the authorized effect require host-stamped present-user authority; request admission does not authorize self-approval'
    : '`account_automation` — subject to applicable approval and target decision authority';
}

function renderHostSurfaces(spec: ActionSpec): string {
  const surfaces = Object.entries(spec.surfaces)
    .filter(([surface, enabled]) => surface !== 'plugin' && enabled)
    .map(([surface]) => `\`${surface}\``);
  return surfaces.length > 0 ? surfaces.join(', ') : 'none';
}

function renderInputHints(spec: ActionSpec): readonly string[] {
  const hints = spec.inputHints?.fields ?? [];
  if (hints.length === 0) {
    return ['No field hints are published. Use the typed input accepted by `execute`.'];
  }

  return hints.map((field) => {
    const label = escapeMdxText(field.title);
    const description = field.description ? ` — ${escapeMdxText(field.description)}` : '';
    const required = field.required ? ', required' : '';
    return `- \`${field.path}\` (${field.widget}${required}): ${label}${description}`;
  });
}

function renderAction(spec: ActionSpec): string {
  const description = spec.description
    ? escapeMdxText(spec.description)
    : 'No additional description is published.';
  const sideEffectClass = spec.sideEffectClass ? `\`${spec.sideEffectClass}\`` : 'not classified';

  return [
    `## \`${spec.id}\``,
    '',
    `**${escapeMdxText(spec.title)}** — ${description}`,
    '',
    `- Safety: \`${spec.safety}\`; side effect: ${sideEffectClass}.`,
    `- Approval: ${renderApproval(spec)}.`,
    `- Request admission: ${renderRequestAdmission(spec)}.`,
    `- Decision/effect authority: ${renderDecisionEffectAuthority(spec)}.`,
    `- Also surfaced on: ${renderHostSurfaces(spec)}.`,
    '',
    '### Input guidance',
    '',
    ...renderInputHints(spec),
    '',
  ].join('\n');
}

/**
 * Projects the host ActionSpec registry into the single human-readable Plugin
 * author reference. The registry remains the source of ids, affordances, and
 * approval metadata; this module does not own a second Action catalog.
 */
export function renderPluginActionReferenceMarkdown(): string {
  const actionSpecs = [...listActionSpecsForSurface('plugin')]
    .sort((left, right) => compareCodePoints(left.id, right.id));

  return [
    '---',
    'title: Host actions',
    'description: Generated reference for every host Action available through the Plugin Actions service.',
    '---',
    '',
    `{/* ${GENERATED_REFERENCE_NOTE} */}`,
    '',
    'Use this reference when calling host Actions from a Plugin invocation context. It is generated from the canonical ActionSpec registry, so each listed id is available through `context.services.actions.execute(...)` and no hand-maintained Action list can drift from the host.',
    '',
    '```ts',
    "const result = await context.services.actions.execute('action.spec.get', {",
    "  id: 'session.status.get',",
    '}, {',
    '  signal: context.signal,',
    '});',
    '```',
    '',
    'The Action service validates the exact input and result contract for each id. Use the input guidance below when it is present; the TypeScript API remains the final typed contract.',
    '',
    'Every row separates **Request admission** from its canonical **Decision/effect authority**. In 0.3 development source, eligible host Agent, MCP and plugin invocations may request a `present_user` Action through the existing human approval flow. The human decides, and only the human-approved execution receives the host-stamped present-user authority required for the effect; the requester cannot self-approve or waive that floor. API-token callers cannot request these security effects and receive `present_user_required`, even with `approve` scope. Decision Actions separately check the deciding credential and the target Action\'s authority. Input-dependent human requirements still apply, such as explicit missing-directory consent. Caller authority is host-stamped: Action input can never supply, widen, or narrow it.',
    '',
    'In 0.3 development source, client-placed host Actions invoked through an admitted daemon host reach one connected app through the existing machine reverse channel. The app preserves the admitted surface and authority and uses its current mounted owners. Missing connected handlers return typed unavailable; a lost response after dispatch returns `outcome_uncertain` without automatic retry. Standalone CLI availability remains disabled. Plugin-declared client Actions retain their separate artifact and plugin-occurrence dispatch contract. See [Actions, tools and commands](/plugins/api/actions-tools-commands#host-actions-that-run-in-a-connected-app).',
    '',
    'Opening the OS file picker inside a standalone third-party embed frame is an explicit parity exclusion in the 0.3 development contract. Choosing local files remains a human UI interaction; agents attach files through the existing attachment Actions instead. The connected-app reverse channel does not address that frame, and no frame recipient identity or additional Composer reference is introduced for picker delivery. See [embedded attachments](/extending/embed#appearance-and-controls).',
    '',
    'Home continuation parity in the 0.3 development contract is authenticated-only: once the Account is authenticated, choosing a Home, retrying or refreshing, stopping the wait, relinking and opening Home are agent-requestable, human-decided operations. Bootstrap without a Home Account is an explicit UI-only exclusion because no agent exists before authentication. Key, credential and QR acquisition remain human-only and never enter Action input.',
    '',
    'Authority comes from the admitted invocation, never from Session content. A plugin running on someone\'s Session runtime keeps its own host-stamped principal no matter who wrote the latest message: the newest input author is correlation, and neither a `requestedBy`-style field nor input authorship delegates that person\'s Account. Host operations a plugin performs on a Session are recorded with the actual admitted execution Account plus Agent producer provenance, so an Agent post is visibly Agent-produced rather than attributed to the person who asked for it. Confirmation is a separate decision from authorization: an approval, or an explicit user waiver where the Action policy permits one, can satisfy the Action\'s confirmation requirement, but it never grants missing Session access, surface enablement, or endpoint consent.',
    '',
    'Bundled and externally installed plugins reach these Actions through the same `activate(api)` ABI, the same public SDK services seam, and the same Account Action settings. Trust is a user decision, not a packaging one: there is no smaller allowlist for an external plugin and no host-internal import that makes a first-party example work. Two surface distinctions are worth knowing before you pick a call site:',
    '',
    '- `session.message.send` accepts an optional `recipient`. Omit it for the main Session; `{ kind: \'execution_run\', runId }` addresses one Session-owned run through the Session\'s own Pending queue and target admission. The separate `execution.run.send` Action is only for a **detached** run with `sessionId: null`.',
    '- The trusted plugin `userText` binding additionally carries manifest-declared attachments and host-stamped source provenance. The public API-Token/SDK binding for the same Action is intentionally strict and smaller: it rejects `source`, attachments, structured launch and `idempotencyKey` rather than accepting them as untyped JSON. That is an authority boundary, not a reduced capability set. See [Actions, tools and commands](/plugins/api/actions-tools-commands#calling-host-actions).',
    '',
    ...actionSpecs.map(renderAction),
  ].join('\n');
}
