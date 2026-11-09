import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SessionStoredImageThumbnail } from './SessionStoredImageThumbnail';

afterEach(() => standardCleanup());

const path = '.happier/uploads/artifacts/s1/capture/screen.png';
const media = [
  {
    id: 'capture',
    status: 'available' as const,
    name: 'the whole screen',
    path,
    mimeType: 'image/png',
    sizeBytes: 21_371,
    sha256: 'a'.repeat(64),
    width: 1280,
    height: 1024,
    category: 'tool-artifact' as const,
    role: 'output' as const,
  },
];

describe('SessionStoredImageThumbnail', () => {
  it("keeps a daemon picture's tile in place while its Machine record has not arrived yet", async () => {
    const screen = await renderScreen(
      <SessionStoredImageThumbnail
        sessionId="s1"
        serverId="home"
        machineId="machine-unknown"
        storage="daemon"
        media={media}
        mediaPreviewEnabled
        testID="capture"
      />,
    );
    // The card keeps the tile's place (inert, nothing read) so it does not reflow when the record lands.
    expect(screen.findByTestId(`capture-inline-image:${path}`)).not.toBeNull();
  });
});
