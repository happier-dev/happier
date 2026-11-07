import * as React from 'react';
import { ContentPreview, Stack, usePluginTranslation } from '@happier-dev/plugin-ui';

/** How much of a long text the preview shows before "Read more": a few paragraphs of reading text. */
const PREVIEW_LINES = 9;

/**
 * A long provider text (a pull request description, a bot's comment) previewed at a bounded height, opened
 * whole on request. It keeps the story's later steps and the timeline's later events in view (lab: the ask,
 * What changed and the checks all in the first screen). A text that fits is shown whole with nothing to open.
 * The shared `ContentPreview` owns the clip, its disclosure and keyboard focus.
 */
export function TriageTextPreview({ children, testID }: Readonly<{ children: React.ReactNode; testID?: string }>): React.ReactElement {
  const text = usePluginTranslation();
  return (
    <ContentPreview
      lines={PREVIEW_LINES}
      showMoreLabel={text('plugins.triage.detailStory.showMore', 'Read more')}
      showLessLabel={text('plugins.triage.detailStory.showLess', 'Show less')}
      {...(testID === undefined ? {} : { testID })}
    >
      <Stack gap="large">{children}</Stack>
    </ContentPreview>
  );
}
