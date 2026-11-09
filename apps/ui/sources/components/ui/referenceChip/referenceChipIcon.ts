import { parseMentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';

import type { IconName } from '@/components/ui/icons/Icon';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '@/components/workflows/presentation/workflowBlockKindGlyph';

/**
 * The glyph a reference chip leads with, decided once for the composer and the transcript.
 * The reference's own scheme decides; a caller-supplied portable token (a plugin's presentation
 * icon) speaks only for contributed and attachment references, whose kind says nothing visual.
 */
export function resolveReferenceChipIconName(
  input: Readonly<{ ref: string; glyph?: string | null }>,
): IconName | null {
  // A video note's time chip: not a mention, and it plays from that moment.
  if (input.ref.startsWith('time:')) return 'play';
  const parsed = parseMentionRefV1(input.ref);
  switch (parsed?.scheme) {
    case 'file':
      return parsed.opaque.endsWith('/') ? 'folder' : 'file';
    case 'session':
      return 'chat-circle';
    case 'skill':
      return 'sparkle';
    case 'vendorPlugin':
      return 'puzzle-piece';
    case 'workflow':
      return WORKFLOW_BLOCK_KIND_GLYPH.workflow;
    case 'widget':
      return 'squares-four';
    case 'attachment':
      return input.glyph ? resolvePluginUiIconName(input.glyph) : 'file';
    case 'composerReference':
      return input.glyph ? resolvePluginUiIconName(input.glyph) : 'at';
    default:
      // A caller's own citation (a plugin's Markdown scheme) leads with a glyph only when it names one.
      return input.glyph ? resolvePluginUiIconName(input.glyph) : null;
  }
}
