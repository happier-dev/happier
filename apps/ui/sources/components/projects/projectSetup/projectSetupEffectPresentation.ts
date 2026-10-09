import * as z from 'zod/mini';

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
  }),
});

export type ProjectSetupReviewPresentation = z.infer<typeof ProjectSetupReviewPresentationSchema>;

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
  const commands =
    reviewedEffect &&
    typeof reviewedEffect === 'object' &&
    'commands' in reviewedEffect
      ? (reviewedEffect as { commands?: unknown }).commands
      : null;
  if (!Array.isArray(commands) || commands.length === 0) return null;
  return commands.map((command) => {
    if (typeof command === 'string') return command;
    if (!command || typeof command !== 'object') return String(command);
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
    const head =
      executable ??
      (typeof source?.command === 'string'
        ? source.command
        : typeof source?.target === 'string'
          ? source.target
          : null);
    return [head, ...args].filter(Boolean).join(' ');
  });
}
