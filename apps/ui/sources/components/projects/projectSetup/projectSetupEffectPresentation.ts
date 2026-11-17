import * as z from 'zod/mini';
import { formatProjectInvocation } from './projectScriptPresentation';

// A display-only projection of B9's presentation. Unknown fields are stripped at every level;
// neither secret/config values nor private repository bytes enter the review model.
const ProjectSetupReviewPresentationSchema = z.object({
  bindings: z.array(z.object({
    name: z.string(), ref: z.string(), revision: z.optional(z.number()),
    source: z.enum(['personal', 'shared_resource']), displayName: z.nullable(z.string()),
  })),
  provenance: z.object({
    file: z.literal('.happier/project.json'), kind: z.enum(['repository', 'nonRepository', 'unavailable']),
    headCommit: z.optional(z.string()), branch: z.optional(z.string()),
    fileState: z.enum(['modified', 'untracked', 'unknown', 'absent']),
    committed: z.optional(z.object({ commit: z.string() })),
  }),
});

export type ProjectSetupReviewPresentation = z.infer<typeof ProjectSetupReviewPresentationSchema>;
const ProjectSetupLifecycleCommandsSchema = z.object({ setup: z.array(z.unknown()), teardown: z.array(z.unknown()) });

export function readProjectSetupReviewPresentation(reviewedEffect: unknown): ProjectSetupReviewPresentation | null {
  const presentation = reviewedEffect && typeof reviewedEffect === 'object' && 'presentation' in reviewedEffect
    ? reviewedEffect.presentation : undefined;
  const parsed = ProjectSetupReviewPresentationSchema.safeParse(presentation);
  return parsed.success ? parsed.data : null;
}

/**
 * The exact commands of a reviewed setup effect (the producer's safe `reviewedEffect` DTO), in run
 * order: `executable args…` per step, else its declared command or native target. Never secret
 * values, which the DTO does not carry. Null when the effect names no command.
 */
export function listReviewedSetupCommands(
  reviewedEffect: unknown,
): readonly string[] | null {
  const lifecycle = reviewedEffect && typeof reviewedEffect === 'object' && 'lifecycle' in reviewedEffect
    ? ProjectSetupLifecycleCommandsSchema.safeParse(reviewedEffect.lifecycle) : null;
  // Lifecycle consent displays both phases. Command-only reviews (for example a Script approval)
  // retain their selected command list and do not acquire lifecycle meaning.
  const commands = lifecycle?.success ? [...lifecycle.data.setup, ...lifecycle.data.teardown] :
    reviewedEffect &&
    typeof reviewedEffect === 'object' &&
    'commands' in reviewedEffect
      ? (reviewedEffect as { commands?: unknown }).commands
      : null;
  if (!Array.isArray(commands) || commands.length === 0) return null;
  return commands.map((command) => {
    if (typeof command === 'string') return command;
    if (!command || typeof command !== 'object') return '';
    const record = command as Record<string, unknown>;
    const args = Array.isArray(record.args)
      ? record.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    const executable =
      typeof record.executable === 'string' ? record.executable : null;
    const source =
      record.source && typeof record.source === 'object'
        ? (record.source as Record<string, unknown>)
        : null;
    if (executable !== null) return formatProjectInvocation({ tool: executable, args });
    if (record.kind === 'command' && typeof record.command === 'string') return record.command;
    if (typeof source?.command === 'string') return source.command;
    return typeof source?.target === 'string'
      ? formatProjectInvocation({ tool: source.target, args })
      : '';
  }).filter(command => command.trim().length > 0);
}
