import { describe, expect, it } from 'vitest';

import { buildHappySessionControlArgs } from './sessionSpawnArgs';

describe('buildHappySessionControlArgs', () => {
  it('includes permission mode flags when provided', () => {
    expect(buildHappySessionControlArgs({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 123,
    })).toEqual(['--permission-mode', 'safe-yolo', '--permission-mode-updated-at', '123']);
  });

  it('includes model flags when provided', () => {
    expect(buildHappySessionControlArgs({
      modelId: 'o3',
      modelUpdatedAt: 456,
    })).toEqual(['--model', 'o3', '--model-updated-at', '456']);
  });

  it('omits model flags when modelUpdatedAt is missing', () => {
    expect(buildHappySessionControlArgs({
      modelId: 'o3',
      modelUpdatedAt: undefined,
    })).toEqual([]);
  });

  it('omits model flags when modelId is empty', () => {
    expect(buildHappySessionControlArgs({
      modelId: '   ',
      modelUpdatedAt: 456,
    })).toEqual([]);
  });

  it('includes resume and existing-session flags when values are present', () => {
    expect(buildHappySessionControlArgs({
      resume: '  resume-id  ',
      existingSessionId: ' existing-session-id ',
    })).toEqual(['--resume', 'resume-id', '--existing-session', 'existing-session-id']);
  });

  it('includes permission mode without timestamp when updatedAt is absent', () => {
    expect(buildHappySessionControlArgs({
      permissionMode: 'safe',
    })).toEqual(['--permission-mode', 'safe']);
  });

  it('supports model timestamp boundary value zero', () => {
    expect(buildHappySessionControlArgs({
      modelId: 'o3',
      modelUpdatedAt: 0,
    })).toEqual(['--model', 'o3', '--model-updated-at', '0']);
  });
});
