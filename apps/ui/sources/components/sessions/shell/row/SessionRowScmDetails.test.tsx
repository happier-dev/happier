import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { SessionRowPullRequestChip } from './SessionRowScmDetails';

describe('SessionRowPullRequestChip', () => {
  afterEach(() => {
    standardCleanup();
  });

  it.each([
    ['draft', 'git-pull-request-draft'],
    ['open', 'git-pull-request'],
    ['merged', 'git-merge'],
  ] as const)(
    'draws a %s pull request with the %s glyph',
    async (state, glyph) => {
      const screen = await renderScreen(
        <SessionRowPullRequestChip
          testID="pr"
          pullRequest={{ number: 2490, state, checks: null }}
        />,
      );
      const glyphs = [
        'git-pull-request-draft',
        'git-pull-request',
        'git-merge',
      ].filter(
        (name) => screen.findAll((node) => node.props.name === name).length > 0,
      );
      expect(glyphs).toEqual([glyph]);
    },
  );
});
