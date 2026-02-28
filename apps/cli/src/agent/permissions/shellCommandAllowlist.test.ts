import { describe, it, expect } from 'vitest';

import { isShellCommandAllowed, splitShellCommandTopLevel } from './shellCommandAllowlist';

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

  it('treats simple leading unset segments as an ignorable prelude for command-name allow rules', () => {
    const patterns = [{ kind: 'prefix' as const, value: 'pwd' }];
    expect(
      isShellCommandAllowed(
        'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_OAUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_SETUP_TOKEN; pwd',
        patterns,
      ),
    ).toBe(true);
  });

  it('does not allow extra segments when only the main command is allowed', () => {
    const patterns = [{ kind: 'prefix' as const, value: 'pwd' }];
    expect(
      isShellCommandAllowed(
        'unset ANTHROPIC_API_KEY; pwd && rm -rf /',
        patterns,
      ),
    ).toBe(false);
  });

  it('allows safe pipe filters after an allowed command-name segment', () => {
    const patterns = [{ kind: 'prefix' as const, value: 'find' }];
    expect(
      isShellCommandAllowed(
        'find . -maxdepth 2 -type f | head -n 5',
        patterns,
      ),
    ).toBe(true);
  });

  it('does not treat safe filter commands as allowed when chained with &&', () => {
    const patterns = [{ kind: 'prefix' as const, value: 'find' }];
    expect(
      isShellCommandAllowed(
        'find . -maxdepth 2 -type f && head -n 5 /etc/hosts',
        patterns,
      ),
    ).toBe(false);
  });
});
