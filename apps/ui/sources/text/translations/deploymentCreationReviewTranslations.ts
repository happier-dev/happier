import type { SupportedLanguage } from '../_all';

/**
 * What a new Environment takes from the creation defaults, and where each value came from. One copy for every
 * review that shows the canonical resolver's values and sources (the Environment draft and the Store App).
 */
export type DeploymentCreationReviewCopy = Readonly<{
  title: string;
  description: string;
  create: string;
  createCopy: string;
  reviewAndCreateCopy: string;
  buildsOn: (params: { machine: string }) => string;
  deploysFrom: (params: { machine: string }) => string;
  keepsPrevious: (params: { count: number }) => string;
  fromExplicit: string;
  fromProject: string;
  fromAccount: string;
  fromBuiltin: string;
}>;

export const deploymentCreationReviewTranslations = {
  en: {
    title: 'How it deploys',
    description:
      'Check these before you create it.',
    create: 'Create environment',
    createCopy: 'Create copy',
    reviewAndCreateCopy: 'Review and create copy',
    buildsOn: ({ machine }) => `Builds on ${machine}`,
    deploysFrom: ({ machine }) => `Deploys run from ${machine}`,
    keepsPrevious: ({ count }) =>
      count === 0
        ? 'Keeps no previous versions for rollback'
        : count === 1
          ? 'Keeps 1 previous version for rollback'
          : `Keeps ${count} previous versions for rollback`,
    fromExplicit: 'You chose this',
    fromProject: 'From the project',
    fromAccount: 'From your Account',
    fromBuiltin: 'Happier’s default',
  },
} satisfies Pick<Record<SupportedLanguage, DeploymentCreationReviewCopy>, 'en'>;
