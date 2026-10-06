import { ComposerContentDisplayNameV1Schema, ComposerContentHandleV1Schema, ComposerContentMediaKindV1Schema, ComposerContentMimeTypeV1Schema } from '@happier-dev/protocol/runtime/input/composerContentV1';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { SessionExecutionTargetV1Schema } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import { SessionAttachmentUploadInitRequestV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentUploadInitRequestV1';
import { z } from 'zod';

import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

const directTransferImportOpenCommonFields = {
  workingDirectory: z.string().min(1),
  additionalAllowedWriteDirs: z.array(z.string().min(1)).optional(),
  sessionRpcTransferMaxBytes: z.number().int().nonnegative().nullable().optional(),
};

const ComposerMediaStageUploadOpenRequestSchema = z
  .object({
    ...directTransferImportOpenCommonFields,
    t: z.literal('composer_media_stage_upload_v1'),
    executionTarget: SessionExecutionTargetV1Schema,
    owner: asHostProtocolZod(PluginContributionIdentityV1Schema),
    mediaKind: ComposerContentMediaKindV1Schema,
    mimeType: ComposerContentMimeTypeV1Schema,
    name: ComposerContentDisplayNameV1Schema,
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/iu),
  })
  .strict()
  .superRefine((value, context) => {
    const canonical = ComposerContentHandleV1Schema.safeParse({
      v: 1,
      id: 'direct-import-request',
      executionTarget: value.executionTarget,
      owner: value.owner,
      mediaKind: value.mediaKind,
      mimeType: value.mimeType,
      name: value.name,
      sizeBytes: value.sizeBytes,
      sha256: value.sha256,
    });
    if (!canonical.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid Composer media stage upload request',
      });
    }
  });

export const DirectTransferImportOpenRequestSchema = z.discriminatedUnion('t', [
    z.object({
      ...directTransferImportOpenCommonFields,
      t: z.literal('session_file_upload_v1'),
      path: z.unknown(),
      sizeBytes: z.unknown(),
      overwrite: z.unknown(),
      sha256: z.unknown().optional(),
    }).strict(),
    SessionAttachmentUploadInitRequestV1Schema.extend(directTransferImportOpenCommonFields),
    z.object({
      ...directTransferImportOpenCommonFields,
      t: z.literal('prompt_asset_upload_v1'),
      sizeBytes: z.unknown(),
    }).strict(),
    ComposerMediaStageUploadOpenRequestSchema,
  ]);
