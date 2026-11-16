import { describe, expect, it } from 'vitest';

import { cmd, fail, info, ok, warn } from '@happier-dev/cli-common/output';

import { bold, code, compactHomePath, glyph, muted, statusGlyph, subLineArrow, success, warning } from './styles';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';

describe('styles palette', () => {
  it('compacts resume paths against each interleaved Session home', async () => {
    const paths = await Promise.all(['first', 'second'].map(id => runAddedHostedSession({
      environment: { NODE_ENV: 'test', HOME: `/session-home/${id}` }, workingDirectory: `/session-home/${id}`, end: () => {},
    }, async () => {
      await Promise.resolve();
      return [compactHomePath(`/session-home/${id}/workspace`), compactHomePath(`/session-home/${id}-other/workspace`)];
    })));
    expect(paths).toEqual([['~/workspace', '/session-home/first-other/workspace'], ['~/workspace', '/session-home/second-other/workspace']]);
  });
  it('muted wraps text', () => {
    expect(muted('abc')).toContain('abc');
  });

  it('bold wraps text', () => {
    expect(bold('abc')).toContain('abc');
  });

  it('warning wraps text', () => {
    expect(warning('heads up')).toContain('heads up');
  });

  it('success wraps text', () => {
    expect(success('done')).toContain('done');
  });

  it('status glyph returns a ● character for every kind', () => {
    for (const kind of ['running', 'drifted', 'stopped'] as const) {
      expect(statusGlyph(kind)).toContain('●');
    }
  });

  it('sub-line arrow contains ↳', () => {
    expect(subLineArrow()).toContain('↳');
  });

  it('uses the same status glyphs and command style as the rest of the CLI', () => {
    expect(glyph.error()).toBe(fail());
    expect(glyph.action()).toBe(warn());
    expect(glyph.success()).toBe(ok());
    expect(glyph.info()).toBe(info());
    expect(code('happier doctor repair')).toBe(cmd('happier doctor repair'));
  });
});
