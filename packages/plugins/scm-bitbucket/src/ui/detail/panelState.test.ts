import { describe, expect, it } from 'vitest';

import {
  bitbucketPagedInitialState,
  bitbucketPagedReducer,
} from './panelState.js';

describe('Bitbucket paged detail state', () => {
  it('keeps fitting rows while exposing a continuation the Action envelope could not carry', () => {
    const loading = bitbucketPagedReducer(bitbucketPagedInitialState<string>(), {
      kind: 'requestStarted',
      token: 1,
    });
    const settled = bitbucketPagedReducer(loading, {
      kind: 'pageSettled',
      token: 1,
      page: {
        rows: ['visible row'],
        omittedRowCount: 0,
        projectionTruncated: false,
        continuation: null,
        incomplete: 'continuationUnavailable',
      },
    });

    expect(settled).toMatchObject({
      kind: 'ready',
      rows: ['visible row'],
      canLoadMore: false,
      continuation: null,
      incomplete: 'continuationUnavailable',
    });
  });

  it('keeps an ordinary continuation loadable without inventing incomplete evidence', () => {
    const loading = bitbucketPagedReducer(bitbucketPagedInitialState<string>(), {
      kind: 'requestStarted',
      token: 1,
    });
    const settled = bitbucketPagedReducer(loading, {
      kind: 'pageSettled',
      token: 1,
      page: {
        rows: ['visible row'],
        omittedRowCount: 0,
        projectionTruncated: false,
        continuation: 'provider-page-2',
        incomplete: null,
      },
    });

    expect(settled).toMatchObject({
      canLoadMore: true,
      continuation: 'provider-page-2',
      incomplete: null,
    });
  });
});
