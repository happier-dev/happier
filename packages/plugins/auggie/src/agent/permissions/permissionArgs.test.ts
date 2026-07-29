import { describe, expect, it } from 'vitest';

import {
  buildAuggiePermissionIntentArgs,
} from './permissionArgs.js';

describe('Auggie permission args', () => {
  it('consumes each canonical native permission intent without a second alias field', () => {
    expect(buildAuggiePermissionIntentArgs('default')).toContain('view:allow');
    expect(buildAuggiePermissionIntentArgs('read-only')).toContain('save-file:deny');
    expect(buildAuggiePermissionIntentArgs('safe-yolo')).toContain('save-file:allow');
    expect(buildAuggiePermissionIntentArgs('yolo')).toContain('web-search:allow');
    expect(buildAuggiePermissionIntentArgs('plan')).toContain('launch-process:deny');
    expect(buildAuggiePermissionIntentArgs(null)).toContain('view:allow');
  });
});
