import { describe, expect, it } from 'vitest';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
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

  it('masks a Session launch secret only in that hosted Session, and a host-minted bearer in every Session', async () => {
    // Two Accounts' Sessions share one session host process with different environments.
    const ownerSecret = 'true';
    const bearer = 'host-minted-bearer-value';
    const releaseBearer = registerTranscriptSecret(bearer);
    let markOwnerRegistered = () => {};
    const ownerRegistered = new Promise<void>(resolve => { markOwnerRegistered = resolve; });
    let releaseOwner = () => {};
    try {
      const [owner, guest] = await Promise.all([
        runAddedHostedSession({ environment: { HAPPIER_TEST_ACCOUNT: 'owner' }, workingDirectory: '/tmp/owner', end: () => {} },
          async () => {
            releaseOwner = registerTranscriptSecret(ownerSecret);
            markOwnerRegistered();
            // The write happens later, from another async continuation of the same Session.
            await new Promise(resolve => setTimeout(resolve, 1));
            return redactTranscriptSecrets({ output: `owner says ${ownerSecret} ${bearer}` });
          }),
        runAddedHostedSession({ environment: { HAPPIER_TEST_ACCOUNT: 'guest' }, workingDirectory: '/tmp/guest', end: () => {} },
          async () => {
            await ownerRegistered;
            // The guest probes a candidate value; it must come back unchanged.
            return redactTranscriptSecrets({ output: `guest probes ${ownerSecret} ${bearer}` });
          }),
      ]);
      expect(owner).toEqual({ output: `owner says ${TRANSCRIPT_SECRET_REDACTED} ${TRANSCRIPT_SECRET_REDACTED}` });
      expect(guest).toEqual({ output: `guest probes ${ownerSecret} ${TRANSCRIPT_SECRET_REDACTED}` });
    } finally {
      releaseOwner();
      releaseBearer();
    }
  });
});
