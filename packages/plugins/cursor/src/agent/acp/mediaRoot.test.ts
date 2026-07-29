import { describe, expect, it } from 'vitest';

import { resolveCursorGeneratedMediaRoot } from './mediaRoot.js';

describe('resolveCursorGeneratedMediaRoot', () => {
  it('uses Cursor’s normalized active-project assets root on POSIX', () => {
    expect(resolveCursorGeneratedMediaRoot({
      directory: '/Users/tester/Documents/My Project',
      env: { HOME: '/Users/tester' },
      platform: 'darwin',
    })).toBe('/Users/tester/.cursor/projects/Users-tester-Documents-My-Project/assets');
  });

  it('uses the effective Windows home and preserves Cursor’s drive punctuation normalization', () => {
    expect(resolveCursorGeneratedMediaRoot({
      directory: 'C:\\Users\\tester\\Documents\\My Project',
      env: { USERPROFILE: 'C:\\Users\\tester' },
      platform: 'win32',
    })).toBe('C:\\Users\\tester\\.cursor\\projects\\C--Users-tester-Documents-My-Project\\assets');
  });

  it('does not manufacture a root when neither environment nor platform home has one', () => {
    expect(resolveCursorGeneratedMediaRoot({
      directory: '/workspace/project',
      env: {},
      platform: 'linux',
      homedir: () => '',
    })).toBeNull();
  });
});
