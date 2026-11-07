import type { SessionStateReadV1, PluginTranslate } from '@happier-dev/plugin-ui';

/**
 * A linked Session's name for a label. Labels consume the public host title; relationship records never name a
 * Session. A read that has not settled, or cannot reach the Session, does not know its title, and unknown is not
 * untitled: only a Session the host actually read, and found untitled, says "Untitled session".
 */
export function readTriageSessionTitle(
  read: SessionStateReadV1 | undefined,
  text: PluginTranslate,
): string {
  if (read?.state === null || read === undefined) {
    return text('plugins.triage.surface.detail.session.picker', 'Linked session');
  }
  return read.state.title?.trim() || text('session.untitled', 'Untitled session');
}
