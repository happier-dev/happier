import { z } from 'zod/mini';
import { BackendTargetKeyV2InputSchema } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionDraftAddressV1Schema } from '@happier-dev/protocol/drafts/sessionDrafts';

/** The input schema also admits the predecessor's bundled-Agent key spelling. */
export const NewSessionAgentPickerViewV1Schema = z.nullable(z.union([
    z.object({ kind: z.literal('backend'), backendTargetKey: BackendTargetKeyV2InputSchema }),
    z.object({ kind: z.literal('favoriteModels') }),
]));
export type NewSessionAgentPickerViewV1 = z.infer<typeof NewSessionAgentPickerViewV1Schema>;

export const NewSessionOrdinaryEntryDraftIdSchema = z.string().check(z.refine(
    draftId => SessionDraftAddressV1Schema.safeParse({ kind: 'newSession', draftId }).success,
    'Expected a canonical new-session draft UUID',
));
