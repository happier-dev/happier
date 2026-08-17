import { describe, expect, it } from 'vitest';

import { BACKGROUND_TASK_LABEL_MAX } from './backgroundTaskRecordV1.js';
import {
  BACKGROUND_TASK_LABEL_TRUNCATION_SUFFIX,
  redactBackgroundCommand,
} from './backgroundTaskRedaction.js';

/**
 * Stands in for the producer's injected home-path owner: `/Users/alice` collapses, and the
 * sibling-prefix guard means `/Users/alice2` must not.
 */
function collapseHome(absolutePath: string): string {
  if (absolutePath === '/Users/alice' || absolutePath.startsWith('/Users/alice/')) {
    return `~${absolutePath.slice('/Users/alice'.length)}`;
  }
  return absolutePath;
}

describe('background task command redaction', () => {
  it('collapses home paths through the injected owner and leaves a sibling prefix alone', () => {
    expect(redactBackgroundCommand({
      command: 'tail -f /Users/alice/logs/run.log',
      collapseAbsolutePath: collapseHome,
    })).toBe('tail -f ~/logs/run.log');
    expect(redactBackgroundCommand({
      command: 'tail -f /Users/alice2/logs/run.log',
      collapseAbsolutePath: collapseHome,
    })).toBe('tail -f /Users/alice2/logs/run.log');
  });

  it('removes a credential and keeps the surrounding command readable', () => {
    const redacted = redactBackgroundCommand({
      command: 'curl -H "api_key: sk-live-0123456789abcdef" https://example.test/build',
      collapseAbsolutePath: collapseHome,
    });
    expect(redacted).not.toContain('sk-live-0123456789abcdef');
    expect(redacted).toContain('curl');
  });

  it('removes an unnamed opaque token placed where a URL username goes', () => {
    // Deliberately not a shape `redactBugReportSensitiveText` names, so this exercises the label's
    // own high-entropy rule. The `//` belongs to the scheme, not to the payload: counting those
    // slashes toward the path exemption is what would let any credential after `://` through.
    const token = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWpr';
    const redacted = redactBackgroundCommand({
      command: `git clone https://${token}@github.test/acme/app.git`,
      collapseAbsolutePath: collapseHome,
    });
    expect(redacted).not.toContain(token);
    expect(redacted).toContain('git clone');
  });

  it('keeps a long path readable instead of blanking it as an opaque payload', () => {
    const redacted = redactBackgroundCommand({
      command: 'node /srv/apps/happier/services/worker/dist/entry-2026.js',
      collapseAbsolutePath: collapseHome,
    });
    expect(redacted).toContain('/srv/apps/happier/services/worker/dist/entry-2026.js');
  });

  it('scrubs before it truncates, so a straddling secret cannot survive as a head fragment', () => {
    const secret = `AKIA${'9'.repeat(60)}`;
    const redacted = redactBackgroundCommand({
      command: `${'echo padding '.repeat(8)}--token=${secret}`,
      collapseAbsolutePath: collapseHome,
    });
    expect(redacted.length).toBeLessThanOrEqual(BACKGROUND_TASK_LABEL_MAX);
    expect(redacted).not.toContain(secret.slice(0, 24));
  });

  it('truncates to the record bound and never emits a lone surrogate half', () => {
    const redacted = redactBackgroundCommand({
      command: `echo ${'🙂'.repeat(200)}`,
      collapseAbsolutePath: collapseHome,
    });
    expect(redacted.length).toBeLessThanOrEqual(BACKGROUND_TASK_LABEL_MAX);
    expect(redacted.endsWith(BACKGROUND_TASK_LABEL_TRUNCATION_SUFFIX)).toBe(true);
    expect(redacted).toBe(redacted.toWellFormed());
  });

  it('reports no label at all rather than a placeholder when there is no command', () => {
    expect(redactBackgroundCommand({ command: null, collapseAbsolutePath: collapseHome })).toBe('');
    expect(redactBackgroundCommand({ command: '   ', collapseAbsolutePath: collapseHome })).toBe('');
  });
});
