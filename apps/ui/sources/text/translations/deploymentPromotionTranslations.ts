import type { SupportedLanguage } from '../_all';

export type PromotionCopy = Readonly<{
  open: string; title: string; lead: (params: { name: string; version: string }) => string;
  destination: string; image: string; imageBody: string;
  emptyTitle: string; emptyBody: string; loadFailed: string; refused: string; review: string;
  missingOne: (params: { destination: string; name: string }) => string;
  missingMany: (params: { destination: string; count: number }) => string;
  missingBodyOne: (params: { source: string; destination: string }) => string;
  missingBodyMany: (params: { source: string; destination: string }) => string;
  missingAdd: (params: { destination: string }) => string;
  compareFailed: (params: { destination: string }) => string;
}>;

export const deploymentPromotionTranslations = {
  en: {
    open: 'Promote to…', title: 'Promote deployment', lead: ({ name, version }) => `Choose where to deploy ${version} from ${name}.`,
    destination: 'Destination', image: 'Built artifact', imageBody: 'Reuse the images from this stored Compose deployment in another stored Compose environment on your servers.',
    emptyTitle: 'Choose another environment',
    emptyBody: 'Create or link a destination environment, then try again.', loadFailed: 'Couldn’t load environments', refused: 'Couldn’t promote', review: 'Review promotion',
    missingOne: ({ destination, name }) => `${destination} doesn’t set ${name}`, missingMany: ({ destination, count }) => `${destination} doesn’t set ${count} variables`,
    missingBodyOne: ({ source, destination }) => `${source} sets it. Add it to ${destination} first if this version reads it.`,
    missingBodyMany: ({ source, destination }) => `${source} sets them. Add them to ${destination} first if this version reads them.`,
    missingAdd: ({ destination }) => `Add to ${destination}…`, compareFailed: ({ destination }) => `Couldn’t compare variables with ${destination}`,
  },
} satisfies Pick<Record<SupportedLanguage, PromotionCopy>, 'en'>;
