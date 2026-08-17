import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
} from '@happier-dev/plugin-sdk/testing';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  ComposerAttachmentViewV1,
  ComposerReadResultV1,
  ComposerSnapshotV1,
  RenderContext,
} from '@happier-dev/plugin-sdk/ui';
import { act, cloneElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderComposerIssueSurface } from '../../../tests/fixtures/plugin-platform/composer-external-dogfood/src/issueSurface.mjs';
import { createPluginUiRnwSemanticSurfaceAdapter } from './rnwSemanticAdapter.testSupport.js';

const composer = {
  kind: 'session',
  sessionId: 'external-composer-session',
} as const;

const stagedMediaHandle = Object.freeze({
  v: 1 as const,
  id: 'external-stage-42',
  executionTarget: Object.freeze({
    serverId: 'external-server',
    machineId: 'external-machine',
  }),
  owner: Object.freeze({
    pluginId: 'acme.composer.issue-dogfood',
    localId: 'issue-media',
  }),
  mediaKind: 'image' as const,
  mimeType: 'image/png' as const,
  name: 'issue-evidence.png',
  sizeBytes: 4,
  sha256: 'a'.repeat(64),
});

function renderWithMountedComposer(
  composerRef: ComposerSnapshotV1['ref'] | null,
) {
  return (context: RenderContext) => cloneElement(
    renderComposerIssueSurface(context) as ReactElement<Record<string, unknown>>,
    { composerRef },
  );
}

const attachment = Object.freeze({
  v: 1 as const,
  instanceId: 'external-issue-instance',
  attachment: Object.freeze({
    pluginId: 'acme.composer.issue-dogfood',
    localId: 'issue',
  }),
  key: 'issue:EXT-42',
  value: Object.freeze({ issueId: 'EXT-42' }),
  presentation: Object.freeze({
    typeLabel: 'Issue',
    label: 'Issue EXT-42',
    description: 'External issue selected from the Composer picker.',
    icon: 'error' as const,
    tone: 'warning' as const,
  }),
  availability: Object.freeze({ status: 'ready' as const }),
} satisfies ComposerAttachmentViewV1);

const foreignAttachment = Object.freeze({
  ...attachment,
  instanceId: 'foreign-issue-instance',
  attachment: Object.freeze({
    pluginId: 'acme.foreign.issue-dogfood',
    localId: 'issue',
  }),
  key: 'foreign:EXT-42',
  presentation: Object.freeze({
    ...attachment.presentation,
    label: 'Foreign issue',
  }),
} satisfies ComposerAttachmentViewV1);

const unavailableAttachment = Object.freeze({
  ...attachment,
  instanceId: 'external-unavailable-issue-instance',
  key: 'issue:EXT-84',
  value: Object.freeze({ issueId: 'EXT-84' }),
  presentation: Object.freeze({
    ...attachment.presentation,
    label: 'Issue EXT-84',
  }),
  availability: Object.freeze({
    status: 'unavailable' as const,
    reason: 'The external issue is temporarily unavailable.',
  }),
} satisfies ComposerAttachmentViewV1);

function snapshot(
  attachments: readonly ComposerAttachmentViewV1[] = [],
  ref: ComposerSnapshotV1['ref'] = composer,
): ComposerSnapshotV1 {
  return {
    revision: 17,
    ref,
    text: '',
    references: [],
    attachments: [...attachments],
    layout: 'wrap' as const,
    capabilities: Object.freeze({
      text: true as const,
      references: true,
      attachments: true,
      submit: true,
    }),
    state: Object.freeze({
      focused: true,
      editable: true,
      submittable: true,
      submitting: false,
      running: false,
    }),
  };
}

function identity(generation: string) {
  return Object.freeze({
    pluginId: 'acme.composer.issue-dogfood',
    pluginVersion: '0.0.0',
    viewId: 'issue-surface',
    generation,
    sessionId: composer.sessionId,
  });
}

async function createCompactFixture(
  generation: string,
  readOutcome: () => Promise<ComposerReadResultV1>,
  watchOutcome: () => Promise<void> = async () => undefined,
) {
  const readComposer = vi.fn(async () => await readOutcome());
  const watchComposer = vi.fn(async () => await watchOutcome());
  const fixture = await createPluginUiTestkit({
    identity: identity(generation),
    surface: renderWithMountedComposer(composer),
    surfaceContext: createSurfaceContextFixture(),
    launchInput: {
      v: 1,
      role: 'controlCompact',
      controlLocalId: 'issue-control',
      state: {},
    },
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: { readComposer, watchComposer },
  });
  return { fixture, readComposer, watchComposer };
}

describe('external Composer dogfood surface', () => {
  it('derives only its own zero, one, and many compact presentation from the watched Composer snapshot', async () => {
    const zero = await createCompactFixture(
      'compact-zero-generation',
      async () => ({ status: 'ready', snapshot: snapshot() }),
    );
    try {
      await expect(zero.fixture.findByRole('status', { name: 'Issue' })).resolves.toEqual({
        role: 'status',
        name: 'Issue',
      });
      expect(zero.readComposer).toHaveBeenCalledWith(expect.objectContaining({
        ref: composer,
        signal: expect.any(AbortSignal),
      }));
      expect(zero.watchComposer).toHaveBeenCalledWith(expect.objectContaining({
        ref: composer,
        signal: expect.any(AbortSignal),
      }));
      expect(zero.watchComposer.mock.invocationCallOrder[0]).toBeLessThan(
        zero.readComposer.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    } finally {
      await zero.fixture.dispose();
    }

    const one = await createCompactFixture(
      'compact-one-generation',
      async () => ({ status: 'ready', snapshot: snapshot([foreignAttachment, attachment]) }),
    );
    try {
      await expect(one.fixture.findByRole('status', { name: 'Issue EXT-42' })).resolves.toEqual({
        role: 'status',
        name: 'Issue EXT-42',
      });
      await expect(one.fixture.queryByRole('status', { name: 'Foreign issue' })).resolves.toBeUndefined();
    } finally {
      await one.fixture.dispose();
    }

    const many = await createCompactFixture(
      'compact-many-generation',
      async () => ({
        status: 'ready',
        snapshot: snapshot([foreignAttachment, attachment, unavailableAttachment]),
      }),
    );
    try {
      await expect(many.fixture.findByRole('status', { name: '2 issues' })).resolves.toEqual({
        role: 'status',
        name: '2 issues',
      });
    } finally {
      await many.fixture.dispose();
    }
  });

  it('keeps the static declaration presentation while the Composer is loading, unavailable, or fails', async () => {
    let resolveLoadingRead: ((result: ComposerReadResultV1) => void) | undefined;
    const loading = await createCompactFixture(
      'compact-loading-generation',
      async () => await new Promise<ComposerReadResultV1>((resolve) => {
        resolveLoadingRead = resolve;
      }),
    );
    try {
      await expect(loading.fixture.findByRole('status', { name: 'Issue' })).resolves.toEqual({
        role: 'status',
        name: 'Issue',
      });
      resolveLoadingRead?.({ status: 'ready', snapshot: snapshot([attachment]) });
    } finally {
      await loading.fixture.dispose();
    }

    const unavailable = await createCompactFixture(
      'compact-unavailable-generation',
      async () => ({ status: 'unavailable', reason: 'scopeClosed' }),
    );
    try {
      await expect(unavailable.fixture.findByRole('status', { name: 'Issue' })).resolves.toEqual({
        role: 'status',
        name: 'Issue',
      });
    } finally {
      await unavailable.fixture.dispose();
    }

    const failed = await createCompactFixture(
      'compact-failed-generation',
      async () => {
        throw new PluginError({ code: 'transport_unavailable' });
      },
    );
    try {
      await expect(failed.fixture.findByRole('status', { name: 'Issue' })).resolves.toEqual({
        role: 'status',
        name: 'Issue',
      });
    } finally {
      await failed.fixture.dispose();
    }

    const observationFailed = await createCompactFixture(
      'compact-observation-failed-generation',
      async () => ({ status: 'ready', snapshot: snapshot([attachment]) }),
      async () => {
        throw new PluginError({ code: 'transport_unavailable' });
      },
    );
    try {
      await expect(observationFailed.fixture.findByRole('status', { name: 'Issue' })).resolves.toEqual({
        role: 'status',
        name: 'Issue',
      });
    } finally {
      await observationFailed.fixture.dispose();
    }
  });

  it('drives picker selection through the public Composer facade and immutable fallback input', async () => {
    const readComposer = vi.fn(async () => ({ status: 'ready' as const, snapshot: snapshot() }));
    const applyComposer = vi.fn(async () => ({
      status: 'applied' as const,
      revision: 18,
      attachmentInstanceIds: [attachment.instanceId],
    }));
    const fixture = await createPluginUiTestkit({
      identity: identity('picker-generation-1'),
      surface: renderWithMountedComposer(composer),
      surfaceContext: createSurfaceContextFixture(),
      launchInput: {
        v: 1,
        role: 'attachmentPicker',
        attachmentLocalId: 'issue',
        instances: [],
      },
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { readComposer, applyComposer },
    });

    try {
      const issueChoice = await fixture.getByRole('option', {
        name: 'Attach Issue EXT-42',
      });
      await fixture.press(issueChoice);

      await expect(fixture.findByRole('status', {
        name: 'Attached Issue EXT-42',
      })).resolves.toEqual({
        role: 'status',
        name: 'Attached Issue EXT-42',
      });
      expect(readComposer).toHaveBeenCalledWith(expect.objectContaining({
        ref: composer,
        signal: expect.any(AbortSignal),
      }));
      expect(applyComposer).toHaveBeenCalledWith(expect.objectContaining({
        ref: composer,
        transaction: {
          expectedRevision: 17,
          operations: [{
            kind: 'attachment.add',
            attachmentLocalId: 'issue',
            value: {
              key: 'issue:EXT-42',
              value: { issueId: 'EXT-42' },
              presentation: {
                label: 'Issue EXT-42',
                description: 'External issue selected from the Composer picker.',
                icon: 'error',
                tone: 'warning',
              },
            },
          }],
        },
        signal: expect.any(AbortSignal),
      }));
    } finally {
      await fixture.dispose();
    }
  });

  it('uses the mounted public Composer content facade for pick, inspect, and explicit release', async () => {
    const pickComposerMedia = vi.fn(async () => stagedMediaHandle);
    const inspectComposerContent = vi.fn(async () => ({
      offset: 0,
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      eof: true,
    }));
    const releaseComposerContent = vi.fn(async () => undefined);
    const fixture = await createPluginUiTestkit({
      identity: identity('picker-media-generation-1'),
      surface: renderWithMountedComposer(composer),
      surfaceContext: createSurfaceContextFixture(),
      launchInput: {
        v: 1,
        role: 'attachmentPicker',
        attachmentLocalId: 'issue-media',
        instances: [],
      },
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        pickComposerMedia,
        inspectComposerContent,
        releaseComposerContent,
      },
    });

    try {
      await fixture.press(await fixture.getByRole('option', {
        name: 'Inspect and release image evidence',
      }));
      await vi.waitFor(() => {
        expect(pickComposerMedia).toHaveBeenCalledWith(expect.objectContaining({
          ref: composer,
          request: { attachmentLocalId: 'issue-media', kinds: ['image'] },
          signal: expect.any(AbortSignal),
        }));
      });
      expect(inspectComposerContent).toHaveBeenCalledWith(expect.objectContaining({
        handle: stagedMediaHandle,
        request: { offset: 0, maxBytes: 64 },
        signal: expect.any(AbortSignal),
      }));
      expect(releaseComposerContent).toHaveBeenCalledWith(expect.objectContaining({
        handle: stagedMediaHandle,
        signal: expect.any(AbortSignal),
      }));
      await expect(fixture.findByRole('status', {
        name: 'Released staged image evidence',
      })).resolves.toEqual({
        role: 'status',
        name: 'Released staged image evidence',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('queues daemon-origin media as contentless input for the attachment runtime', async () => {
    const readComposer = vi.fn(async () => ({ status: 'ready' as const, snapshot: snapshot() }));
    const applyComposer = vi.fn(async () => ({
      status: 'applied' as const,
      revision: 18,
      attachmentInstanceIds: ['external-daemon-media'],
    }));
    const fixture = await createPluginUiTestkit({
      identity: identity('picker-daemon-media-generation-1'),
      surface: renderWithMountedComposer(composer),
      surfaceContext: createSurfaceContextFixture(),
      launchInput: {
        v: 1,
        role: 'attachmentPicker',
        attachmentLocalId: 'issue-media',
        instances: [],
      },
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { readComposer, applyComposer },
    });

    try {
      await fixture.press(await fixture.getByRole('option', {
        name: 'Attach daemon-origin image evidence for Issue EXT-84',
      }));
      await vi.waitFor(() => {
        expect(applyComposer).toHaveBeenCalledWith(expect.objectContaining({
          ref: composer,
          transaction: {
            expectedRevision: 17,
            operations: [{
              kind: 'attachment.add',
              attachmentLocalId: 'issue-media',
              value: {
                key: 'issue-media:EXT-84',
                value: { issueId: 'EXT-84' },
                presentation: {
                  label: 'Image evidence for Issue EXT-84',
                  description: 'Portable external issue evidence selected through the Composer media picker.',
                  icon: 'preview',
                  tone: 'info',
                },
              },
            }],
          },
          signal: expect.any(AbortSignal),
        }));
      });
      await expect(fixture.findByRole('status', {
        name: 'Queued daemon-origin image evidence for Issue EXT-84',
      })).resolves.toEqual({
        role: 'status',
        name: 'Queued daemon-origin image evidence for Issue EXT-84',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('passes the host-issued opaque handle unchanged through the staged attachment path', async () => {
    const readComposer = vi.fn(async () => ({ status: 'ready' as const, snapshot: snapshot() }));
    const applyComposer = vi.fn(async () => ({
      status: 'applied' as const,
      revision: 18,
      attachmentInstanceIds: ['external-media-instance'],
    }));
    const pickComposerMedia = vi.fn(async () => stagedMediaHandle);
    const inspectComposerContent = vi.fn(async () => ({
      offset: 0,
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      eof: true,
    }));
    const releaseComposerContent = vi.fn(async () => undefined);
    const fixture = await createPluginUiTestkit({
      identity: identity('picker-staged-attachment-generation-1'),
      surface: renderWithMountedComposer(composer),
      surfaceContext: createSurfaceContextFixture(),
      launchInput: {
        v: 1,
        role: 'attachmentPicker',
        attachmentLocalId: 'issue-media',
        instances: [],
      },
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        readComposer,
        applyComposer,
        pickComposerMedia,
        inspectComposerContent,
        releaseComposerContent,
      },
    });

    try {
      await fixture.press(await fixture.getByRole('option', {
        name: 'Attach image evidence for Issue EXT-42',
      }));
      await vi.waitFor(() => {
        expect(applyComposer).toHaveBeenCalledWith(expect.objectContaining({
          ref: composer,
          transaction: {
          expectedRevision: 17,
          operations: [{
            kind: 'attachment.add',
            attachmentLocalId: 'issue-media',
            value: {
              key: 'issue-media:EXT-42',
              value: { issueId: 'EXT-42' },
              presentation: {
                label: 'Image evidence for Issue EXT-42',
                description: 'Portable external issue evidence selected through the Composer media picker.',
                icon: 'preview',
                tone: 'info',
              },
            },
            content: { kind: 'stagedMedia', handle: stagedMediaHandle },
          }],
          },
          signal: expect.any(AbortSignal),
        }));
      });
      expect(releaseComposerContent).not.toHaveBeenCalled();
      await expect(fixture.findByRole('status', {
        name: 'Attached image evidence for Issue EXT-42',
      })).resolves.toEqual({
        role: 'status',
        name: 'Attached image evidence for Issue EXT-42',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('does not treat author launch input as a mounted Composer carrier', async () => {
    const readComposer = vi.fn(async () => ({ status: 'ready' as const, snapshot: snapshot() }));
    const applyComposer = vi.fn(async () => ({ status: 'applied' as const, revision: 18 }));
    const fixture = await createPluginUiTestkit({
      identity: identity('picker-without-mounted-carrier'),
      surface: renderWithMountedComposer(null),
      surfaceContext: createSurfaceContextFixture(),
      launchInput: {
        v: 1,
        role: 'attachmentPicker',
        // The public render input can describe the mount, but it must not grant
        // author code a current Composer handle when the private carrier is absent.
        composer,
        attachmentLocalId: 'issue',
        instances: [],
      },
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { readComposer, applyComposer },
    });

    try {
      await fixture.press(await fixture.getByRole('option', { name: 'Attach Issue EXT-42' }));
      await expect(fixture.findByRole('status', {
        name: 'Issue attachment unavailable',
      })).resolves.toEqual({
        role: 'status',
        name: 'Issue attachment unavailable',
      });
      expect(readComposer).not.toHaveBeenCalled();
      expect(applyComposer).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('replaces the compact watch with the current mounted Composer carrier', async () => {
    const replacementComposer = {
      kind: 'session',
      sessionId: 'external-composer-replacement',
    } as const;
    let mountedComposer: ComposerSnapshotV1['ref'] | null = composer;
    const readComposer = vi.fn(async ({ ref }: { ref: ComposerSnapshotV1['ref'] }) => (
      ref.kind === 'session' && ref.sessionId === replacementComposer.sessionId
        ? { status: 'ready' as const, snapshot: snapshot([unavailableAttachment], replacementComposer) }
        : { status: 'ready' as const, snapshot: snapshot([attachment], composer) }
    ));
    const watchComposer = vi.fn(async () => undefined);
    const fixture = await createPluginUiTestkit({
      identity: identity('compact-carrier-replacement'),
      surface: (context) => renderWithMountedComposer(mountedComposer)(context),
      surfaceContext: createSurfaceContextFixture(),
      launchInput: {
        v: 1,
        role: 'controlCompact',
        controlLocalId: 'issue-control',
        state: {},
      },
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { readComposer, watchComposer },
    });

    try {
      await expect(fixture.findByRole('status', { name: 'Issue EXT-42' })).resolves.toEqual({
        role: 'status',
        name: 'Issue EXT-42',
      });

      mountedComposer = replacementComposer;
      await act(async () => {
        await fixture.updateSurface(createSurfaceContextFixture());
      });

      await expect(fixture.findByRole('status', { name: 'Issue EXT-84' })).resolves.toEqual({
        role: 'status',
        name: 'Issue EXT-84',
      });
      expect(readComposer).toHaveBeenCalledWith(expect.objectContaining({
        ref: composer,
        signal: expect.any(AbortSignal),
      }));
      expect(readComposer).toHaveBeenCalledWith(expect.objectContaining({
        ref: replacementComposer,
        signal: expect.any(AbortSignal),
      }));
      expect(watchComposer).toHaveBeenCalledWith(expect.objectContaining({
        ref: replacementComposer,
        signal: expect.any(AbortSignal),
      }));
    } finally {
      await fixture.dispose();
    }
  });

  it('retires stale picker UI and remounts display and preview from unchanged persisted identity', async () => {
    const picker = await createPluginUiTestkit({
      identity: identity('picker-generation-before-update'),
      surface: renderWithMountedComposer(composer),
      surfaceContext: createSurfaceContextFixture(),
      launchInput: {
        v: 1,
        role: 'attachmentPicker',
        attachmentLocalId: 'issue',
        instances: [attachment],
      },
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        readComposer: async () => ({ status: 'ready' as const, snapshot: snapshot() }),
        applyComposer: async () => ({ status: 'applied' as const, revision: 18 }),
      },
    });
    const staleChoice = await picker.getByRole('option', { name: 'Attach Issue EXT-84' });
    await picker.retire('plugin update');
    await expect(picker.press(staleChoice)).rejects.toMatchObject({ code: 'stale_surface' });

    const display = await createPluginUiTestkit({
      identity: identity('display-generation-after-reinstall'),
      surface: renderComposerIssueSurface,
      surfaceContext: createSurfaceContextFixture(),
      launchInput: {
        v: 1,
        role: 'attachmentDisplay',
        composer,
        attachmentLocalId: 'issue',
        instance: attachment,
      },
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
    const preview = await createPluginUiTestkit({
      identity: identity('preview-generation-after-reinstall'),
      surface: renderComposerIssueSurface,
      surfaceContext: createSurfaceContextFixture(),
      launchInput: {
        v: 1,
        role: 'attachmentPreview',
        composer,
        attachmentLocalId: 'issue',
        instance: attachment,
      },
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });

    try {
      await expect(display.getByText('Issue EXT-42')).resolves.toEqual({ content: 'Issue EXT-42' });
      await expect(display.getByRole('status', { name: 'Issue ready' })).resolves.toEqual({
        role: 'status',
        name: 'Issue ready',
      });
      await expect(preview.getByText('External issue selected from the Composer picker.')).resolves.toEqual({
        content: 'External issue selected from the Composer picker.',
      });
      expect(attachment).toMatchObject({
        attachment: { pluginId: 'acme.composer.issue-dogfood', localId: 'issue' },
        key: 'issue:EXT-42',
        presentation: { typeLabel: 'Issue', label: 'Issue EXT-42' },
      });
    } finally {
      await Promise.all([display.dispose(), preview.dispose()]);
    }
  });
});
