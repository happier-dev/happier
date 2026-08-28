import { describe, expect, it } from 'vitest';

import { azurePagedInitialState, azurePagedReducer } from './panelState.js';

describe('Azure paged detail state', () => {
  it('surfaces a provider continuation that could not cross the Action envelope as stopped short', () => {
    const loading = azurePagedReducer(azurePagedInitialState<string>(), {
      kind: 'requestStarted',
      token: 1,
    });
    const settled = azurePagedReducer(loading, {
      kind: 'pageSettled',
      token: 1,
      page: {
        rows: ['retained'],
        omittedRowCount: 0,
        projectionTruncated: false,
        continuation: null,
        incomplete: 'continuationUnavailable',
      },
    });

    expect(settled).toMatchObject({
      kind: 'ready',
      rows: ['retained'],
      canLoadMore: false,
      incomplete: 'continuationUnavailable',
      projectionTruncated: false,
    });
  });
});
