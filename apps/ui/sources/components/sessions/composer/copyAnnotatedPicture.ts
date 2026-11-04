import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';
import { flattenAnnotatedImage } from '@/components/ui/media/annotation/flattenImage';
import type { ImageAnnotationSource } from '@/components/ui/media/annotation/types';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import { appendToSessionDraft } from './appendToSessionDraft';

/** Copy hosts and session-image Actions share the same flatten and draft append. */
export async function copyAnnotatedPicture(input: Readonly<{
  source: ImageAnnotationSource; document: ImageMarksDocumentV1; name: string; sessionTarget: ExactSessionMachineTargetIdentity;
}>): Promise<Readonly<{ ok: true; status: 'appended'; imageNumber?: number }> | Readonly<{ ok: false; reason: string }>> {
  const flattened = await flattenAnnotatedImage(input.source, input.document);
  if (!flattened.ok) return flattened;
  const appended = appendToSessionDraft({ sessionTarget: input.sessionTarget, items: [{ kind: 'image', source: {
    kind: 'memory', bytes: flattened.png, name: `${input.name.replace(/\.[^.]+$/, '')}.png`, mimeType: 'image/png',
  } }] });
  return appended.status === 'applied' ? { ok: true, status: 'appended', imageNumber: appended.imageNumbers[0] }
    : { ok: false, reason: appended.status === 'invalidOperation' ? appended.reason : appended.status };
}
