import { describe, expect, it } from 'vitest';
import {
  redactTranscriptSecrets,
  registerTranscriptSecret,
  TRANSCRIPT_SECRET_REDACTED,
} from './transcriptSecretRedaction';

describe('transcript secret redaction', () => {
  it('redacts arbitrary Project secret values inside strings without touching the record structure', () => {
    // Person-chosen values are not base64url: quotes, backslashes and short tokens occur.
    const quoted = registerTranscriptSecret('p@ss"wo\\rd');
    const short = registerTranscriptSecret('1');
    try {
      const content = {
        seq: 1,
        ok: true,
        output: 'token=p@ss"wo\\rd v1 control',
        parts: ['x1y', 2],
      };
      expect(redactTranscriptSecrets(content)).toEqual({
        seq: 1,
        ok: true,
        output: `token=${TRANSCRIPT_SECRET_REDACTED} v${TRANSCRIPT_SECRET_REDACTED} control`,
        parts: [`x${TRANSCRIPT_SECRET_REDACTED}y`, 2],
      });
    } finally {
      quoted();
      short();
    }
  });

  it('keeps a value redacted until every launch that registered it is released', () => {
    const first = registerTranscriptSecret('shared-project-value');
    const second = registerTranscriptSecret('shared-project-value');
    first();
    expect(redactTranscriptSecrets('echo shared-project-value')).toBe(
      `echo ${TRANSCRIPT_SECRET_REDACTED}`,
    );
    second();
    expect(redactTranscriptSecrets('echo shared-project-value')).toBe(
      'echo shared-project-value',
    );
  });
});
