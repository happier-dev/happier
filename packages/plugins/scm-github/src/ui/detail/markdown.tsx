import * as React from 'react';
import { Action, Markdown, Stack, Text, usePluginTranslation, type MarkdownImageResolver } from '@happier-dev/plugin-ui';
import { projectGithubMarkdownForDisplay } from '../../triage/detail/markdown/projectGithubMarkdownForDisplay.js';
import { readGithubAbsoluteWebUrl } from '../../triage/locator.js';

/** One display path for provider-authored descriptions, remarks and advisories. */
export function GithubOverviewMarkdown({ body }: Readonly<{ body: string | null | undefined }>) {
  const text = usePluginTranslation();
  const [remoteLoaded, setRemoteLoaded] = React.useState(false);
  const images = React.useMemo<MarkdownImageResolver>(() => ({
    resolve(destination) {
      const url = readGithubAbsoluteWebUrl(destination);
      return url === null ? { kind: 'blocked' } : { kind: 'remote', url };
    },
    remoteLoaded,
    onLoadRemote: () => { setRemoteLoaded(true); },
  }), [remoteLoaded]);
  const segments = React.useMemo(
    () => typeof body === 'string' && body.length > 0 ? projectGithubMarkdownForDisplay(body) : [],
    [body],
  );
  if (body === undefined) return <Text variant="micro" tone="neutral" value="Description unavailable" />;
  if (body === null || body.length === 0) return <Text variant="micro" tone="neutral" value="No description" />;
  return (
    <Stack gap="small">
      {segments.map((segment, index) => segment.kind === 'markdown'
        ? <Markdown key={`markdown:${index}`} value={segment.value} images={images} />
        : (
          <Stack key={`attachment:${index}:${segment.url}`} gap="xsmall">
            <Text variant="micro" tone="secondary" value={segment.media === 'video' ? 'Video attachment' : 'Attachment'} />
            <Action.OpenExternal url={segment.url}
              title={segment.media === 'video'
                ? text('plugins.github.ui.overview.openVideo', 'Open video')
                : text('plugins.github.ui.overview.openAttachment', 'Open attachment')}
              accessibilityLabel={segment.media === 'video'
                ? text('plugins.github.ui.overview.openVideoAttachment', 'Open video attachment')
                : text('plugins.github.ui.overview.openAttachment', 'Open attachment')} />
          </Stack>
        ))}
    </Stack>
  );
}
