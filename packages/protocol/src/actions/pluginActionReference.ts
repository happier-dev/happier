import {
  listActionSpecsForSurface,
  type ActionSpec,
} from './actionSpecs.js';

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

/**
 * Canonical caller authority copied from the ActionSpec row. Discovery on the
 * `plugin` surface never implies a plugin caller can satisfy the Action: rows
 * that require `present_user` reject automation callers (plugins and API
 * Tokens) with `present_user_required`.
 */
function renderCallerAuthority(spec: ActionSpec): string {
  return spec.requiredAuthority === 'present_user'
    ? '`present_user` — only a host-stamped present-user caller is admitted; plugin and API-token callers receive `present_user_required`'
    : '`account_automation` — automation callers (including trusted plugins and API Tokens) are admitted';
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
    `- Caller authority: ${renderCallerAuthority(spec)}.`,
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
    'Every row carries its canonical **Caller authority** from the ActionSpec registry. Being listed here proves the Action is discoverable on the Plugin surface; it does not imply a plugin caller can satisfy it. A row marked `present_user` is admitted only when the host stamps present-user caller authority — a plugin or API-token caller carries automation authority and receives the typed `present_user_required` failure instead of a result. Caller authority is host-stamped: Action input can never supply, widen, or narrow it.',
    '',
    'In 0.3 development source, client-placed host Actions invoked through an admitted daemon host reach one connected app through the existing machine reverse channel. The app preserves the admitted surface and authority and uses its current mounted owners. Missing connected handlers return typed unavailable; a lost response after dispatch returns `outcome_uncertain` without automatic retry. Standalone CLI availability remains disabled. Plugin-declared client Actions retain their separate artifact and plugin-occurrence dispatch contract. See [Actions, tools and commands](/plugins/api/actions-tools-commands#host-actions-that-run-in-a-connected-app).',
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
