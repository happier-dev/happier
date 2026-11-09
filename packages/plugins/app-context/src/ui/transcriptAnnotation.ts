import { createElement, useState } from 'react';
import { ComposerSurfaceInputV1Schema, type RenderContext } from '@happier-dev/plugin-sdk/ui';
import { ProtocolTranscriptAnnotationV1Schema } from '@happier-dev/plugin-sdk/protocol';
import {
  Button, Stack, Text, TextField, defineUiSurface,
  useComposer, useComposerView, usePluginTranslation,
} from '@happier-dev/plugin-ui';

import { saveTranscriptAnnotationNote } from './annotationEditor.js';

function AnnotationEditor({ instanceId, annotation, signal }: Readonly<{
  instanceId: string;
  annotation: ReturnType<typeof ProtocolTranscriptAnnotationV1Schema.parse>;
  signal: RenderContext['signal'];
}>) {
  const handle = useComposer().current();
  const view = useComposerView(handle);
  const text = usePluginTranslation();
  const [note, setNote] = useState(annotation.note);
  const [feedback, setFeedback] = useState<'saved' | 'refused' | null>(null);
  const snapshot = view.result?.status === 'ready' ? view.result.snapshot : null;
  const editable = snapshot?.state.editable === true;

  return createElement(Stack, { gap: 'medium', testID: 'transcript-annotation-editor' },
    createElement(Text, { value: annotation.quote, variant: 'body', tone: 'secondary', selectable: true,
      numberOfLines: 6, testID: 'transcript-annotation-quote' }),
    createElement(TextField, { label: text('plugins.appContext.annotation.note', 'Your note'), value: note,
      onChange: value => { setNote(value); setFeedback(null); }, multiline: true,
      testID: 'transcript-annotation-note' }),
    createElement(Button, { title: text('plugins.appContext.annotation.save', 'Save note'),
      disabled: !handle || !editable || note.trim().length === 0,
      testID: 'transcript-annotation-save',
      onPress: async () => {
        if (!handle) return;
        try {
          const result = await saveTranscriptAnnotationNote(handle, instanceId, note, { signal });
          setFeedback(result.status === 'applied' ? 'saved' : 'refused');
        } catch {
          setFeedback('refused');
        }
      },
    }),
    feedback === 'saved' ? createElement(Text, { value: text('plugins.appContext.annotation.saved', 'Note saved'), tone: 'secondary' })
      : feedback === 'refused' || (snapshot && !editable)
        ? createElement(Text, { value: text('plugins.appContext.annotation.refused', 'This note can’t be saved right now — it’s kept here. If you’re editing a queued message, finish that first.'), tone: 'warning' })
        : null,
  );
}

function TranscriptAnnotationSurface(context: RenderContext) {
  const launch = ComposerSurfaceInputV1Schema.safeParse(context.launchInput);
  if (!launch.success || launch.data.role !== 'attachmentPreview') {
    return createElement(Text, { valueKey: 'plugins.appContext.annotation.unavailable', fallback: 'This annotation is unavailable.' });
  }
  const annotation = ProtocolTranscriptAnnotationV1Schema.safeParse(launch.data.instance.value);
  if (!annotation.success) {
    return createElement(Text, { valueKey: 'plugins.appContext.annotation.unavailable', fallback: 'This annotation is unavailable.' });
  }
  return createElement(AnnotationEditor, { key: launch.data.instance.instanceId,
    instanceId: launch.data.instance.instanceId, annotation: annotation.data, signal: context.signal });
}

export const renderSurface = defineUiSurface(TranscriptAnnotationSurface);
