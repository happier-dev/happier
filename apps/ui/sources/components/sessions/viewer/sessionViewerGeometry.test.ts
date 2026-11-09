import { describe, expect, it } from 'vitest';
import {
  resolveSessionViewerBodyAspect,
  SESSION_VIEWER_DEFAULT_ASPECT,
  SESSION_VIEWER_PERMISSION_MIN_BODY,
  SESSION_VIEWER_STATE_MIN_BODY,
} from './sessionViewerGeometry';

describe('resolveSessionViewerBodyAspect', () => {
  it('keeps the reported picture shape whatever the width', () => {
    expect(resolveSessionViewerBodyAspect(2, 358)).toBe(2);
  });

  it('gives a state card, which has no picture shape yet, the room it needs on a narrow frame', () => {
    const aspect = resolveSessionViewerBodyAspect(null, 358);
    expect(358 / aspect).toBeGreaterThanOrEqual(SESSION_VIEWER_STATE_MIN_BODY);
  });

  it('gives a taller state the room its source asked for, at the frame width', () => {
    const aspect = resolveSessionViewerBodyAspect(null, 432, SESSION_VIEWER_PERMISSION_MIN_BODY);
    expect(432 / aspect).toBeGreaterThanOrEqual(SESSION_VIEWER_PERMISSION_MIN_BODY);
  });

  it('keeps the default picture shape where it already holds a state card', () => {
    const width = Math.ceil(SESSION_VIEWER_STATE_MIN_BODY * SESSION_VIEWER_DEFAULT_ASPECT) + 40;
    expect(resolveSessionViewerBodyAspect(null, width)).toBe(SESSION_VIEWER_DEFAULT_ASPECT);
  });

  it('falls back to the default shape before the frame has a width', () => {
    expect(resolveSessionViewerBodyAspect(null, 0)).toBe(SESSION_VIEWER_DEFAULT_ASPECT);
  });
});
