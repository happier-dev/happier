import type {
  ManagedLocalServiceRunAttachmentMarkerOwnership,
  ManagedLocalServiceRunAttachmentV1,
} from '../sessionRegistry';

export type ManagedMarkerAttachmentClearResult =
  'cleared' | 'already_absent' | 'mismatch';

export async function clearPromotedManagedLocalServiceMarkerAttachment(
  params: Readonly<{
    toPid: number;
    ownership:
      ManagedLocalServiceRunAttachmentMarkerOwnership;
    canonicalSessionId: string | null;
    attachment: ManagedLocalServiceRunAttachmentV1;
    clear: (input: Readonly<{
      pid: number;
      ownership:
        ManagedLocalServiceRunAttachmentMarkerOwnership;
      attachment: ManagedLocalServiceRunAttachmentV1;
    }>) => Promise<ManagedMarkerAttachmentClearResult>;
  }>,
): Promise<boolean> {
  if (params.canonicalSessionId) {
    const canonical = await params.clear({
      pid: params.toPid,
      ownership: {
        ...params.ownership,
        happySessionId: params.canonicalSessionId,
      },
      attachment: params.attachment,
    });
    if (canonical !== 'mismatch') return true;
  }
  return await params.clear({
    pid: params.toPid,
    ownership: params.ownership,
    attachment: params.attachment,
  }) !== 'mismatch';
}
