/**
 * Renders the runtime event reference from the protocol schema.
 *
 * The hand-written page this replaces described `AgentSessionRuntimeEvent`
 * without naming a single one of its members. What it did list had drifted:
 * "descriptor updates" and "subagent start/status/end" are not event kinds at
 * all, and eight real ones were missing — the whole input-custody family
 * (`input-accepted`, `input-rejected`, `input-custody-unknown`,
 * `input-delivery-failed`), plus `turn-progress`, `turn-rollback-boundary`,
 * `runtime-activity-snapshot` and `runtime-ended`. A prose summary of a
 * discriminated union is a summary that goes stale on the next union member.
 *
 * The schema is read rather than parsed: importing the built module and walking
 * the union means a renamed or removed kind changes this page, and a shape this
 * generator no longer understands fails loudly instead of publishing a guess.
 *
 * Compaction is the one member that is not discriminated by `kind`. Every
 * compaction event carries `kind: 'context-compaction'` and is distinguished by
 * `phase`, so it gets its own table rather than being flattened into the first
 * one, which would imply six kinds that do not exist.
 *
 * Regenerate with `yarn --cwd apps/docs generate:reference`.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const SCHEMA = join(REPO, 'packages', 'protocol', 'dist', 'runtime', 'agentSessionV1.js');
export const OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'development', 'architecture', 'runtime', 'runtime-events.mdx');

/** Families in the order the schema composes them, with a reader-facing gloss. */
const FAMILIES = [
  {
    title: 'Input custody',
    lede: 'What happened to something you sent. Every input reaches exactly one of these, so a message that seems to have vanished has an event explaining where it went.',
    kinds: ['input-accepted', 'input-rejected', 'input-custody-unknown', 'input-delivery-failed'],
  },
  {
    title: 'Turn lifecycle',
    lede: 'A turn starts, runs, and ends exactly once. `turn-complete`, `turn-failed` and `turn-cancelled` are the three terminal events.',
    kinds: ['turn-start', 'turn-progress', 'turn-agent-id-observed', 'turn-complete', 'turn-failed', 'turn-cancelled', 'turn-rollback-boundary', 'provider-session-id', 'runtime-ended'],
  },
  {
    title: 'Output',
    lede: 'What the agent produced, as it produces it.',
    kinds: ['message-delta', 'tool-call', 'tool-progress', 'tool-result', 'transcript-message-committed', 'file-edit', 'usage-observed'],
  },
  {
    title: 'Activity',
    lede: 'A periodic snapshot of what the runtime is doing, rather than a discrete thing that happened.',
    kinds: ['runtime-activity-snapshot'],
  },
];

/** Walk a zod discriminated union without depending on one library version's internals. */
export function readDiscriminatedMembers(schema) {
  const discriminator = schema?._def?.discriminator;
  const options = schema?._def?.options ?? [];
  return options.map((option) => {
    const shape = option.shape ?? option._def?.shape ?? {};
    const field = shape[discriminator];
    const value = field?._def?.value ?? field?.value ?? field?._zod?.def?.values?.[0];
    if (value === undefined) throw new Error(`could not read the "${discriminator}" literal of a union member`);
    return value;
  });
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

export async function renderRuntimeEventReferenceMarkdown({ schemaPath = SCHEMA } = {}) {
  const module = await import(`file://${schemaPath}`);
  const root = module.AgentSessionRuntimeEventV1Schema;
  const core = root?._def?.schema ?? root;
  const parts = core?._def?.options ?? [];
  if (parts.length !== 2) {
    throw new Error(`expected a two-part runtime event union, found ${parts.length}`);
  }

  const kinds = readDiscriminatedMembers(parts[0]);
  const phases = readDiscriminatedMembers(parts[1]);

  // A kind the families table does not place would silently vanish from the page.
  const placed = new Set(FAMILIES.flatMap((f) => f.kinds));
  const unplaced = kinds.filter((k) => !placed.has(k));
  if (unplaced.length > 0) {
    throw new Error(`runtime event kinds not assigned to a family: ${unplaced.join(', ')} — add them to FAMILIES`);
  }
  const missing = [...placed].filter((k) => !kinds.includes(k));
  if (missing.length > 0) {
    throw new Error(`FAMILIES names kinds the schema no longer has: ${missing.join(', ')}`);
  }

  const sections = FAMILIES.map(
    (family) => `### ${family.title}\n\n${family.lede}\n\n${table(['Kind'], family.kinds.map((k) => [`\`${k}\``]))}`,
  ).join('\n\n');

  return `---
title: Runtime events
description: Every kind of live runtime event an agent emits, generated from the protocol schema.
---

\`AgentSessionRuntimeEvent\` is the payload an agent runtime emits as a session
runs. Provider leaves map whatever their agent natively produces into these, so
the host sees one shape regardless of which agent is running.

There are **${kinds.length} event kinds**, plus context compaction, which is one kind with
${phases.length} phases.

<Callout type="info">
  Runtime events are live facts, not transcript rows. The host decides which of
  them become durable transcript entries, session state, notifications or UI
  status — emitting one does not persist anything by itself. They are also not
  the plugin SDK's event-bus envelope, which is a different shape.
</Callout>

## Event kinds

${sections}

## Context compaction

Compaction events all carry \`kind: 'context-compaction'\` and are told apart by
\`phase\` rather than by kind. They also carry \`compactionId\`, \`trigger\`,
\`retryAttempt\` and the token count before compaction.

${table(['Phase'], phases.map((p) => [`\`${p}\``]))}

\`outcomeUnknown\` is worth noticing: compaction can end without the runtime
learning whether it succeeded, and the schema represents that rather than
guessing a result.

## Related

- [Session loop](/development/architecture/runtime/session-loop) — what consumes these.
- [Transcripts and state](/development/architecture/runtime/transcripts-state) — which of them become durable rows.
`;
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUTPUT_PATH, await renderRuntimeEventReferenceMarkdown(), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
