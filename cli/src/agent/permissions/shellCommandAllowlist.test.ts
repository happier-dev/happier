import { describe, it, expect } from 'vitest';

import { splitShellCommandTopLevel } from './shellCommandAllowlist';

describe('shellCommandAllowlist', () => {
  it('fails closed on process substitution', () => {
    expect(splitShellCommandTopLevel('echo <(whoami)').ok).toBe(false);
    expect(splitShellCommandTopLevel('echo >(whoami)').ok).toBe(false);
  });

  it('allows simple parameter expansion and still splits operators', () => {
    const res = splitShellCommandTopLevel('echo ${HOME} && echo ok');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.segments).toEqual(['echo ${HOME}', 'echo ok']);
  });
});

