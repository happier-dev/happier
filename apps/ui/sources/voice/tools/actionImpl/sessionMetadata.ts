import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';

import { normalizeNonEmptyString } from './shared';
import type { SessionMetadataLike } from '@/sync/domains/session/listing/sessionListLookupState';

export function resolveVoiceSessionSharedTitleFromMetadata(metadata: SessionMetadataLike): string | null {
  const summary = metadata && typeof metadata === 'object' && metadata.summary && typeof metadata.summary === 'object'
    ? normalizeNonEmptyString((metadata.summary as { text?: unknown }).text)
    : null;
  const summaryText = metadata && typeof metadata === 'object'
    ? normalizeNonEmptyString(metadata.summaryText)
    : null;
  return summary ?? summaryText;
}

export function resolveVoiceSessionTitleFromMetadata(metadata: SessionMetadataLike): string | null {
  const summary = resolveVoiceSessionSharedTitleFromMetadata(metadata);
  const name = metadata && typeof metadata === 'object'
    ? normalizeNonEmptyString(metadata.name)
    : null;
  // A no-folder session's private folder is not a name or a place.
  const withoutFolder = readSessionDirectoryKind(metadata) === 'managed';
  const path = metadata && typeof metadata === 'object' && !withoutFolder
    ? normalizeNonEmptyString(metadata.path)
    : null;
  const pathLabel = path ? normalizeNonEmptyString(path.split('/').filter(Boolean).at(-1)) : null;

  return summary ?? name ?? pathLabel;
}

export function resolveVoiceSessionLocationLabelFromMetadata(metadata: SessionMetadataLike): string | null {
  const path = metadata && typeof metadata === 'object' && readSessionDirectoryKind(metadata) !== 'managed'
    ? normalizeNonEmptyString(metadata.path)
    : null;
  if (!path) return null;

  const homeDir = metadata && typeof metadata === 'object'
    ? normalizeNonEmptyString(metadata.homeDir) ?? undefined
    : undefined;
  const displayPath = formatSessionPath(path, homeDir).trim();
  if (displayPath === '~') return '~';

  const withoutTrailingSlash = displayPath.replace(/\/+$/, '');
  const tail = withoutTrailingSlash.split('/').filter(Boolean).at(-1);
  return normalizeNonEmptyString(tail ?? withoutTrailingSlash);
}
