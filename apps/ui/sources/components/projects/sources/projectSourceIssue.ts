import { t } from '@/text';

/** What a Source's issue tells the person (its page banner, and Deploy an app when saving a pasted repository). */
export function presentProjectSourceIssue(
  issue: string | null,
  homeName: string,
): Readonly<{
  title: string;
  description?: string;
  tone: 'warning' | 'neutral' | 'danger';
}> | null {
  switch (issue) {
    case null:
      return null;
    case 'source_unavailable':
      return {
        title: t('projects.sources.unavailable'),
        description: t('projects.sources.unavailableBody'),
        tone: 'neutral',
      };
    case 'source_access_denied':
    case 'action_forbidden':
      return {
        title: t('errors.permissionDenied'),
        tone: 'warning',
      };
    case 'outcome_unknown':
      return {
        title: t('projects.sources.outcomeUnknown'),
        description: t('projects.sources.outcomeUnknownBody'),
        tone: 'warning',
      };
    case 'home_unreachable':
      return {
        title: t('projects.sources.offline', { home: homeName }),
        tone: 'warning',
      };
    case 'source_backend_unavailable':
      return {
        title: t('projects.sources.backendUnavailable'),
        tone: 'neutral',
      };
    case 'source_invalid':
      return { title: t('projects.sources.addressInvalid'), tone: 'warning' };
    case 'source_conflict':
      return null;
    default:
      return { title: t('projects.sources.saveFailed'), tone: 'warning' };
  }
}
