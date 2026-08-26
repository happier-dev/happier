import { describe, expect, it } from 'vitest';

import {
  projectPluginFailureMessage,
  projectPluginFailureText,
} from './failureProjection.js';

describe('projectPluginFailureMessage', () => {
  it('redacts credential, URL-userinfo, and absolute-path sentinels before a public result consumes them', () => {
    const tokenSentinel = 'protocol-plugin-failure-token-sentinel';
    const urlSentinel = 'protocol-plugin-failure-url-sentinel';
    const pathSentinel = 'protocol-plugin-failure-path-sentinel';
    const projected = projectPluginFailureMessage([
      `client_secret=${tokenSentinel}`,
      `https://alice:${urlSentinel}@example.test/v1?access_token=${tokenSentinel}`,
      `/Users/alice/${pathSentinel}/settings.json`,
      `C:\\Users\\alice\\${pathSentinel}\\settings.json`,
    ].join(' '));

    expect(projected).not.toContain(tokenSentinel);
    expect(projected).not.toContain(urlSentinel);
    expect(projected).not.toContain(pathSentinel);
    expect(projected).toContain('[REDACTED]');
    expect(projected).toContain('[REDACTED_PATH]');
  });

  it('admits only an Error message when projecting a thrown value', () => {
    expect(projectPluginFailureText({ message: 'not-an-error' }))
      .toBe('Plugin operation failed');
  });
});
