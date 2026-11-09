import { describe, expect, it } from 'vitest';

import { ComposerContentHandleV1Schema, ComposerContentClaimRequestV1Schema, ComposerContentClaimResponseV1Schema } from './composerContentV1.js';

describe('composer content V1', () => {
  it.each(['webm', 'mp4'])('admits %s video handles while refusing image/video MIME mismatches', (format) => {
    const handle = { v: 1, id: 'video-stage', executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      owner: { pluginId: 'acme.media', localId: 'video' }, mediaKind: 'video', mimeType: `video/${format}`,
      name: `recording.${format}`, sizeBytes: 24, sha256: 'a'.repeat(64) };
    expect(ComposerContentHandleV1Schema.safeParse(handle).success).toBe(true);
    expect(ComposerContentHandleV1Schema.safeParse({ ...handle, mediaKind: 'image' }).success).toBe(false);
  });
  it('loads and validates a target-bound staged-content handle at its leaf boundary', () => {
    const handle = {
      v: 1,
      id: 'stage-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      owner: { pluginId: 'acme.media', localId: 'image' },
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'hero.png',
      sizeBytes: 42,
      sha256: 'a'.repeat(64),
    } as const;

    expect(ComposerContentHandleV1Schema.safeParse(handle).success).toBe(true);
    expect(ComposerContentHandleV1Schema.safeParse({
      ...handle,
      executionTarget: { ...handle.executionTarget, hostName: 'untrusted' },
    }).success).toBe(false);
    const claimant = { composer: { kind: 'session', sessionId: 'source-session' }, attachmentInstanceId: 'attachment-1' } as const;
    const submission = { destinationComposerRef: { kind: 'session', sessionId: 'destination-session' }, messageLocalId: 'ask-1' } as const;
    expect(ComposerContentClaimRequestV1Schema.parse({ handle, claimant })).toEqual({ handle, claimant });
    expect(ComposerContentClaimRequestV1Schema.parse({ handle, claimant, submission })).toEqual({ handle, claimant, submission });
    for (const input of [
      { handle, claimant, submission, sourceIsSubmissionSnapshot: true },
      { handle, claimant: { ...claimant, sourceIsSubmissionSnapshot: true }, submission },
      { handle, claimant, submission: { ...submission, sourceIsSubmissionSnapshot: true } },
      { handle, claimant, submission: { ...submission, messageLocalId: ' ' } },
    ]) expect(ComposerContentClaimRequestV1Schema.safeParse(input).success).toBe(false);
    expect(ComposerContentClaimResponseV1Schema.parse({ success: true, newlyAcquired: false }))
      .toEqual({ success: true, newlyAcquired: false });
    expect(ComposerContentClaimResponseV1Schema.parse({ success: true, newlyAcquired: true, handle }))
      .toEqual({ success: true, newlyAcquired: true, handle });
  });
});
