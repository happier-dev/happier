import { describe, expect, it } from 'vitest';

import { buildSessionFolderDragLocalSettingsPatch } from './sessionFoldersDrag';

describe('session folder drag e2e settings', () => {
  it('forces the persisted session list tab while preserving requested folder sort mode', () => {
    expect(buildSessionFolderDragLocalSettingsPatch({ folderSortMode: 'foldersFirst' })).toEqual({
      sessionListFolderSortModeV1: 'foldersFirst',
      sessionsListStorageTab: 'persisted',
    });
  });
});
