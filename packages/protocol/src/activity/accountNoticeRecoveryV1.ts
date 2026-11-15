import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ArtifactRevisionV1Schema } from '../artifacts/artifactRevisionV1.js';
import { DeploymentRollbackInputV1Schema } from '../deployments/deploymentActionsV1.js';
import { DeploymentBackupRunInputV1Schema } from '../deployments/deploymentBackupActionsV1.js';
import { DeploymentRestartInputV1Schema } from '../deployments/deploymentRestartV1.js';
import { defineStoredReadProjection } from '../json/storedReadSchema.js';

/** A notice reference is data; Account admission and fresh C1 custody own dismissal. */
export const AccountNoticeDismissInputV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: z.string().check(z.minLength(1)),
  expectedRevision: z.optional(ArtifactRevisionV1Schema),
}));
export type AccountNoticeDismissInputV1 = z.infer<typeof AccountNoticeDismissInputV1Schema>;
export const AccountNoticeDismissResultV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: z.string().check(z.minLength(1)), status: z.enum(['dismissed', 'unchanged']),
}));

/** Recovery offers restore-and-rollback, code-only rollback, or keep-and-fix-forward. */
export const AccountNoticeRecoveryChoiceV1Schema = lazyZodSchema(() => z.discriminatedUnion('actionId', [
  z.strictObject({ actionId: z.literal('deployments.rollback'), input: DeploymentRollbackInputV1Schema,
    label: z.string().check(z.minLength(1)) }),
  z.strictObject({ actionId: z.literal('inbox.notice.dismiss'), input: AccountNoticeDismissInputV1Schema,
    label: z.string().check(z.minLength(1)) }),
  z.strictObject({ actionId: z.literal('deployments.backups.run'), input: DeploymentBackupRunInputV1Schema,
    label: z.string().check(z.minLength(1)) }),
  z.strictObject({ actionId: z.literal('deployments.restart'), input: DeploymentRestartInputV1Schema,
    label: z.string().check(z.minLength(1)) }),
]));
export type AccountNoticeRecoveryChoiceV1 = z.infer<typeof AccountNoticeRecoveryChoiceV1Schema>;
defineStoredReadProjection(AccountNoticeRecoveryChoiceV1Schema, () => AccountNoticeRecoveryChoiceV1Schema);
export const AccountNoticeRecoveryChoicesV1Schema = lazyZodSchema(() => z.array(AccountNoticeRecoveryChoiceV1Schema)
  .check(z.minLength(1), z.maxLength(3)));
