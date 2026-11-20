import { t } from '@/text';

/**
 * What a stepped Review says after Create saved the Environment and the platform then refused its resource
 * (journey-deploy revFail). Pure: the draft passes what it asked the platform to do and the refusal it got.
 * Creating a resource and linking one that already exists are different requests and are named as such.
 */
export function describeDeploymentPlatformRefusal(
  input: Readonly<{
    platform: string;
    resource: 'create' | 'existing';
    code: string;
    cause?: Readonly<{ httpStatus?: number | null; errorCode?: string | null }>;
  }>,
): Readonly<{
  title: string;
  description: string;
  row: string;
  /** The description names this cause itself; otherwise a shared failure reason may replace it. */
  specific: boolean;
}> {
  const { platform } = input;
  if (input.resource === 'existing') {
    // The reason (already linked or otherwise) is the shared recovery owner's sentence for the refusal code.
    return {
      title: t('newApp.deploy.plan.platformLinkRefusedTitle', { platform }),
      description: t('newApp.deploy.plan.platformLinkRefused', { platform }),
      row: input.code === 'provider_scope_already_linked'
        ? t('newApp.deploy.plan.alreadyLinked')
        : t('newApp.deploy.plan.linkRefusedRow'),
      specific: false,
    };
  }
  // The platform answered 409 to the project it was asked to create: its name is taken (Vercel, Cloudflare Pages).
  const nameTaken =
    input.cause !== undefined &&
    (input.cause.httpStatus === 409 || input.cause.errorCode === 'conflict');
  return {
    title: t('newApp.deploy.plan.platformRefusedTitle', { platform }),
    description: nameTaken
      ? t('newApp.deploy.plan.platformNameTaken', { platform })
      : t('newApp.deploy.plan.platformRefused', { platform }),
    row: nameTaken
      ? t('newApp.deploy.plan.nameTaken')
      : t('newApp.deploy.plan.refusedRow'),
    specific: nameTaken,
  };
}
