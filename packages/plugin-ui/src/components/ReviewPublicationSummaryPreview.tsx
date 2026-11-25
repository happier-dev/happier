import type { ReactElement } from 'react';
import type { ReviewPublicationSummaryPartsV1 } from '@happier-dev/plugin-sdk/reviews';

import { Markdown } from './Content.js';
import { CountedDisclosureItem } from './CountedDisclosureItem.js';
import { Stack } from './Layout.js';

export function ReviewPublicationSummaryPreview({ parts, testID }: Readonly<{
  parts: ReviewPublicationSummaryPartsV1;
  testID?: string;
}>): ReactElement {
  // Happier shows the short head (as every commit it names); the forge's post keeps the whole revision.
  const lead = [parts.headingMarkdown, `Head: ${parts.headRevision.slice(0, 7)}`, parts.bodyMarkdown].join('\n\n');
  return <Stack gap="small" testID={testID}>
    <Markdown value={lead} />
    {parts.walkthrough && <CountedDisclosureItem title={parts.walkthrough.title}>
      <Markdown value={parts.walkthrough.markdown} />
    </CountedDisclosureItem>}
    <Markdown value={parts.footerMarkdown} />
  </Stack>;
}
