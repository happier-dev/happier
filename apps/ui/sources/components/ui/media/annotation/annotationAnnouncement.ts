import { t } from '@/text';

import type { AnnotationAnnouncement } from './types';

/** The words for what a Tab or an undo just did (D5: the mark's kind, its number, its colour). */
export function annotationAnnouncementText(announcement: AnnotationAnnouncement): string {
  if (announcement.kind === 'undo') return t('files.annotate.undo');
  if (announcement.kind === 'redo') return t('files.annotate.redo');
  const { mark } = announcement;
  if (!mark) return '';
  const kind = mark.kind === 'element' ? t('files.annotate.tools.element') : t(`files.annotate.tools.${mark.kind}` as const);
  return [kind, mark.stepNumber, mark.color ? t(`files.annotate.colours.${mark.color}` as const) : null]
    .filter((part) => part !== null && part !== undefined)
    .join(', ');
}
