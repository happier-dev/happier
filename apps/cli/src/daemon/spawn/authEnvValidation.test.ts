import { describe, expect, it } from 'vitest';

import {
  buildAuthEnvUnexpandedErrorMessage,
  findUnexpandedAuthEnvironmentReferences,
} from './authEnvValidation';

describe('findUnexpandedAuthEnvironmentReferences', () => {
  it('returns no findings when auth env vars are fully expanded', () => {
    const findings = findUnexpandedAuthEnvironmentReferences({
      OPENAI_API_KEY: 'sk-123',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-123',
    }, ['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

    expect(findings).toEqual([]);
  });

  it('returns readable findings for unexpanded auth references', () => {
    const findings = findUnexpandedAuthEnvironmentReferences({
      OPENAI_API_KEY: '${OPENAI_KEY}',
      ANTHROPIC_AUTH_TOKEN: '${ANTHROPIC_TOKEN:-fallback}',
      CODEX_HOME: '/tmp/codex-home',
    }, ['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

    expect(findings).toEqual([
      'ANTHROPIC_AUTH_TOKEN references ${ANTHROPIC_TOKEN} which is not defined',
      'OPENAI_API_KEY references ${OPENAI_KEY} which is not defined',
    ]);
  });

  it('falls back to unknown variable name when match extraction fails', () => {
    const findings = findUnexpandedAuthEnvironmentReferences({
      OPENAI_API_KEY: '${',
    }, ['OPENAI_API_KEY']);

    expect(findings).toEqual(['OPENAI_API_KEY references ${unknown} which is not defined']);
  });

  it('checks only the selected Agent credential keys supplied by its registry projection', () => {
    const env = {
      ANTHROPIC_API_KEY: '${CLAUDE_SECRET}',
      CODEX_API_KEY: '${CODEX_SECRET}',
      ACME_API_KEY: '${ACME_SECRET}',
    };

    expect(findUnexpandedAuthEnvironmentReferences(env, [
      'ANTHROPIC_API_KEY',
      'ACME_API_KEY',
    ])).toEqual([
      'ACME_API_KEY references ${ACME_SECRET} which is not defined',
      'ANTHROPIC_API_KEY references ${CLAUDE_SECRET} which is not defined',
    ]);
  });
});

describe('buildAuthEnvUnexpandedErrorMessage', () => {
  it('formats a stable user-facing error message', () => {
    const message = buildAuthEnvUnexpandedErrorMessage([
      'OPENAI_API_KEY references ${OPENAI_KEY} which is not defined',
      'ANTHROPIC_AUTH_TOKEN references ${ANTHROPIC_TOKEN} which is not defined',
    ]);

    expect(message).toContain('Authentication will fail');
    expect(message).toContain('OPENAI_API_KEY references ${OPENAI_KEY} which is not defined');
    expect(message).toContain('ANTHROPIC_AUTH_TOKEN references ${ANTHROPIC_TOKEN} which is not defined');
    expect(message).toContain("daemon's environment");
  });
});
