import type { ActionExecuteFailure } from '../../actions/actionExecutionResult.js';
import type { PromptDocArtifactRefV1 } from '../../prompts/library/promptArtifactRefsV1.js';
import type { readPromptDocInLibrary } from '../../prompts/library/promptLibraryActionOperations.js';
import type { ProjectSourceV1 } from './projectSourceV1.js';

type QualifiedSource = Readonly<{ serverId: string; source: ProjectSourceV1 }>;
type PromptRead = Extract<Awaited<ReturnType<typeof readPromptDocInLibrary>>, { ok: true }>;
export type ProjectSourceOnboardingTaskReadResultV1 = PromptRead | ActionExecuteFailure;
export type ProjectSourceOnboardingTaskReferenceV1 = Readonly<{
  serverId: string;
  sourceId: string;
  sourceName: string;
  ref: PromptDocArtifactRefV1 & Readonly<{ serverId: string }>;
}>;
export type ProjectSourceOnboardingTaskSelectionV1 = Readonly<{
  task: (ProjectSourceOnboardingTaskReferenceV1 & Pick<PromptRead, 'title' | 'markdown' | 'revision'>) | null;
  unavailable: readonly (ProjectSourceOnboardingTaskReferenceV1 & Readonly<{ result: ActionExecuteFailure }>)[];
}>;

/** Source metadata advertises a suggestion, never prompt content or read authority. */
export function projectSourceOnboardingTaskReferenceV1(input: QualifiedSource): ProjectSourceOnboardingTaskReferenceV1 | null {
  const attachment = input.source.attachments?.find(item => item.purpose === 'onboarding_task');
  if (attachment?.purpose !== 'onboarding_task') return null;
  return { serverId: input.serverId, sourceId: input.source.id, sourceName: input.source.name,
    ref: { ...attachment.ref, serverId: attachment.ref.serverId ?? input.serverId } };
}

/** Called only when displaying a task. The ordinary prompt reader owns access and decryption. */
export async function resolveProjectSourceOnboardingTaskV1(input: Readonly<{
  sources: readonly QualifiedSource[];
  signal?: AbortSignal;
  readPrompt(ref: ProjectSourceOnboardingTaskReferenceV1['ref'], options?: Readonly<{ signal?: AbortSignal }>): Promise<ProjectSourceOnboardingTaskReadResultV1>;
}>): Promise<ProjectSourceOnboardingTaskSelectionV1> {
  const unavailable: (ProjectSourceOnboardingTaskReferenceV1 & Readonly<{ result: ActionExecuteFailure }>)[] = [];
  for (const source of input.sources) {
    input.signal?.throwIfAborted();
    const reference = projectSourceOnboardingTaskReferenceV1(source);
    if (!reference) continue;
    const result = await input.readPrompt(reference.ref, input.signal ? { signal: input.signal } : undefined);
    input.signal?.throwIfAborted();
    if (result.ok) return { task: { ...reference, title: result.title, markdown: result.markdown, revision: result.revision }, unavailable };
    unavailable.push({ ...reference, result });
  }
  return { task: null, unavailable };
}
