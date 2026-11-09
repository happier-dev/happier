import { describe, expect, it, vi } from 'vitest';
import { ComposerSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/composer';

import { saveTranscriptAnnotationNote } from './annotationEditor.js';

const source = { kind: 'session', session: { serverId: 'server-1', sessionId: 'session-1' }, messageId: 'source-1' };
const value = { quote: '  exact passage\n ', note: 'old note', source };
const snapshot = ComposerSnapshotV1Schema.parse({
  revision: 7, ref: { kind: 'session', sessionId: 'session-1' }, text: 'Existing draft',
  references: [], layout: 'wrap',
  attachments: [{ v: 1, instanceId: 'annotation-1',
    attachment: { pluginId: 'happier.app-context', localId: 'transcript-annotation' },
    key: 'annotation-1', value, presentation: { label: 'exact passage', typeLabel: 'Annotation' }, availability: { status: 'ready' } }],
  capabilities: { text: true, attachments: true, references: true, submit: true },
  state: { focused: true, editable: true, submittable: true, submitting: false, running: false },
});

describe('annotation note editor', () => {
  it('updates only the note and display facts against the current mounted composer revision', async () => {
    // The public handle is the genuine UI-to-host transport boundary.
    const apply = vi.fn(async () => ({ status: 'applied' as const, revision: 8 }));
    const handle = { read: async () => ({ status: 'ready' as const, snapshot }), apply };
    expect(await saveTranscriptAnnotationNote(handle, 'annotation-1', 'revised note')).toEqual({ status: 'applied', revision: 8 });
    expect(apply.mock.calls).toEqual([[{
      expectedRevision: 7,
      operations: [{ kind: 'attachment.update', instanceId: 'annotation-1', update: {
        value: { ...value, note: 'revised note' },
        presentation: { label: 'exact passage', description: 'revised note', source },
      } }],
    }, undefined]]);
    expect(snapshot.text).toBe('Existing draft');
    expect(snapshot.attachments[0].value).toEqual(value);
  });

  it('preserves refusal and never rewrites another attachment or a noneditable draft', async () => {
    const apply = vi.fn(async () => ({ status: 'conflict' as const, currentRevision: 8 }));
    const handle = { read: async () => ({ status: 'ready' as const, snapshot }), apply };
    expect(await saveTranscriptAnnotationNote(handle, 'annotation-1', 'keep this note'))
      .toEqual({ status: 'conflict', currentRevision: 8 });
    expect(await saveTranscriptAnnotationNote(handle, 'missing', 'keep this note')).toEqual({ status: 'composerUnavailable' });
    expect(await saveTranscriptAnnotationNote({ ...handle,
      read: async () => ({ status: 'ready' as const, snapshot: { ...snapshot, state: { ...snapshot.state, editable: false } } }),
    }, 'annotation-1', 'keep this note')).toEqual({ status: 'notEditable' });
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
