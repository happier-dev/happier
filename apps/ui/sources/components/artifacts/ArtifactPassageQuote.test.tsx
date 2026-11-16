import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';

import { renderScreen } from '@/dev/testkit';
import { ArtifactPassageQuote } from './ArtifactPassageQuote';

const passage = {
  ref: { kind: 'artifact', artifactId: 'doc-1' },
  revision: { headerVersion: 1, bodyVersion: 1 },
  range: { start: 10, end: 22 },
  quote: 'twice a week',
} as unknown as DocPassageRefV1;

describe('ArtifactPassageQuote', () => {
  it('opens its Doc at the passage when pressed (owner 11-15 C7)', async () => {
    const onOpen = vi.fn();
    const screen = await renderScreen(
      <ArtifactPassageQuote testID="quote" passage={passage} onOpen={onOpen} />,
    );
    await screen.pressByTestIdAsync('quote');
    expect(onOpen).toHaveBeenCalledWith(passage);
  });

  it('stays a plain quote where nothing can open it', async () => {
    const screen = await renderScreen(
      <ArtifactPassageQuote testID="quote" passage={passage} />,
    );
    expect(screen.findHostByTestId('quote')?.props.accessibilityRole).not.toBe(
      'link',
    );
  });
});
