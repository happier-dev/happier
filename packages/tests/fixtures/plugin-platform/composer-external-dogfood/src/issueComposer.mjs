/**
 * @param {import('@happier-dev/plugin-ui').ComposersService} composers
 * @param {string} sessionId
 * @param {string} issueId
 */
export async function attachIssueWithoutControl(composers, sessionId, issueId) {
  const composer = await composers.get({ kind: 'session', sessionId });
  if (!composer) return { status: 'unavailable' };

  const read = await composer.read();
  if (read.status !== 'ready') return read;

  return await composer.apply({
    expectedRevision: read.snapshot.revision,
    operations: [{
      kind: 'attachment.add',
      attachmentLocalId: 'issue',
      value: createIssueAttachmentAuthorValue(issueId),
    }],
  });
}

/**
 * Stage and attach one image through the mounted public Composer facade.
 * The opaque handle is passed unchanged into the canonical attachment operation;
 * author code never supplies target, owner, digest, path, or transfer identity.
 *
 * @param {import('@happier-dev/plugin-ui').ComposersService} composers
 * @param {string} issueId
 */
export async function attachIssueMediaFromCurrentComposer(composers, issueId) {
  const composer = composers.current();
  if (!composer) return { status: 'unavailable' };

  const handle = await composer.content.pickMedia({
    attachmentLocalId: 'issue-media',
    kinds: ['image'],
  });
  let attached = false;
  try {
    await composer.content.inspect(handle, { offset: 0, maxBytes: 64 });
    const read = await composer.read();
    if (read.status !== 'ready' || !read.snapshot.capabilities.attachments) return read;

    const result = await composer.apply({
      expectedRevision: read.snapshot.revision,
      operations: [{
        kind: 'attachment.add',
        attachmentLocalId: 'issue-media',
        value: createIssueMediaAttachmentAuthorValue(issueId),
        content: Object.freeze({
          kind: 'stagedMedia',
          handle,
        }),
      }],
    });
    attached = result.status === 'applied';
    return result;
  } finally {
    if (!attached) await composer.content.release(handle);
  }
}

/**
 * Queue contentless media so the host-bound attachment preparation invocation
 * exercises the daemon public `services.composerContent.stageMedia` seam.
 *
 * @param {import('@happier-dev/plugin-ui').ComposersService} composers
 * @param {string} issueId
 */
export async function attachDaemonIssueMediaFromCurrentComposer(composers, issueId) {
  const composer = composers.current();
  if (!composer) return { status: 'unavailable' };

  const read = await composer.read();
  if (read.status !== 'ready' || !read.snapshot.capabilities.attachments) return read;
  return await composer.apply({
    expectedRevision: read.snapshot.revision,
    operations: [{
      kind: 'attachment.add',
      attachmentLocalId: 'issue-media',
      value: createIssueMediaAttachmentAuthorValue(issueId),
    }],
  });
}

/**
 * Exercise explicit release of an unattached stage through the same mounted
 * public handle. The fixture deliberately owns no side cache or transfer id.
 *
 * @param {import('@happier-dev/plugin-ui').ComposersService} composers
 */
export async function inspectAndReleaseIssueMediaFromCurrentComposer(composers) {
  const composer = composers.current();
  if (!composer) return { status: 'unavailable' };

  const handle = await composer.content.pickMedia({
    attachmentLocalId: 'issue-media',
    kinds: ['image'],
  });
  try {
    return await composer.content.inspect(handle, { offset: 0, maxBytes: 64 });
  } finally {
    await composer.content.release(handle);
  }
}

/** @param {string} issueId */
export function createIssueAttachmentAuthorValue(issueId) {
  return Object.freeze({
    key: `issue:${issueId}`,
    value: Object.freeze({ issueId }),
    presentation: Object.freeze({
      label: `Issue ${issueId}`,
      description: 'External issue selected from the Composer picker.',
      icon: 'error',
      tone: 'warning',
    }),
  });
}

/**
 * @param {string} issueId
 * @returns {import('@happier-dev/plugin-sdk/ui').ComposerAttachmentAuthorValueV1}
 */
export function createIssueMediaAttachmentAuthorValue(issueId) {
  return Object.freeze({
    key: `issue-media:${issueId}`,
    value: Object.freeze({ issueId }),
    presentation: Object.freeze({
      label: `Image evidence for Issue ${issueId}`,
      description: 'Portable external issue evidence selected through the Composer media picker.',
      icon: 'preview',
      tone: 'info',
    }),
  });
}
