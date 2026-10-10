import { readPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { withUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';

import { renderPromptTemplateTextV1 } from './renderPromptTemplateTextV1';

export async function expandPromptTemplateInvocation(args: Readonly<{
  targetArtifactId: string;
  argsText: string;
  serverId?: string | null;
}>): Promise<string> {
  const artifactId = String(args.targetArtifactId ?? '').trim();
  if (!artifactId) {
    throw new Error('prompt_template_missing_artifact');
  }

  const document = await withUiPromptLibraryArtifactStore((store) => readPromptDocInLibrary({ store, artifactId }), { serverId: args.serverId });
  if (!document.ok) throw Object.assign(new Error(document.error), { code: document.errorCode });

  return renderPromptTemplateTextV1({
    templateMarkdown: document.markdown,
    argsText: args.argsText,
  }).text;
}
