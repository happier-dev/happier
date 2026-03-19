import { PromptDocBodyV1Schema } from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';

import { renderPromptTemplateTextV1 } from './renderPromptTemplateTextV1';

export async function expandPromptTemplateInvocation(args: Readonly<{
  targetArtifactId: string;
  argsText: string;
}>): Promise<string> {
  const artifactId = String(args.targetArtifactId ?? '').trim();
  if (!artifactId) {
    throw new Error('prompt_template_missing_artifact');
  }

  const readBody = (): string | null => {
    const existing = storage.getState().artifacts?.[artifactId] ?? null;
    return typeof existing?.body === 'string' ? existing.body : null;
  };

  let bodyRaw = readBody();
  if (bodyRaw === null) {
    const full = await sync.fetchArtifactWithBody(artifactId);
    if (full) {
      storage.getState().updateArtifact?.(full);
    }
    bodyRaw = readBody();
  }
  if (bodyRaw === null) {
    throw new Error('prompt_template_missing_body');
  }

  const parsed = PromptDocBodyV1Schema.safeParse(JSON.parse(bodyRaw));
  if (!parsed.success) {
    throw new Error('prompt_template_invalid_body');
  }

  return renderPromptTemplateTextV1({
    templateMarkdown: parsed.data.markdown,
    argsText: args.argsText,
  });
}
