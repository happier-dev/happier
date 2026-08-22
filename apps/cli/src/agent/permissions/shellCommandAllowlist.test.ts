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

  it('does not let unset preludes inherit command-name allow rules', () => {
    const patterns = [{ kind: 'prefix' as const, value: 'pwd' }];
    expect(
      isShellCommandAllowed(
        'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_OAUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_SETUP_TOKEN; pwd',
        patterns,
      ),
    ).toBe(false);
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

  it('requires every pipe segment to be explicitly allowed', () => {
    const patterns = [{ kind: 'prefix' as const, value: 'find' }];
    expect(
      isShellCommandAllowed(
        'find . -maxdepth 2 -type f | head -n 5',
        patterns,
      ),
    ).toBe(false);
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

  it.each([
    'git diff > ~/.zshrc',
    'git diff >> ~/.zshrc',
    'git diff < /tmp/input',
    'git diff | sort -o ~/.zshrc',
    'git diff | uniq /tmp/in ~/.zshrc',
    'GIT_EXTERNAL_DIFF=/tmp/evil git diff',
    'PATH=/tmp/evil git status',
  ])('does not let broad command-name grants cover shell side effects: %s', (command) => {
    expect(
      isShellCommandAllowed(command, [{ kind: 'prefix', value: 'git' }]),
    ).toBe(false);
  });

  it('does not collapse an env-prefixed stored pattern into a broader command grant', () => {
    expect(
      isShellCommandAllowed(
        'git status',
        [{ kind: 'prefix', value: 'PATH=/tmp/evil git' }],
      ),
    ).toBe(false);
  });

  it('preserves an explicit exact full-command approval', () => {
    const command = 'GIT_EXTERNAL_DIFF=/tmp/known git diff';
    expect(
      isShellCommandAllowed(command, [{ kind: 'exact', value: command }]),
    ).toBe(true);
  });
});
